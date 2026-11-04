import { HttpError } from "../api";
import { withTx, type Actor } from "../db/pg";
import { destroyUserSessions } from "../stores/cache";

/** Audit trail viewer and user management (admin only; the DB role enforces it too). */

export const AUDIT_PAGE_SIZE = 30;

export async function listAudit(actor: Actor, table: string | undefined, page = 1) {
  return withTx(actor, async (c) => {
    const { rows } = await c.query(
      `SELECT a.audit_id, a.table_name, a.operation, a.row_key, a.old_row, a.new_row, a.changed_at, a.tx_id,
              coalesce(u.full_name, 'database / script') AS changed_by,
              count(*) OVER () AS total
       FROM audit_log a LEFT JOIN users u ON u.user_id = a.changed_by
       WHERE $1::text IS NULL OR a.table_name = $1
       ORDER BY a.audit_id DESC
       LIMIT ${AUDIT_PAGE_SIZE} OFFSET $2`,
      [table || null, (Math.max(1, page) - 1) * AUDIT_PAGE_SIZE],
    );
    const tables = await c.query<{ table_name: string; n: string }>(
      "SELECT table_name, count(*) AS n FROM audit_log GROUP BY table_name ORDER BY table_name",
    );
    return { rows, total: Number(rows[0]?.total ?? 0), tables: tables.rows, page: Math.max(1, page) };
  });
}

export async function listUsers(actor: Actor) {
  const { rows } = await withTx(actor, (c) =>
    c.query(
      `SELECT u.user_id, u.email, u.full_name, u.role, u.is_active, u.created_at,
              c.legal_name AS contributor, p.name AS desk
       FROM users u
       LEFT JOIN contributors c USING (contributor_id)
       LEFT JOIN staff_platforms sp USING (user_id)
       LEFT JOIN platforms p USING (platform_id)
       ORDER BY u.role, u.full_name`,
    ),
  );
  return rows;
}

/** Deactivating also ends every session the user has (Redis), so access stops immediately. */
export async function setUserActive(actor: Actor, userId: number, active: boolean) {
  if (userId === actor.userId && !active) throw new HttpError(422, "You can't deactivate your own account.");
  const res = await withTx(actor, (c) => c.query("UPDATE users SET is_active = $2 WHERE user_id = $1", [userId, active]));
  if (res.rowCount === 0) throw new HttpError(404, "No such user.");
  const sessionsEnded = active ? 0 : await destroyUserSessions(userId);
  return { ok: true, sessionsEnded };
}
