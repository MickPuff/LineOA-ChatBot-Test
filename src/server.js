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
import {
  createConversationStore,
  getConversationId,
  summarizeConversation,
} from './conversationStore.js';
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
});
const adminEventClients = new Set();

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

app.get(/^\/admin\/?$/, requireAdmin, (_req, res) => {
  res.sendFile(path.join(adminPublicPath, 'index.html'));
});

app.get(['/admin/inbox', '/admin/settings'], requireAdmin, (_req, res) => {
  res.sendFile(path.join(adminPublicPath, 'index.html'));
});

app.use('/admin', requireAdmin, express.static(adminPublicPath, {
  index: false,
  redirect: false,
}));

app.get('/api/admin/events', requireAdmin, (req, res) => {
  res.set({
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 5000\n\n');

  const client = {
    id: crypto.randomUUID(),
    res,
  };
  const heartbeat = setInterval(() => {
    sendServerEvent(client, 'heartbeat', { at: new Date().toISOString() });
  }, 25000);

  adminEventClients.add(client);
  sendServerEvent(client, 'connected', { at: new Date().toISOString() });

  req.on('close', () => {
    clearInterval(heartbeat);
    adminEventClients.delete(client);
  });
});

app.use('/api/admin', requireAdmin, express.json({ limit: '32kb' }));

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

app.patch('/api/admin/conversations/:conversationId/settings', requireAdmin, async (req, res, next) => {
  try {
    const conversationId = req.params.conversationId;
    const aiEnabled = req.body?.aiEnabled;

    if (typeof aiEnabled !== 'boolean') {
      res.status(400).json({ ok: false, error: 'aiEnabled must be true or false.' });
      return;
    }

    const settings = await conversationStore.updateConversationSettings(conversationId, {
      aiEnabled,
    });

    broadcastAdminEvent('conversation-settings-updated', {
      conversationId,
      settings,
      at: new Date().toISOString(),
    });

    res.json({ ok: true, conversationId, settings });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/conversations/:conversationId/messages', requireAdmin, async (req, res, next) => {
  try {
    const conversationId = req.params.conversationId;
    const text = String(req.body?.text || '').trim();

    if (!text) {
      res.status(400).json({ ok: false, error: 'Message text is required.' });
      return;
    }

    if (!isPushableLineConversation(conversationId)) {
      res.status(400).json({
        ok: false,
        error: 'Admin replies are only supported for LINE user, group, or room conversations.',
      });
      return;
    }

    const to = getLineRecipient(conversationId);
    const message = {
      role: 'assistant',
      text,
      at: new Date().toISOString(),
      from: 'admin',
    };

    await lineClient.pushMessage({
      to,
      messages: [{ type: 'text', text: truncateLineText(text) }],
    });
    const history = await conversationStore.append(conversationId, message);
    const settings = await conversationStore.getConversationSettings(conversationId);
    const conversation = summarizeConversation(conversationId, history, settings);

    broadcastAdminEvent('conversation-updated', {
      conversation,
      message,
      source: 'admin',
    });

    res.json({ ok: true, conversationId, conversation, message });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/settings', requireAdmin, async (_req, res, next) => {
  try {
    const botSettings = await getEffectiveBotSettings();

    res.json({
      ok: true,
      geminiModel: config.geminiModel,
      storageProvider: config.storageProvider,
      maxContextMessages: config.maxContextMessages,
      processedEventTtlSeconds: config.processedEventTtlSeconds,
      systemInstruction: botSettings.systemInstruction,
      defaultSystemInstruction: config.defaultBotSystemInstruction,
    });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/admin/settings', requireAdmin, async (req, res, next) => {
  try {
    const systemInstruction = String(req.body?.systemInstruction || '').trim();

    if (!systemInstruction) {
      res.status(400).json({ ok: false, error: 'System prompt is required.' });
      return;
    }

    if (systemInstruction.length > 4000) {
      res.status(400).json({ ok: false, error: 'System prompt must be 4000 characters or fewer.' });
      return;
    }

    const settings = await conversationStore.updateBotSettings({ systemInstruction });

    broadcastAdminEvent('settings-updated', {
      settings,
      at: new Date().toISOString(),
    });

    res.json({
      ok: true,
      settings,
    });
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
    broadcastAdminEvent('conversation-cleared', {
      conversationId,
      at: new Date().toISOString(),
    });
    await replyToLine(event.replyToken, 'Done. I cleared our conversation context.');
    console.log(`Reset conversation context: conversation=${conversationId}`);
    return;
  }

  const history = await conversationStore.getRecentHistory(conversationId);

  const userMessage = {
    role: 'user',
    text: userText,
    at: new Date().toISOString(),
  };
  const historyWithUserMessage = await conversationStore.append(conversationId, userMessage);

  const conversationSettings = await conversationStore.getConversationSettings(conversationId);
  broadcastAdminEvent('conversation-updated', {
    conversation: summarizeConversation(
      conversationId,
      historyWithUserMessage,
      conversationSettings,
    ),
    message: userMessage,
    source: 'line',
  });

  if (!conversationSettings.aiEnabled) {
    console.log(`AI disabled for conversation: conversation=${conversationId}`);
    return;
  }

  const botSettings = await getEffectiveBotSettings();
  let assistantText;
  try {
    assistantText = await geminiChat.reply(
      history,
      userText,
      botSettings.systemInstruction,
    );
  } catch (error) {
    console.error('Gemini request failed:', error);
    assistantText = 'Sorry, I could not reach Gemini right now. Please try again in a moment.';
  }

  const assistantMessage = {
    role: 'assistant',
    text: assistantText,
    at: new Date().toISOString(),
  };
  const historyWithAssistantMessage = await conversationStore.append(
    conversationId,
    assistantMessage,
  );

  broadcastAdminEvent('conversation-updated', {
    conversation: summarizeConversation(
      conversationId,
      historyWithAssistantMessage,
      conversationSettings,
    ),
    message: assistantMessage,
    source: 'ai',
  });

  await replyToLine(event.replyToken, assistantText);
  console.log(`Replied to LINE: conversation=${conversationId}, chars=${assistantText.length}`);
}

function isResetCommand(text) {
  return ['/reset', 'reset', 'clear', '/clear'].includes(text.toLowerCase());
}

function getLineRecipient(conversationId) {
  const separatorIndex = conversationId.indexOf(':');
  const type = separatorIndex >= 0 ? conversationId.slice(0, separatorIndex) : '';
  const id = separatorIndex >= 0 ? conversationId.slice(separatorIndex + 1) : '';

  if (['user', 'group', 'room'].includes(type) && id) {
    return id;
  }

  throw new Error('Admin replies are only supported for LINE user, group, or room conversations.');
}

function isPushableLineConversation(conversationId) {
  return ['user:', 'group:', 'room:'].some((prefix) => conversationId.startsWith(prefix));
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

async function getEffectiveBotSettings() {
  const settings = await conversationStore.getBotSettings();

  return {
    systemInstruction: settings.systemInstruction || config.defaultBotSystemInstruction,
  };
}

function truncateLineText(text) {
  return text.length > 4900 ? `${text.slice(0, 4890)}\n...` : text;
}

function broadcastAdminEvent(event, payload) {
  for (const client of adminEventClients) {
    sendServerEvent(client, event, payload);
  }
}

function sendServerEvent(client, event, payload) {
  try {
    client.res.write(`event: ${event}\n`);
    client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (error) {
    console.warn(`Failed to send admin SSE event: client=${client.id}`, error);
    adminEventClients.delete(client);
  }
}

app.listen(config.port, () => {
  console.log(`LINE Gemini bot listening on http://localhost:${config.port}`);
  console.log(`Webhook path: /webhook`);
});
