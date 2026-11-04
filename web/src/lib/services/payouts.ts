import { HttpError } from "../api";
import { withTx, type Actor } from "../db/pg";

/** Royalty periods, the payout run (process_payout) and fraud review (F3). */

export interface PeriodRow {
  period_id: number;
  period_start: string;
  status: "open" | "locked" | "paid";
  processed_at: string | null;
  processed_by: string | null;
  streams: string | null;
  revenue: string | null;
  statements: string;
  net_paid: string | null;
  held: string | null;
  recouped: string | null;
  tds: string | null;
  open_flags: string;
  unmatched: string;
}

export async function listPeriods(actor: Actor): Promise<PeriodRow[]> {
  const { rows } = await withTx(actor, (c) =>
    c.query<PeriodRow>(
      `SELECT rp.period_id, rp.period_start::text, rp.status, rp.processed_at, u.full_name AS processed_by,
              ss.streams, ss.revenue,
              coalesce(st.statements, 0) AS statements, st.net_paid, st.held, st.recouped, st.tds,
              (SELECT count(*) FROM fraud_flags f WHERE f.period_id = rp.period_id AND f.status = 'open') AS open_flags,
              (SELECT count(*) FROM unmatched_lines l WHERE l.period_id = rp.period_id AND l.status = 'unmatched') AS unmatched
       FROM royalty_periods rp
       LEFT JOIN users u ON u.user_id = rp.processed_by
       LEFT JOIN LATERAL (SELECT sum(streams) AS streams, sum(revenue) AS revenue
                          FROM stream_stats s WHERE s.period_id = rp.period_id) ss ON true
       LEFT JOIN LATERAL (SELECT count(*) AS statements, sum(net_payable) AS net_paid, sum(held_amount) AS held,
                                 sum(recouped_amount) AS recouped, sum(tds_amount) AS tds
                          FROM statements s WHERE s.period_id = rp.period_id) st ON true
       ORDER BY rp.period_start DESC`,
    ),
  );
  return rows;
}

export async function setPeriodStatus(actor: Actor, periodId: number, status: "open" | "locked") {
  return withTx(actor, async (c) => {
    const res = await c.query("UPDATE royalty_periods SET status = $2 WHERE period_id = $1 RETURNING status", [periodId, status]);
    if (res.rowCount === 0) throw new HttpError(404, "No such period.");
    return res.rows[0];
  });
}

export async function openNextPeriod(actor: Actor) {
  return withTx(actor, async (c) => {
    const { rows } = await c.query<{ period_start: string }>(
      `INSERT INTO royalty_periods (period_start, period_end)
       SELECT d, (d + INTERVAL '1 month - 1 day')::date
       FROM (SELECT (max(period_start) + INTERVAL '1 month')::date AS d FROM royalty_periods) x
       RETURNING period_start::text`,
    );
    return rows[0];
  });
}

export async function payPeriod(actor: Actor, periodId: number) {
  return withTx(actor, async (c) => {
    const { rows } = await c.query<{ o_statements: number; o_gross: string; o_held: string; o_net_paid: string }>(
      "CALL process_payout($1)",
      [periodId],
    );
    return rows[0];
  });
}

export async function periodStatements(actor: Actor, periodId: number) {
  const { rows } = await withTx(actor, (c) =>
    c.query(
      `SELECT * FROM v_contributor_earnings WHERE period_id = $1 ORDER BY gross_earned DESC LIMIT 40`,
      [periodId],
    ),
  );
  return rows;
}

export interface FlagRow {
  flag_id: number;
  track_id: number;
  title: string;
  isrc: string;
  period_start: string;
  rule: string;
  platform: string | null;
  observed_value: string;
  threshold_value: string;
  status: string;
  note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  held: string | null;
  held_status: string | null;
}

export async function listFlags(actor: Actor, status: "open" | "reviewed"): Promise<FlagRow[]> {
  const { rows } = await withTx(actor, (c) =>
    c.query<FlagRow>(
      `SELECT f.flag_id, f.track_id, t.title, t.isrc, rp.period_start::text, f.rule, p.name AS platform,
              f.observed_value, f.threshold_value, f.status, f.note, u.full_name AS reviewed_by, f.reviewed_at,
              h.held, h.held_status
       FROM fraud_flags f
       JOIN tracks t USING (track_id)
       JOIN royalty_periods rp USING (period_id)
       LEFT JOIN platforms p USING (platform_id)
       LEFT JOIN users u ON u.user_id = f.reviewed_by
       LEFT JOIN LATERAL (SELECT sum(amount) AS held, string_agg(DISTINCT status, ', ') AS held_status
                          FROM held_earnings he WHERE he.flag_id = f.flag_id) h ON true
       WHERE ($1 = 'open') = (f.status = 'open')
       ORDER BY rp.period_start DESC, t.title, f.rule`,
      [status],
    ),
  );
  return rows;
}

export async function reviewFlags(actor: Actor, trackId: number, periodStart: string, status: "cleared" | "confirmed", note: string) {
  if (!note.trim()) throw new HttpError(422, "Write a short reason for the decision.");
  return withTx(actor, async (c) => {
    // both rules for the same track and month are decided together
    const res = await c.query(
      `UPDATE fraud_flags f SET status = $3, note = $4
       FROM royalty_periods rp
       WHERE f.period_id = rp.period_id AND f.track_id = $1 AND rp.period_start = $2::date AND f.status = 'open'`,
      [trackId, periodStart, status, note.trim()],
    );
    return { reviewed: res.rowCount };
  });
}
