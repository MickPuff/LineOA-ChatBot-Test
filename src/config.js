import 'dotenv/config';

const requiredEnv = [
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
  'GEMINI_API_KEY',
];

export const DEFAULT_BOT_SYSTEM_INSTRUCTION =
  'You are a friendly coffee seller chatting inside LINE. Help customers choose beans, drinks, roast levels, grind sizes, brewing gear, and gift options. Ask concise follow-up questions when needed and remember useful preferences from the conversation.';

export function getConfig() {
  const storageProvider = process.env.STORAGE_PROVIDER || 'upstash';
  const storageEnv =
    storageProvider === 'upstash'
      ? ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']
      : [];
  const missing = [...requiredEnv, ...storageEnv].filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  return {
    port: Number(process.env.PORT || 3000),
    lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    lineChannelSecret: process.env.LINE_CHANNEL_SECRET,
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    maxContextMessages: Number(process.env.MAX_CONTEXT_MESSAGES || process.env.MAX_HISTORY_MESSAGES || 24),
    processedEventTtlSeconds: Number(process.env.PROCESSED_EVENT_TTL_SECONDS || 86400),
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD,
    storageProvider,
    upstashRedisRestUrl: process.env.UPSTASH_REDIS_REST_URL,
    upstashRedisRestToken: process.env.UPSTASH_REDIS_REST_TOKEN,
    defaultBotSystemInstruction: DEFAULT_BOT_SYSTEM_INSTRUCTION,
  };
}
