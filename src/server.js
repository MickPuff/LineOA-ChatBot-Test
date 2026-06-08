import express from 'express';
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
  });
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
