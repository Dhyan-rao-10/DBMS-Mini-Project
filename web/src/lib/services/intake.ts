import { HttpError } from "../api";
import { getMongoDb } from "../db/mongo";
import { asReport, withTx, type Actor } from "../db/pg";
import { suggestMatches, type MatchSuggestion } from "../stores/embeddings";
import { loadReport, parseReportText, reconcilePeriod, storeRawReport, type ReportPlatform } from "../stores/reports";

/** Report upload (MongoDB -> Postgres), unmatched-line matching (F4) and reconciliation (X1). */

export const UPLOAD_PLATFORMS: { code: ReportPlatform; name: string; format: string }[] = [
  { code: "SPOTIFY", name: "Spotify", format: "CSV with TOTAL footer" },
  { code: "YT_MUSIC", name: "YouTube Music", format: "JSON (items + summary)" },
  { code: "JIOSAAVN", name: "JioSaavn", format: "CSV, artists joined with |" },
];

export async function uploadReport(
  actor: Actor,
  input: { platform: string; month: string; fileName: string; text: string },
) {
  if (!UPLOAD_PLATFORMS.some((p) => p.code === input.platform)) throw new HttpError(422, "Choose a platform.");
  if (!/^\d{4}-\d{2}$/.test(input.month)) throw new HttpError(422, "Choose the month the report covers.");
  if (actor.userId === null) throw new HttpError(401, "Please sign in again.");
  const periodStart = `${input.month}-01`;

  const period = await withTx(actor, (c) =>
    c.query<{ period_id: number; status: string }>("SELECT period_id, status FROM royalty_periods WHERE period_start = $1", [
      periodStart,
    ]),
  );
  if (period.rowCount === 0) throw new HttpError(422, `There is no royalty period for ${input.month} yet; an admin opens it on the Payouts page.`);
  if (period.rows[0].status !== "open") throw new HttpError(409, `${input.month} is ${period.rows[0].status}; reports can only be added while it is open.`);

  const already = await (await getMongoDb())
    .collection("reports")
    .findOne({ platform: input.platform, period_start: new Date(`${periodStart}T00:00:00Z`), status: "loaded" });
  if (already) {
    throw new HttpError(409, `A ${input.platform} report for ${input.month} is already loaded (${already.file_name}).`);
  }

  let parsed;
  try {
    parsed = parseReportText(input.platform as ReportPlatform, input.text);
  } catch (err) {
    throw new HttpError(422, `Couldn't read this file as a ${input.platform} report: ${(err as Error).message}`);
  }
  if (parsed.rows.length === 0) throw new HttpError(422, "The file has no report lines.");

  const reportId = await storeRawReport({
    platform: input.platform as ReportPlatform,
    periodStart,
    fileName: input.fileName,
    uploadedBy: actor.userId,
    parsed,
  });
  try {
    const result = await loadReport(actor, reportId);
    return { ...result, periodId: period.rows[0].period_id, lines: parsed.rows.length };
  } catch (err) {
    await (await getMongoDb()).collection("reports").updateOne({ _id: reportId }, { $set: { status: "failed", error: String(err) } });
    throw err;
  }
}

export async function listReports() {
  const db = await getMongoDb();
  const reports = await db
    .collection("reports")
    .find({}, { projection: { platform: 1, period_start: 1, file_name: 1, uploaded_by: 1, uploaded_at: 1, status: 1, line_count: 1, loaded: 1, error: 1 } })
    .sort({ uploaded_at: -1 })
    .limit(50)
    .toArray();
  const ids = [...new Set(reports.map((r) => r.uploaded_by as number))];
  const { rows } = await asReport((c) =>
    c.query<{ user_id: number; full_name: string }>("SELECT user_id, full_name FROM users WHERE user_id = ANY($1::int[])", [ids]),
  );
  const names = new Map(rows.map((u) => [u.user_id, u.full_name]));
  return reports.map((r) => ({
    id: r._id.toHexString(),
    platform: r.platform as string,
    month: (r.period_start as Date).toISOString().slice(0, 7),
    fileName: r.file_name as string,
    uploadedBy: names.get(r.uploaded_by as number) ?? `user ${r.uploaded_by}`,
    uploadedAt: (r.uploaded_at as Date).toISOString(),
    status: r.status as string,
    lines: r.line_count as number,
    matched: (r.loaded as { matched?: number } | undefined)?.matched ?? null,
    unmatched: (r.loaded as { unmatched?: number } | undefined)?.unmatched ?? null,
    error: (r.error as string | undefined) ?? null,
  }));
}

export async function reportMonths(): Promise<string[]> {
  const db = await getMongoDb();
  const months = (await db.collection("reports").distinct("period_start")) as Date[];
  return months.map((d) => d.toISOString().slice(0, 7)).sort().reverse();
}

export const reconcile = (month: string) => reconcilePeriod(`${month}-01`);

export interface UnmatchedLine {
  line_id: string;
  platform: string;
  period_start: string;
  raw_title: string;
  raw_artist: string | null;
  streams: string;
  revenue: string;
  status: string;
  matched_title: string | null;
  matched_by: string | null;
  matched_at: string | null;
  suggestions: MatchSuggestion[];
}

export async function listUnmatched(actor: Actor, status: "unmatched" | "resolved"): Promise<UnmatchedLine[]> {
  const { rows } = await withTx(actor, (c) =>
    c.query<Omit<UnmatchedLine, "suggestions">>(
      `SELECT u.line_id, p.name AS platform, rp.period_start::text, u.raw_title, u.raw_artist, u.streams, u.revenue,
              u.status, t.title AS matched_title, us.full_name AS matched_by, u.matched_at
       FROM unmatched_lines u
       JOIN platforms p USING (platform_id)
       JOIN royalty_periods rp USING (period_id)
       LEFT JOIN tracks t ON t.track_id = u.matched_track_id
       LEFT JOIN users us ON us.user_id = u.matched_by
       WHERE ($1 = 'unmatched') = (u.status = 'unmatched')
       ORDER BY u.revenue DESC
       LIMIT 100`,
      [status],
    ),
  );
  const out: UnmatchedLine[] = [];
  for (const r of rows) {
    out.push({ ...r, suggestions: status === "unmatched" ? await suggestMatches(actor, r.line_id, 3) : [] });
  }
  return out;
}

export async function confirmLine(actor: Actor, lineId: number, trackId: number) {
  return withTx(actor, async (c) => {
    await c.query("SELECT confirm_unmatched_line($1, $2)", [lineId, trackId]);
    const { rows } = await c.query<{ period_id: number }>("SELECT period_id FROM unmatched_lines WHERE line_id = $1", [lineId]);
    return { periodId: rows[0].period_id };
  });
}

export async function writeOffLine(actor: Actor, lineId: number) {
  return withTx(actor, (c) => c.query("SELECT write_off_unmatched_line($1)", [lineId]).then(() => ({ ok: true })));
}
