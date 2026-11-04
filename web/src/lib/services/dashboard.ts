import { withTx, type Actor } from "../db/pg";
import { cached, rebuildLeaderboard, topTracks } from "../stores/cache";

/** Dashboard numbers: computed in Postgres, cached in Redis for 5 minutes (cache-aside). */

export interface Dashboard {
  latestPaid: { period_start: string; revenue: string; net_paid: string; statements: string; held: string; recouped: string; tds: string } | null;
  nextToPay: { period_id: number; period_start: string; status: string; revenue: string | null } | null;
  monthly: { period_start: string; platform: string; revenue: string }[];
  counts: { tracks: string; contributors: string; open_proposals: string; open_flags: string; unmatched: string };
  top: { trackId: number; title: string; streams: number }[];
  topPeriod: string | null;
  generatedAt: string;
}

export async function getDashboard(actor: Actor): Promise<Dashboard> {
  return cached("dashboard", 300, async () => {
    const data = await withTx(actor, async (c) => {
      const latestPaid = await c.query(
        `SELECT rp.period_start::text,
                (SELECT sum(revenue) FROM stream_stats s WHERE s.period_id = rp.period_id) AS revenue,
                sum(st.net_payable) AS net_paid, count(*) AS statements, sum(st.held_amount) AS held,
                sum(st.recouped_amount) AS recouped, sum(st.tds_amount) AS tds
         FROM royalty_periods rp JOIN statements st USING (period_id)
         WHERE rp.status = 'paid'
         GROUP BY rp.period_id ORDER BY rp.period_start DESC LIMIT 1`,
      );
      const nextToPay = await c.query(
        `SELECT rp.period_id, rp.period_start::text, rp.status,
                (SELECT sum(revenue) FROM stream_stats s WHERE s.period_id = rp.period_id) AS revenue
         FROM royalty_periods rp WHERE rp.status <> 'paid' ORDER BY rp.period_start LIMIT 1`,
      );
      const monthly = await c.query(
        `SELECT rp.period_start::text, p.name AS platform, sum(s.revenue) AS revenue
         FROM stream_stats s JOIN royalty_periods rp USING (period_id) JOIN platforms p USING (platform_id)
         GROUP BY rp.period_start, p.name ORDER BY rp.period_start, p.name`,
      );
      const counts = await c.query(
        `SELECT (SELECT count(*) FROM tracks WHERE status = 'active') AS tracks,
                (SELECT count(*) FROM contributors) AS contributors,
                (SELECT count(*) FROM split_versions WHERE status = 'proposed') AS open_proposals,
                (SELECT count(*) FROM fraud_flags WHERE status = 'open') AS open_flags,
                (SELECT count(*) FROM unmatched_lines WHERE status = 'unmatched') AS unmatched`,
      );
      const topPeriod = await c.query<{ period_id: number; period_start: string }>(
        `SELECT period_id, period_start::text FROM royalty_periods rp
         WHERE EXISTS (SELECT 1 FROM stream_stats s WHERE s.period_id = rp.period_id)
         ORDER BY period_start DESC LIMIT 1`,
      );
      return {
        latestPaid: latestPaid.rows[0] ?? null,
        nextToPay: nextToPay.rows[0] ?? null,
        monthly: monthly.rows,
        counts: counts.rows[0],
        topPeriod: topPeriod.rows[0] ?? null,
      };
    });

    let top: Dashboard["top"] = [];
    if (data.topPeriod) {
      top = await topTracks(data.topPeriod.period_id, 8);
      if (top.length === 0) {
        await rebuildLeaderboard(data.topPeriod.period_id);
        top = await topTracks(data.topPeriod.period_id, 8);
      }
    }
    return { ...data, top, topPeriod: data.topPeriod?.period_start ?? null, generatedAt: new Date().toISOString() };
  });
}
