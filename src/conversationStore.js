import { Redis } from '@upstash/redis';

export function createConversationStore(config) {
  if (config.storageProvider === 'memory') {
    return new MemoryConversationStore(config.maxHistoryMessages);
  }

  if (config.storageProvider === 'upstash') {
    return new UpstashConversationStore({
      url: config.upstashRedisRestUrl,
      token: config.upstashRedisRestToken,
      maxMessages: config.maxHistoryMessages,
    });
  }

  throw new Error(`Unsupported STORAGE_PROVIDER: ${config.storageProvider}`);
}

export class MemoryConversationStore {
  constructor(maxMessages = 24) {
    this.maxMessages = maxMessages;
    this.conversations = new Map();
  }

  async getHistory(conversationId) {
    return this.conversations.get(conversationId) || [];
  }

  async append(conversationId, message) {
    const history = this.conversations.get(conversationId) || [];
    const nextHistory = [...history, message].slice(-this.maxMessages);
    this.conversations.set(conversationId, nextHistory);
    return nextHistory;
  }

  async clear(conversationId) {
    this.conversations.delete(conversationId);
  }
}

export class UpstashConversationStore {
  constructor({ url, token, maxMessages = 24 }) {
    this.redis = new Redis({ url, token });
    this.maxMessages = maxMessages;
  }

  async getHistory(conversationId) {
    const stored = await this.redis.get(this.#key(conversationId));

    if (!stored) {
      return [];
    }

    return typeof stored === 'string' ? JSON.parse(stored) : stored;
  }

  async append(conversationId, message) {
    const history = await this.getHistory(conversationId);
    const nextHistory = [...history, message].slice(-this.maxMessages);

    await this.redis.set(this.#key(conversationId), JSON.stringify(nextHistory));
    return nextHistory;
  }

  async clear(conversationId) {
    await this.redis.del(this.#key(conversationId));
  }

  #key(conversationId) {
    return `lineoa:conversation:${conversationId}`;
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
