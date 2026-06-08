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

app.post('/webhook', middleware(lineConfig), async (req, res, next) => {
  try {
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
  if (event.type !== 'message' || event.message?.type !== 'text') {
    return;
  }

  const userText = event.message.text.trim();
  const conversationId = getConversationId(event.source);

  if (isResetCommand(userText)) {
    await conversationStore.clear(conversationId);
    await replyToLine(event.replyToken, 'Done. I cleared our conversation context.');
    return;
  }

  const history = await conversationStore.getHistory(conversationId);

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
