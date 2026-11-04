import { randomBytes } from "node:crypto";
import { getRedis } from "../db/redis";
import { asReport } from "../db/pg";

/**
 * F5: Redis key-value layer (docs/05-nosql-vector-models.md §5.4).
 *
 *   session:{token}           HASH    user_id, role, contributor_id, name  TTL 8 h, sliding
 *   user_sessions:{user_id}   SET     that user's tokens (revoke all at once)
 *   ratelimit:login:{email}   STRING  failed attempts                    TTL 15 min
 *   lb:streams:{period_id}    ZSET    track_id -> streams
 *   lb:titles                 HASH    track_id -> title (for display)
 *   cache:{name}              STRING  JSON                               TTL given by caller
 */

export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const LOGIN_MAX_FAILURES = 5;

export interface Session {
  userId: number;
  role: "admin" | "staff" | "contributor";
  contributorId: number | null;
  name: string;
}

// ---------- sessions ----------

export async function createSession(s: Session): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const redis = getRedis();
  await redis
    .multi()
    .hset(`session:${token}`, {
      user_id: s.userId,
      role: s.role,
      contributor_id: s.contributorId ?? "",
      name: s.name,
      created_at: new Date().toISOString(),
    })
    .expire(`session:${token}`, SESSION_TTL_SECONDS)
    .sadd(`user_sessions:${s.userId}`, token)
    .expire(`user_sessions:${s.userId}`, SESSION_TTL_SECONDS)
    .exec();
  return token;
}

/** Returns the session and slides its expiry forward, or null if it expired / was revoked. */
export async function getSession(token: string): Promise<Session | null> {
  const redis = getRedis();
  const h = await redis.hgetall(`session:${token}`);
  if (!h.user_id) return null;
  await redis.expire(`session:${token}`, SESSION_TTL_SECONDS);
  return {
    userId: Number(h.user_id),
    role: h.role as Session["role"],
    contributorId: h.contributor_id ? Number(h.contributor_id) : null,
    name: h.name ?? "",
  };
}

export async function destroySession(token: string): Promise<void> {
  const redis = getRedis();
  const userId = await redis.hget(`session:${token}`, "user_id");
  await redis.del(`session:${token}`);
  if (userId) await redis.srem(`user_sessions:${userId}`, token);
}

/** Logs a user out everywhere, e.g. when an admin deactivates them. */
export async function destroyUserSessions(userId: number): Promise<number> {
  const redis = getRedis();
  const tokens = await redis.smembers(`user_sessions:${userId}`);
  if (tokens.length) await redis.del(...tokens.map((t) => `session:${t}`));
  await redis.del(`user_sessions:${userId}`);
  return tokens.length;
}

// ---------- login rate limiting ----------

const loginKey = (email: string) => `ratelimit:login:${email.trim().toLowerCase()}`;

/** Counts a failed login; the window starts at the first failure. Returns the count. */
export async function recordLoginFailure(email: string): Promise<number> {
  const redis = getRedis();
  const count = await redis.incr(loginKey(email));
  if (count === 1) await redis.expire(loginKey(email), LOGIN_WINDOW_SECONDS);
  return count;
}

export async function loginBlockedFor(email: string): Promise<number> {
  const redis = getRedis();
  const count = Number((await redis.get(loginKey(email))) ?? 0);
  return count >= LOGIN_MAX_FAILURES ? Math.max(await redis.ttl(loginKey(email)), 0) : 0;
}

export async function clearLoginFailures(email: string): Promise<void> {
  await getRedis().del(loginKey(email));
}

// ---------- leaderboard ----------

/** Rebuilds "top tracks" for one period from Postgres (call after a report load). */
export async function rebuildLeaderboard(periodId: number): Promise<number> {
  const { rows } = await asReport((c) =>
    c.query<{ track_id: number; title: string; streams: string }>(
      "SELECT track_id, title, streams FROM v_track_period_revenue WHERE period_id = $1",
      [periodId],
    ),
  );
  const redis = getRedis();
  const key = `lb:streams:${periodId}`;
  const tx = redis.multi().del(key);
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    tx.zadd(key, ...chunk.flatMap((r) => [r.streams, String(r.track_id)]));
    tx.hset("lb:titles", Object.fromEntries(chunk.map((r) => [String(r.track_id), r.title])));
  }
  await tx.exec();
  return rows.length;
}

export async function topTracks(periodId: number, n = 10): Promise<{ trackId: number; title: string; streams: number }[]> {
  const redis = getRedis();
  const flat = await redis.zrevrange(`lb:streams:${periodId}`, 0, n - 1, "WITHSCORES");
  const ids = flat.filter((_, i) => i % 2 === 0);
  const titles = ids.length ? await redis.hmget("lb:titles", ...ids) : [];
  return ids.map((id, i) => ({ trackId: Number(id), title: titles[i] ?? `#${id}`, streams: Number(flat[i * 2 + 1]) }));
}

// ---------- cache-aside ----------

export async function cached<T>(name: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
  const redis = getRedis();
  const hit = await redis.get(`cache:${name}`);
  if (hit !== null) return JSON.parse(hit) as T;
  const value = await compute();
  await redis.set(`cache:${name}`, JSON.stringify(value), "EX", ttlSeconds);
  return value;
}

export async function invalidate(...names: string[]): Promise<void> {
  if (names.length) await getRedis().del(...names.map((n) => `cache:${n}`));
}
