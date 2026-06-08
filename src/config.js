import 'dotenv/config';

const requiredEnv = [
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
  'GEMINI_API_KEY',
];

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
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    maxContextMessages: Number(process.env.MAX_CONTEXT_MESSAGES || process.env.MAX_HISTORY_MESSAGES || 24),
    storageProvider,
    upstashRedisRestUrl: process.env.UPSTASH_REDIS_REST_URL,
    upstashRedisRestToken: process.env.UPSTASH_REDIS_REST_TOKEN,
    botSystemInstruction:
      process.env.BOT_SYSTEM_INSTRUCTION ||
      'You are a friendly, concise assistant chatting inside LINE. Remember useful details from the conversation and answer naturally.',
  };
}
