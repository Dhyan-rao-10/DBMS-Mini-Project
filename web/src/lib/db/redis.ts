import "../env";
import Redis from "ioredis";

/** Redis: sessions, login rate limits, leaderboards, cached dashboard numbers (F5). */

const globalForRedis = globalThis as unknown as { redis?: Redis };

export function getRedis(): Redis {
  if (!globalForRedis.redis) {
    if (!process.env.REDIS_URL) throw new Error("REDIS_URL is not set");
    globalForRedis.redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  }
  return globalForRedis.redis;
}

export async function closeRedis(): Promise<void> {
  await globalForRedis.redis?.quit();
  globalForRedis.redis = undefined;
}
