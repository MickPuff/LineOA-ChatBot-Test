import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JSONParseError,
  LineBotClient,
  SignatureValidationFailed,
  middleware,
} from '@line/bot-sdk';
import { getConfig } from './config.js';
import { createConversationStore, getConversationId } from './conversationStore.js';
import { GeminiChat } from './geminiChat.js';

const config = getConfig();
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminPublicPath = path.join(__dirname, '..', 'public', 'admin');
const lineConfig = { channelSecret: config.lineChannelSecret };
const lineClient = LineBotClient.fromChannelAccessToken({
  channelAccessToken: config.lineChannelAccessToken,
});
const conversationStore = createConversationStore(config);
const geminiChat = new GeminiChat({
  apiKey: config.geminiApiKey,
  model: config.geminiModel,
  systemInstruction: config.botSystemInstruction,
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/debug/config', (_req, res) => {
  res.json({
    ok: true,
    storageProvider: config.storageProvider,
    geminiModel: config.geminiModel,
    hasLineChannelAccessToken: Boolean(config.lineChannelAccessToken),
    hasLineChannelSecret: Boolean(config.lineChannelSecret),
    hasGeminiApiKey: Boolean(config.geminiApiKey),
    hasUpstashRedisRestUrl: Boolean(config.upstashRedisRestUrl),
    hasUpstashRedisRestToken: Boolean(config.upstashRedisRestToken),
    maxContextMessages: config.maxContextMessages,
    processedEventTtlSeconds: config.processedEventTtlSeconds,
    adminEnabled: Boolean(config.adminPassword),
  });
});

app.get('/admin', requireAdmin, (_req, res) => {
  res.redirect('/admin/');
});

app.use('/admin', requireAdmin, express.static(adminPublicPath));

app.get('/api/admin/conversations', requireAdmin, async (_req, res, next) => {
  try {
    const conversations = await conversationStore.listConversations();
    const totals = conversations.reduce(
      (summary, conversation) => ({
        conversations: summary.conversations + 1,
        messages: summary.messages + conversation.messageCount,
        userMessages: summary.userMessages + conversation.userMessageCount,
        assistantMessages: summary.assistantMessages + conversation.assistantMessageCount,
      }),
      { conversations: 0, messages: 0, userMessages: 0, assistantMessages: 0 },
    );

    res.json({ ok: true, totals, conversations });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/conversations/:conversationId', requireAdmin, async (req, res, next) => {
  try {
    const conversationId = req.params.conversationId;
    const history = await conversationStore.getHistory(conversationId);

    res.json({ ok: true, conversationId, messages: history });
  } catch (error) {
    next(error);
  }
});

app.post('/webhook', middleware(lineConfig), async (req, res, next) => {
  try {
    console.log(`LINE webhook received: ${req.body.events.length} event(s)`);
    await Promise.all(req.body.events.map(handleEvent));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, next) => {
  if (error instanceof SignatureValidationFailed) {
    res.status(401).json({ error: 'Invalid LINE signature.' });
    return;
  }

  if (error instanceof JSONParseError) {
    res.status(400).json({ error: 'Invalid JSON webhook body.' });
    return;
  }

  next(error);
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error.' });
});

async function handleEvent(event) {
  const hasReplyToken = typeof event.replyToken === 'string' && event.replyToken.length > 0;
  const webhookEventId = event.webhookEventId || 'none';
  const isRedelivery = Boolean(event.deliveryContext?.isRedelivery);
  console.log(
    `Handling LINE event: type=${event.type}, mode=${event.mode || 'unknown'}, source=${event.source?.type || 'unknown'}, replyToken=${hasReplyToken}, redelivery=${isRedelivery}, eventId=${webhookEventId}`,
  );

  if (event.type !== 'message' || event.message?.type !== 'text') {
    console.log(`Ignoring unsupported LINE event: type=${event.type}, messageType=${event.message?.type || 'none'}`);
    return;
  }

  if (!hasReplyToken) {
    console.warn('Skipping text message because LINE did not include a reply token.');
    return;
  }

  const didClaimEvent = await conversationStore.claimWebhookEvent(event.webhookEventId);

  if (!didClaimEvent) {
    console.warn(`Skipping duplicate LINE webhook event: eventId=${webhookEventId}`);
    return;
  }

  const userText = event.message.text.trim();
  const conversationId = getConversationId(event.source);
  console.log(`Handling text message: conversation=${conversationId}, chars=${userText.length}`);

  if (isResetCommand(userText)) {
    await conversationStore.clear(conversationId);
    await replyToLine(event.replyToken, 'Done. I cleared our conversation context.');
    console.log(`Reset conversation context: conversation=${conversationId}`);
    return;
  }

  const history = await conversationStore.getRecentHistory(conversationId);

  await conversationStore.append(conversationId, {
    role: 'user',
    text: userText,
    at: new Date().toISOString(),
  });

  let assistantText;
  try {
    assistantText = await geminiChat.reply(history, userText);
  } catch (error) {
    console.error('Gemini request failed:', error);
    assistantText = 'Sorry, I could not reach Gemini right now. Please try again in a moment.';
  }

  await conversationStore.append(conversationId, {
    role: 'assistant',
    text: assistantText,
    at: new Date().toISOString(),
  });

  await replyToLine(event.replyToken, assistantText);
  console.log(`Replied to LINE: conversation=${conversationId}, chars=${assistantText.length}`);
}

function isResetCommand(text) {
  return ['/reset', 'reset', 'clear', '/clear'].includes(text.toLowerCase());
}

function requireAdmin(req, res, next) {
  if (!config.adminPassword) {
    console.warn('Admin auth rejected: ADMIN_PASSWORD is not configured.');
    res.status(503).send('Admin interface is disabled. Set ADMIN_PASSWORD in Render to enable it.');
    return;
  }

  const authHeader = req.get('authorization') || '';
  const [scheme, encodedCredentials] = authHeader.split(' ');

  if (scheme?.toLowerCase() !== 'basic' || !encodedCredentials) {
    console.warn('Admin auth rejected: missing Basic Auth credentials.');
    requestAdminLogin(res);
    return;
  }

  const credentials = Buffer.from(encodedCredentials, 'base64').toString('utf8');
  const separatorIndex = credentials.indexOf(':');
  const username = separatorIndex >= 0 ? credentials.slice(0, separatorIndex) : '';
  const password = separatorIndex >= 0 ? credentials.slice(separatorIndex + 1) : '';

  if (
    timingSafeEqual(username, config.adminUsername) &&
    timingSafeEqual(password, config.adminPassword)
  ) {
    next();
    return;
  }

  console.warn(`Admin auth rejected: invalid credentials for username=${username || 'empty'}.`);
  requestAdminLogin(res);
}

function requestAdminLogin(res) {
  res.set('WWW-Authenticate', 'Basic realm="LINE Chat Admin", charset="UTF-8"');
  res.status(401).send('Authentication required.');
}

function timingSafeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual || '');
  const expectedBuffer = Buffer.from(expected || '');

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

async function replyToLine(replyToken, text) {
  await lineClient.replyMessage({
    replyToken,
    messages: [{ type: 'text', text: truncateLineText(text) }],
  });
}

function truncateLineText(text) {
  return text.length > 4900 ? `${text.slice(0, 4890)}\n...` : text;
}

app.listen(config.port, () => {
  console.log(`LINE Gemini bot listening on http://localhost:${config.port}`);
  console.log(`Webhook path: /webhook`);
});
