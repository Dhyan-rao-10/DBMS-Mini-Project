import { HttpError } from "../api";
import type { CurrentUser } from "../auth";
import { asReport, withRollback, withTx, type Actor } from "../db/pg";
import type { ShareInput } from "./catalog";

/** F1 approvals and X2 what-if simulation. */

/** The signed-in contributor approves or rejects a proposal (approve_split runs in the DB). */
export async function decideSplit(actor: Actor, versionId: number, decision: "approved" | "rejected") {
  const status = await withTx(actor, async (c) => {
    const { rows } = await c.query<{ status: string }>("SELECT approve_split($1, $2) AS status", [versionId, decision]);
    return rows[0].status;
  });
  // contributors can't read split_versions, so look the track up with the report role
  const { rows } = await asReport((c) =>
    c.query<{ track_id: number }>("SELECT track_id FROM split_versions WHERE version_id = $1", [versionId]),
  );
  return { status, trackId: rows[0]?.track_id ?? null };
}

export interface SimulationRow {
  contributor_id: number;
  name: string;
  role: string;
  current: number;
  proposed: number;
}

/**
 * X2: "what would everyone have been paid with this split?"
 *
 * Runs the real payout procedure twice inside ONE transaction that is always
 * rolled back: first with today's split, then (after ROLLBACK TO SAVEPOINT)
 * with the proposed split approved and active. Sample chains, exact-paise
 * rounding and fraud holds all behave exactly as in a real payout, and nothing
 * is ever saved. It needs the payout procedure, so it runs as app_admin; that
 * is safe only because the transaction can never commit.
 */
export async function simulateSplit(user: CurrentUser, trackId: number, shares: ShareInput[]) {
  if (user.role === "contributor") {
    const { rows } = await asReport((c) =>
      c.query("SELECT 1 FROM v_current_splits WHERE track_id = $1 AND contributor_id = $2", [trackId, user.contributorId]),
    );
    if (rows.length === 0) throw new HttpError(403, "You can only simulate splits of tracks you are on.");
  }

  return withRollback({ userId: user.userId, role: "admin" }, async (c) => {
    const { rows: periods } = await c.query<{ period_id: number; period_start: string; status: string }>(
      "SELECT period_id, period_start::text, status FROM royalty_periods WHERE status <> 'paid' ORDER BY period_start LIMIT 1",
    );
    if (periods.length === 0) throw new HttpError(409, "Every period is already paid; there is nothing to simulate.");
    const period = periods[0];

    const linesFor = async () => {
      const { rows } = await c.query<{ contributor_id: number; name: string; role: string; amount: string }>(
        `SELECT c.contributor_id, coalesce(c.stage_name, c.legal_name) AS name, sl.role, sum(sl.amount) AS amount
         FROM statement_lines sl
         JOIN statements s USING (statement_id)
         JOIN split_versions sv USING (version_id)
         JOIN contributors c ON c.contributor_id = s.contributor_id
         WHERE s.period_id = $1 AND sv.track_id = $2
         GROUP BY c.contributor_id, c.stage_name, c.legal_name, sl.role`,
        [period.period_id, trackId],
      );
      return rows;
    };
    const pay = async () => {
      await c.query("UPDATE royalty_periods SET status = 'locked' WHERE period_id = $1 AND status = 'open'", [period.period_id]);
      await c.query("CALL process_payout($1)", [period.period_id]);
    };

    await c.query("SAVEPOINT before_payout");
    await pay();
    const current = await linesFor();
    await c.query("ROLLBACK TO SAVEPOINT before_payout");

    await c.query("DELETE FROM split_versions WHERE track_id = $1 AND status = 'proposed'", [trackId]);
    const { rows: v } = await c.query<{ version_id: number }>(
      "SELECT propose_split_version($1, $2::date, $3::jsonb) AS version_id",
      [trackId, period.period_start, JSON.stringify(shares)],
    );
    await c.query("UPDATE split_approvals SET decision = 'approved' WHERE version_id = $1", [v[0].version_id]);
    await pay();
    const proposed = await linesFor();

    const merged = new Map<string, SimulationRow>();
    const key = (r: { contributor_id: number; role: string }) => `${r.contributor_id}:${r.role}`;
    for (const { amount, ...r } of current) merged.set(key(r), { ...r, current: Number(amount), proposed: 0 });
    for (const r of proposed) {
      const row = merged.get(key(r)) ?? { contributor_id: r.contributor_id, name: r.name, role: r.role, current: 0, proposed: 0 };
      row.proposed = Number(r.amount);
      merged.set(key(r), row);
    }
    return {
      periodStart: period.period_start,
      rows: [...merged.values()].sort((a, b) => b.proposed + b.current - (a.proposed + a.current)),
    };
  });
}
