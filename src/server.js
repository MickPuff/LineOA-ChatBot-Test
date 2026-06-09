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
  getConversationChannel,
  getConversationId,
  getWebsiteConversationId,
  summarizeConversation,
} from './conversationStore.js';
import { GeminiChat } from './geminiChat.js';

const config = getConfig();
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminPublicPath = path.join(__dirname, '..', 'public', 'admin');
const testUserPublicPath = path.join(__dirname, '..', 'public', 'testuser');
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
const testUserEventClients = new Map();

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

app.get(/^\/testuser\/?$/, (_req, res) => {
  res.sendFile(path.join(testUserPublicPath, 'index.html'));
});

app.use('/testuser', express.static(testUserPublicPath, {
  index: false,
  redirect: false,
}));

app.get('/api/testuser/events', (req, res) => {
  const conversationId = getWebsiteConversationId(req.query.userId);

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
    conversationId,
    res,
  };
  const heartbeat = setInterval(() => {
    sendServerEvent(client, 'heartbeat', { at: new Date().toISOString() });
  }, 25000);

  addTestUserEventClient(conversationId, client);
  sendServerEvent(client, 'connected', { conversationId, at: new Date().toISOString() });

  req.on('close', () => {
    clearInterval(heartbeat);
    removeTestUserEventClient(conversationId, client);
  });
});

app.use('/api/testuser', express.json({ limit: '32kb' }));

