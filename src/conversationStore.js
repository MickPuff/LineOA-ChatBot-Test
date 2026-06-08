import { Redis } from '@upstash/redis';

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
    return nextHistory;
  }

  async clear(conversationId) {
    await this.redis.del(this.#key(conversationId));
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
    return `lineoa:conversation:${conversationId}`;
  }

  #eventKey(webhookEventId) {
    return `lineoa:webhook-event:${webhookEventId}`;
  }
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
