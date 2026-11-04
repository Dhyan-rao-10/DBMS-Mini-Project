import "../env";
import { Pool, types, type PoolClient } from "pg";

// Return DATE columns as 'YYYY-MM-DD' strings. By default pg makes a JS Date at
// local midnight, which shifts to the previous day when shown in UTC.
types.setTypeParser(types.builtins.DATE, (value: string) => value);

/**
 * PostgreSQL access.
 *
 * The app connects as `royalty_app`, which has no privileges of its own.
 * Every unit of work runs in a transaction that first switches to the
 * database role for the acting user (SET LOCAL ROLE) and records who is
 * acting (app.user_id, read by the audit triggers). The database, not
 * this code, decides what each kind of user may do.
 */

export type AppRole = "admin" | "staff" | "contributor" | "report" | "login";

export interface Actor {
  userId: number | null;
  role: AppRole;
}

const DB_ROLE: Record<AppRole, string> = {
  admin: "app_admin",
  staff: "app_staff",
  contributor: "app_contributor",
  report: "app_report",
  login: "app_login",
};

// survive hot reloads in `next dev` without opening a new pool each time
const globalForPg = globalThis as unknown as { pgPool?: Pool };

export function getPool(): Pool {
  if (!globalForPg.pgPool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    globalForPg.pgPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  }
  return globalForPg.pgPool;
}

/** Runs `fn` in one transaction as `actor`; commits on success, rolls back on any error. */
export async function withTx<T>(actor: Actor, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${DB_ROLE[actor.role]}`);
    await client.query("SELECT set_config('app.user_id', $1, true)", [
      actor.userId === null ? "" : String(actor.userId),
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Like withTx, but always rolls back: for "what-if" work that must never be saved
 * (the split simulator, X2).
 */
export async function withRollback<T>(actor: Actor, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${DB_ROLE[actor.role]}`);
    await client.query("SELECT set_config('app.user_id', $1, true)", [
      actor.userId === null ? "" : String(actor.userId),
    ]);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/** Read-only helper for background jobs and reports. */
export function asReport<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTx({ userId: null, role: "report" }, fn);
}

/** Looks up a seeded or real user by email and returns them as an Actor. */
export async function actorByEmail(email: string): Promise<Actor> {
  const { rows } = await asReport((c) =>
    c.query<{ user_id: number; role: AppRole }>(
      "SELECT user_id, role FROM users WHERE email = $1 AND is_active",
      [email],
    ),
  );
  if (rows.length === 0) throw new Error(`No active user ${email}`);
  return { userId: rows[0].user_id, role: rows[0].role };
}

export async function closePool(): Promise<void> {
  await globalForPg.pgPool?.end();
  globalForPg.pgPool = undefined;
}
