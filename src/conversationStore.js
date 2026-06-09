import { Redis } from '@upstash/redis';

const CONVERSATION_KEY_PREFIX = 'lineoa:conversation:';
const CONVERSATION_INDEX_KEY = 'lineoa:conversation-index';
const CONVERSATION_SETTINGS_KEY_PREFIX = 'lineoa:conversation-settings:';
const BOT_SETTINGS_KEY = 'lineoa:bot-settings';

export function createConversationStore(config) {
  if (config.storageProvider === 'memory') {
    return new MemoryConversationStore(config.maxContextMessages, config.processedEventTtlSeconds);
  }

  if (config.storageProvider === 'upstash') {
    return new UpstashConversationStore({
      url: config.upstashRedisRestUrl,
      token: config.upstashRedisRestToken,
      maxMessages: config.maxContextMessages,
      processedEventTtlSeconds: config.processedEventTtlSeconds,
    });
  }

  throw new Error(`Unsupported STORAGE_PROVIDER: ${config.storageProvider}`);
}

export class MemoryConversationStore {
  constructor(maxMessages = 24, processedEventTtlSeconds = 86400) {
    this.maxMessages = maxMessages;
    this.processedEventTtlSeconds = processedEventTtlSeconds;
    this.conversations = new Map();
    this.processedWebhookEvents = new Map();
    this.conversationSettings = new Map();
    this.botSettings = {};
  }

  async getHistory(conversationId) {
    return this.conversations.get(conversationId) || [];
  }

  async getRecentHistory(conversationId) {
    const history = await this.getHistory(conversationId);
    return history.slice(-this.maxMessages);
  }

  async append(conversationId, message) {
    const history = this.conversations.get(conversationId) || [];
    const nextHistory = [...history, message];
    this.conversations.set(conversationId, nextHistory);
    return nextHistory;
  }

  async clear(conversationId) {
    this.conversations.delete(conversationId);
  }

  async listConversations() {
    return Array.from(this.conversations.entries())
      .map(([conversationId, history]) =>
        summarizeConversation(
          conversationId,
          history,
          normalizeConversationSettings(this.conversationSettings.get(conversationId)),
        ),
      )
      .sort(sortConversationSummaries);
  }

  async getConversationSettings(conversationId) {
    return normalizeConversationSettings(this.conversationSettings.get(conversationId));
  }

  async updateConversationSettings(conversationId, settings) {
    const nextSettings = normalizeConversationSettings({
      ...this.conversationSettings.get(conversationId),
      ...settings,
    });

    this.conversationSettings.set(conversationId, nextSettings);
    return nextSettings;
  }

  async getBotSettings() {
    return normalizeBotSettings(this.botSettings);
  }

  async updateBotSettings(settings) {
    this.botSettings = normalizeBotSettings({
      ...this.botSettings,
      ...settings,
    });

    return this.botSettings;
  }

  async claimWebhookEvent(webhookEventId) {
    if (!webhookEventId) {
      return true;
    }

    const now = Date.now();
    const expiresAt = this.processedWebhookEvents.get(webhookEventId);

    if (expiresAt && expiresAt > now) {
      return false;
    }

    this.processedWebhookEvents.set(
      webhookEventId,
      now + this.processedEventTtlSeconds * 1000,
    );
    return true;
  }
}

export class UpstashConversationStore {
  constructor({ url, token, maxMessages = 24, processedEventTtlSeconds = 86400 }) {
    this.redis = new Redis({ url, token });
    this.maxMessages = maxMessages;
    this.processedEventTtlSeconds = processedEventTtlSeconds;
  }

  async getHistory(conversationId) {
    const stored = await this.redis.get(this.#key(conversationId));

    if (!stored) {
      return [];
    }

    return typeof stored === 'string' ? JSON.parse(stored) : stored;
  }

  async getRecentHistory(conversationId) {
    const history = await this.getHistory(conversationId);
    return history.slice(-this.maxMessages);
  }

  async append(conversationId, message) {
    const history = await this.getHistory(conversationId);
    const nextHistory = [...history, message];

    await this.redis.set(this.#key(conversationId), JSON.stringify(nextHistory));
    await this.redis.sadd(CONVERSATION_INDEX_KEY, conversationId);
    return nextHistory;
  }

  async clear(conversationId) {
    await this.redis.del(this.#key(conversationId));
    await this.redis.srem(CONVERSATION_INDEX_KEY, conversationId);
  }

  async listConversations() {
    const conversationIds = await this.#getConversationIds();
    const summaries = await Promise.all(
      conversationIds.map(async (conversationId) => {
        const [history, settings] = await Promise.all([
          this.getHistory(conversationId),
          this.getConversationSettings(conversationId),
        ]);

        return summarizeConversation(conversationId, history, settings);
      }),
    );

    return summaries.sort(sortConversationSummaries);
  }

  async getConversationSettings(conversationId) {
    const stored = await this.redis.get(this.#conversationSettingsKey(conversationId));
    return normalizeConversationSettings(stored);
  }

  async updateConversationSettings(conversationId, settings) {
    const currentSettings = await this.getConversationSettings(conversationId);
    const nextSettings = normalizeConversationSettings({
      ...currentSettings,
      ...settings,
    });

    await this.redis.set(
      this.#conversationSettingsKey(conversationId),
      JSON.stringify(nextSettings),
    );
    await this.redis.sadd(CONVERSATION_INDEX_KEY, conversationId);

    return nextSettings;
  }

  async getBotSettings() {
    const stored = await this.redis.get(BOT_SETTINGS_KEY);
    return normalizeBotSettings(stored);
  }

  async updateBotSettings(settings) {
    const currentSettings = await this.getBotSettings();
    const nextSettings = normalizeBotSettings({
      ...currentSettings,
      ...settings,
    });

    await this.redis.set(BOT_SETTINGS_KEY, JSON.stringify(nextSettings));
    return nextSettings;
  }

  async claimWebhookEvent(webhookEventId) {
    if (!webhookEventId) {
      return true;
    }

    const result = await this.redis.set(this.#eventKey(webhookEventId), '1', {
      nx: true,
      ex: this.processedEventTtlSeconds,
    });

    return result === 'OK' || result === true;
  }

  #key(conversationId) {
    return `${CONVERSATION_KEY_PREFIX}${conversationId}`;
  }

  #eventKey(webhookEventId) {
    return `lineoa:webhook-event:${webhookEventId}`;
  }

  #conversationSettingsKey(conversationId) {
    return `${CONVERSATION_SETTINGS_KEY_PREFIX}${conversationId}`;
  }