app.get('/api/testuser/messages', async (req, res, next) => {
  try {
    const conversationId = getWebsiteConversationId(req.query.userId);
    const history = await conversationStore.getHistory(conversationId);
    const settings = await ensureWebsiteConversationSettings(conversationId, {
      displayName: req.query.displayName,
    });

    res.json({
      ok: true,
      conversationId,
      settings,
      messages: history,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/testuser/messages', async (req, res, next) => {
  try {
    const userId = req.body?.userId;
    const displayName = req.body?.displayName;
    const text = String(req.body?.text || '').trim();

    if (!String(userId || '').trim()) {
      res.status(400).json({ ok: false, error: 'User ID is required.' });
      return;
    }

    if (!text) {
      res.status(400).json({ ok: false, error: 'Message text is required.' });
      return;
    }

    const conversationId = getWebsiteConversationId(userId);
    await ensureWebsiteConversationSettings(conversationId, { displayName });

    const result = await handleCustomerText({
      conversationId,
      userText: text,
      source: 'website',
      reply: null,
    });

    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
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
    const [history, settings] = await Promise.all([
      conversationStore.getHistory(conversationId),
      conversationStore.getConversationSettings(conversationId),
    ]);

    res.json({ ok: true, conversationId, settings, messages: history });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/admin/conversations/:conversationId/settings', requireAdmin, async (req, res, next) => {
  try {
    const conversationId = req.params.conversationId;
    const aiEnabled = req.body?.aiEnabled;
    const tags = req.body?.tags;
    const settingsPatch = {};

    if (aiEnabled !== undefined) {
      if (typeof aiEnabled !== 'boolean') {
        res.status(400).json({ ok: false, error: 'aiEnabled must be true or false.' });
        return;
      }

      settingsPatch.aiEnabled = aiEnabled;
    }

    if (tags !== undefined) {
      if (!Array.isArray(tags)) {
        res.status(400).json({ ok: false, error: 'tags must be an array.' });
        return;
      }

      settingsPatch.tags = tags;
    }

    if (Object.keys(settingsPatch).length === 0) {
      res.status(400).json({ ok: false, error: 'No supported settings were provided.' });
      return;
    }

    const settings = await conversationStore.updateConversationSettings(conversationId, settingsPatch);

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

    if (!isAdminReplySupportedConversation(conversationId)) {
      res.status(400).json({
        ok: false,
        error: 'Admin replies are supported for LINE and website conversations.',
      });
      return;
    }

    const message = {
      role: 'assistant',
      text,
      at: new Date().toISOString(),
      from: 'admin',
    };

    if (isPushableLineConversation(conversationId)) {
      await lineClient.pushMessage({
        to: getLineRecipient(conversationId),
        messages: [{ type: 'text', text: truncateLineText(text) }],
      });
    }

    const history = await conversationStore.append(conversationId, message);
    const settings = await conversationStore.getConversationSettings(conversationId);
    const conversation = summarizeConversation(conversationId, history, settings);

    broadcastAdminEvent('conversation-updated', {
      conversation,
      message,
      source: 'admin',
    });
    broadcastTestUserEvent(conversationId, 'message', {
      conversationId,
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

  await handleCustomerText({
    conversationId,
    userText,
    source: 'line',
    reply: (text) => replyToLine(event.replyToken, text),
  });
}

function isResetCommand(text) {
  return ['/reset', 'reset', 'clear', '/clear'].includes(text.toLowerCase());
}

async function handleCustomerText({ conversationId, userText, source, reply }) {
  if (isResetCommand(userText)) {
    await conversationStore.clear(conversationId);
    broadcastAdminEvent('conversation-cleared', {
      conversationId,
      at: new Date().toISOString(),
    });
    broadcastTestUserEvent(conversationId, 'conversation-cleared', {
      conversationId,
      at: new Date().toISOString(),
    });

    if (reply) {
      await reply('Done. I cleared our conversation context.');
    }

    console.log(`Reset conversation context: conversation=${conversationId}`);
    return {
      conversationId,
      messages: [],
      assistantMessage: null,
    };
  }

  const history = await conversationStore.getRecentHistory(conversationId);
  const userMessage = {
    role: 'user',
    text: userText,
    at: new Date().toISOString(),
    source,
  };
  const historyWithUserMessage = await conversationStore.append(conversationId, userMessage);
  const conversationSettings = await conversationStore.getConversationSettings(conversationId);

  broadcastConversationUpdate({
    conversationId,
    history: historyWithUserMessage,
    settings: conversationSettings,
    message: userMessage,
    source,
  });

  if (!conversationSettings.aiEnabled) {
    console.log(`AI disabled for conversation: conversation=${conversationId}`);
    return {
      conversationId,
      messages: historyWithUserMessage,
      assistantMessage: null,
    };
  }

  const botSettings = await getEffectiveBotSettings();
  let assistantText;
  let usage = null;

  try {
    const aiReply = await geminiChat.reply(
      history,
      userText,
      buildLlmSystemInstruction(
        botSettings.systemInstruction,
        conversationId,
        conversationSettings,
      ),
    );
    assistantText = aiReply.text;
    usage = aiReply.usage;
  } catch (error) {
    console.error('Gemini request failed:', error);
    assistantText = 'Sorry, I could not reach Gemini right now. Please try again in a moment.';
  }

  const assistantMessage = {
    role: 'assistant',
    text: assistantText,
    at: new Date().toISOString(),
    from: 'ai',
    ...(usage ? { usage } : {}),
  };
  const historyWithAssistantMessage = await conversationStore.append(
    conversationId,
    assistantMessage,
  );

  broadcastConversationUpdate({
    conversationId,
    history: historyWithAssistantMessage,
    settings: conversationSettings,
    message: assistantMessage,
    source: 'ai',
  });

  if (reply) {
    await reply(assistantText);
    console.log(`Replied to ${source}: conversation=${conversationId}, chars=${assistantText.length}`);
  }

  return {
    conversationId,
    messages: historyWithAssistantMessage,
    assistantMessage,
  };
}

function broadcastConversationUpdate({ conversationId, history, settings, message, source }) {
  const conversation = summarizeConversation(conversationId, history, settings);

  broadcastAdminEvent('conversation-updated', {
    conversation,
    message,
    source,
  });
  broadcastTestUserEvent(conversationId, 'message', {
    conversationId,
    message,
    source,
  });
}

async function ensureWebsiteConversationSettings(conversationId, { displayName } = {}) {
  const currentSettings = await conversationStore.getConversationSettings(conversationId);
  const patch = {
    channel: 'website',
  };
  const normalizedDisplayName = String(displayName || '').trim();

  if (normalizedDisplayName && currentSettings.displayName !== normalizedDisplayName) {
    patch.displayName = normalizedDisplayName;
  }

  if (currentSettings.channel !== 'website' || patch.displayName) {
    return conversationStore.updateConversationSettings(conversationId, patch);
  }

  return currentSettings;
}

function buildLlmSystemInstruction(systemInstruction, conversationId, settings) {
  const channel = settings.channel || getConversationChannel(conversationId);
  const lines = [
    systemInstruction,
    '',
    'Customer context:',
    `- Channel: ${formatChannel(channel)}`,
  ];

  if (settings.displayName) {
    lines.push(`- Display name: ${settings.displayName}`);
  }

  if (settings.tags?.length) {
    lines.push(`- Admin tags: ${settings.tags.join(', ')}`);
  } else {
    lines.push('- Admin tags: none');
  }

  lines.push('Use admin tags as customer context, not as text to quote back unless helpful.');

  return lines.join('\n');
}

function formatChannel(channel) {
  if (channel === 'line') {
    return 'LINE';
  }

  if (channel === 'website') {
    return 'Website';
  }

  if (channel === 'fb') {
    return 'FB Messenger';
  }

  return 'Unknown';
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
  return ['user:', 'group:', 'room:'].some((prefix) => conversationId?.startsWith(prefix));
}

function isWebsiteConversation(conversationId) {
  return conversationId?.startsWith('website:');
}

function isAdminReplySupportedConversation(conversationId) {
  return isPushableLineConversation(conversationId) || isWebsiteConversation(conversationId);
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

function broadcastTestUserEvent(conversationId, event, payload) {
  const clients = testUserEventClients.get(conversationId);

  if (!clients) {
    return;
  }

  for (const client of clients) {
    sendServerEvent(client, event, payload);
  }
}

function addTestUserEventClient(conversationId, client) {
  const clients = testUserEventClients.get(conversationId) || new Set();
  clients.add(client);
  testUserEventClients.set(conversationId, clients);
}

function removeTestUserEventClient(conversationId, client) {
  const clients = testUserEventClients.get(conversationId);

  if (!clients) {
    return;
  }

  clients.delete(client);

  if (clients.size === 0) {
    testUserEventClients.delete(conversationId);
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