  async #getConversationIds() {
    const indexedIds = await this.redis.smembers(CONVERSATION_INDEX_KEY);
    const scannedIds = await this.#scanConversationIds();

    return Array.from(new Set([...indexedIds, ...scannedIds])).sort();
  }

  async #scanConversationIds() {
    const conversationIds = new Set();
    let cursor = '0';

    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, {
        match: `${CONVERSATION_KEY_PREFIX}*`,
        count: 100,
      });

      for (const key of keys) {
        if (key.startsWith(CONVERSATION_KEY_PREFIX)) {
          conversationIds.add(key.slice(CONVERSATION_KEY_PREFIX.length));
        }
      }

      cursor = String(nextCursor);
    } while (cursor !== '0');

    return Array.from(conversationIds);
  }
}

export function summarizeConversation(conversationId, history, settings = {}) {
  const messages = Array.isArray(history) ? history : [];
  const lastMessage = messages.at(-1);
  const firstMessage = messages[0];
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  const normalizedSettings = normalizeConversationSettings(settings);
  const channel = normalizedSettings.channel || getConversationChannel(conversationId);

  return {
    conversationId,
    channel,
    messageCount: messages.length,
    userMessageCount: messages.filter((message) => message.role === 'user').length,
    assistantMessageCount: messages.filter((message) => message.role === 'assistant').length,
    firstAt: firstMessage?.at || null,
    lastAt: lastMessage?.at || null,
    lastRole: lastMessage?.role || null,
    lastText: lastMessage?.text || '',
    title: normalizedSettings.displayName || latestUserMessage?.text || conversationId,
    aiEnabled: normalizedSettings.aiEnabled,
    tags: normalizedSettings.tags,
  };
}

function normalizeConversationSettings(settings) {
  const normalized = parseStoredObject(settings);

  return {
    aiEnabled: normalized.aiEnabled !== false,
    channel: normalizeChannel(normalized.channel),
    displayName:
      typeof normalized.displayName === 'string'
        ? normalized.displayName.trim().slice(0, 80)
        : '',
    tags: normalizeTags(normalized.tags),
  };
}

function normalizeBotSettings(settings) {
  const normalized = parseStoredObject(settings);
  const systemInstruction =
    typeof normalized.systemInstruction === 'string'
      ? normalized.systemInstruction.trim()
      : '';

  return {
    systemInstruction,
  };
}

function parseStoredObject(value) {
  if (!value) {
    return {};
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  return typeof value === 'object' ? value : {};
}

function sortConversationSummaries(left, right) {
  const leftTime = left.lastAt ? Date.parse(left.lastAt) : 0;
  const rightTime = right.lastAt ? Date.parse(right.lastAt) : 0;
  return rightTime - leftTime;
}

export function getConversationId(source = {}) {
  if (source.userId) {
    return `user:${source.userId}`;
  }

  if (source.groupId) {
    return `group:${source.groupId}`;
  }

  if (source.roomId) {
    return `room:${source.roomId}`;
  }

  return 'unknown';
}

export function getWebsiteConversationId(userId) {
  return `website:${normalizeWebsiteUserId(userId)}`;
}

export function getConversationChannel(conversationId = '') {
  if (conversationId.startsWith('website:')) {
    return 'website';
  }

  if (conversationId.startsWith('fb:') || conversationId.startsWith('messenger:')) {
    return 'fb';
  }

  if (
    conversationId.startsWith('user:') ||
    conversationId.startsWith('group:') ||
    conversationId.startsWith('room:')
  ) {
    return 'line';
  }

  return 'unknown';
}

function normalizeWebsiteUserId(userId) {
  const normalized = String(userId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  return normalized || 'anonymous';
}

function normalizeChannel(channel) {
  if (['line', 'website', 'fb'].includes(channel)) {
    return channel;
  }

  return '';
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }

  return Array.from(
    new Set(
      tags
        .map((tag) => String(tag || '').trim())
        .filter(Boolean)
        .map((tag) => tag.slice(0, 40)),
    ),
  ).slice(0, 12);
}
