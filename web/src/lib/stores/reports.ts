import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { Decimal128, Long, ObjectId, type Document } from "mongodb";
import { getMongoDb } from "../db/mongo";
import { asReport, withTx, type Actor } from "../db/pg";

/**
 * Platform report intake (docs/05-nosql-vector-models.md §5.1).
 *
 *   file  ->  MongoDB `reports` + `report_lines` (every line kept exactly as received)
 *         ->  aggregation pipeline normalises the three platform shapes
 *         ->  one Postgres transaction: known ISRCs upsert into stream_stats,
 *             everything else becomes an unmatched_lines row (matched later, F4)
 */

export type ReportPlatform = "SPOTIFY" | "YT_MUSIC" | "JIOSAAVN";

export interface ParsedReport {
  rows: Document[];
  declared: { streams: number; revenue: string } | null;
}

/** Reads a report file in the platform's own format. */
export async function parseReportFile(platform: ReportPlatform, filePath: string): Promise<ParsedReport> {
  return parseReportText(platform, await readFile(filePath, "utf8"));
}

/** Parses report contents (an uploaded file) in the platform's own format. */
export function parseReportText(platform: ReportPlatform, text: string): ParsedReport {
  switch (platform) {
    case "SPOTIFY": {
      // flat CSV; the last row is a TOTAL footer with the platform's own totals
      const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
      const footer = rows.find((r) => r.isrc === "TOTAL");
      return {
        rows: rows.filter((r) => r !== footer),
        declared: footer ? { streams: Number(footer.streams), revenue: footer.net_revenue_inr } : null,
      };
    }
    case "JIOSAAVN": {
      // CSV with capitalised headers, artists packed into one cell as "A|B", no totals
      const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
      return { rows, declared: null };
    }
    case "YT_MUSIC": {
      // nested JSON from the reporting API, with a summary block
      const json = JSON.parse(text) as { summary?: { total_views: number; total_revenue: number }; items?: Document[] };
      if (!Array.isArray(json.items)) throw new Error("Not a YouTube Music report: no items array");
      return {
        rows: json.items,
        declared: json.summary
          ? { streams: json.summary.total_views, revenue: json.summary.total_revenue.toFixed(2) }
          : null,
      };
    }
  }
}

/** Stores the report header and its lines untouched. Returns the report's ObjectId. */
export async function storeRawReport(input: {
  platform: ReportPlatform;
  periodStart: string; // YYYY-MM-01
  fileName: string;
  uploadedBy: number;
  parsed: ParsedReport;
}): Promise<ObjectId> {
  const db = await getMongoDb();
  const reportId = new ObjectId();
  await db.collection("reports").insertOne({
    _id: reportId,
    platform: input.platform,
    period_start: new Date(`${input.periodStart}T00:00:00Z`),
    file_name: input.fileName,
    uploaded_by: input.uploadedBy,
    uploaded_at: new Date(),
    status: "uploaded",
    line_count: input.parsed.rows.length,
    declared_totals: input.parsed.declared
      ? { streams: Long.fromNumber(input.parsed.declared.streams), revenue: Decimal128.fromString(input.parsed.declared.revenue) }
      : null,
  });
  if (input.parsed.rows.length > 0) {
    await db.collection("report_lines").insertMany(
      input.parsed.rows.map((raw, i) => ({ report_id: reportId, platform: input.platform, line_no: i + 1, raw })),
    );
  }
  return reportId;
}

/**
 * Stages that turn every platform's raw line into one shape:
 *   { platform, isrc | null, title, artist, streams: long, revenue: decimal }
 */
export function normalizeLineStages(reportIds: ObjectId[]): Document[] {
  return [
    { $match: { report_id: { $in: reportIds } } },
    {
      $project: {
        _id: 0,
        platform: 1,
        line_no: 1,
        isrc: {
          $switch: {
            branches: [
              { case: { $eq: ["$platform", "SPOTIFY"] }, then: "$raw.isrc" },
              { case: { $eq: ["$platform", "YT_MUSIC"] }, then: "$raw.asset.isrc" },
              { case: { $eq: ["$platform", "JIOSAAVN"] }, then: "$raw.ISRC" },
            ],
            default: null,
          },
        },
        title: { $ifNull: ["$raw.track_name", "$raw.asset.title", "$raw.Song"] },
        artist: {
          $ifNull: [
            "$raw.artist_name",
            "$raw.channel",
            // JioSaavn: "Kabir Beats|Aarav" -> "Kabir Beats, Aarav"
            {
              $reduce: {
                input: { $split: ["$raw.Artists", "|"] },
                initialValue: "",
                in: {
                  $concat: ["$$value", { $cond: [{ $eq: ["$$value", ""] }, "", ", "] }, { $trim: { input: "$$this" } }],
                },
              },
            },
          ],
        },
        // CSV cells arrive as strings, JSON as numbers: convert both
        streams: {
          $convert: { input: { $ifNull: ["$raw.streams", "$raw.metrics.views", "$raw.Plays"] }, to: "long", onError: null, onNull: null },
        },
        revenue: {
          $convert: {
            input: { $ifNull: ["$raw.net_revenue_inr", "$raw.metrics.revenue", "$raw.Amount"] },
            to: "decimal",
            onError: null,
            onNull: null,
          },
        },
      },
    },
    {
      // blank ISRC cells become null; real ones are trimmed and upper-cased
      $set: {
        isrc: {
          $let: {
            vars: { i: { $trim: { input: { $ifNull: ["$isrc", ""] } } } },
            in: { $cond: [{ $eq: ["$$i", ""] }, null, { $toUpper: "$$i" }] },
          },
        },
      },
    },
  ];
}

/** Full pipeline: one row per ISRC, or per title+artist when there is no ISRC. */
export function normalizeReportPipeline(reportIds: ObjectId[]): Document[] {
  return [
    ...normalizeLineStages(reportIds),
    {
      $group: {
        _id: { platform: "$platform", key: { $ifNull: ["$isrc", { title: "$title", artist: "$artist" }] } },
        isrc: { $first: "$isrc" },
        title: { $first: "$title" },
        artist: { $first: "$artist" },
        streams: { $sum: "$streams" },
        revenue: { $sum: "$revenue" },
        lines: { $sum: 1 },
        bad_lines: { $sum: { $cond: [{ $or: [{ $eq: ["$streams", null] }, { $eq: ["$revenue", null] }] }, 1, 0] } },
      },
    },
    { $project: { _id: 0, platform: "$_id.platform", isrc: 1, title: 1, artist: 1, streams: 1, revenue: 1, lines: 1, bad_lines: 1 } },
    { $sort: { isrc: 1, title: 1 } },
  ];
}

interface NormalizedRow {
  platform: ReportPlatform;
  isrc: string | null;
  title: string;
  artist: string | null;
  streams: number;
  revenue: Decimal128;
  lines: number;
  bad_lines: number;
}

export interface LoadResult {
  reportId: string;
  matchedTracks: number;
  unmatchedLines: number;
  streams: number;
}

/** Loads a stored report into Postgres in one transaction as `actor`. */
export async function loadReport(actor: Actor, reportId: ObjectId): Promise<LoadResult> {
  const db = await getMongoDb();
  const report = await db.collection("reports").findOne({ _id: reportId });
  if (!report) throw new Error(`Report ${reportId} not found`);

  const rows = (await db
    .collection("report_lines")
    .aggregate(normalizeReportPipeline([reportId]))
    .toArray()) as NormalizedRow[];
  const bad = rows.reduce((n, r) => n + r.bad_lines, 0);
  if (bad > 0) {
    await db.collection("reports").updateOne({ _id: reportId }, { $set: { status: "failed", error: `${bad} lines with unreadable numbers` } });
    throw new Error(`Report ${reportId}: ${bad} lines have unreadable stream or revenue values`);
  }

  const periodStart = (report.period_start as Date).toISOString().slice(0, 10);

  const result = await withTx(actor, async (c) => {
    const period = await c.query<{ period_id: number }>("SELECT period_id FROM royalty_periods WHERE period_start = $1", [periodStart]);
    if (period.rowCount === 0) throw new Error(`No royalty period starting ${periodStart}`);
    const platform = await c.query<{ platform_id: number }>("SELECT platform_id FROM platforms WHERE code = $1", [report.platform]);
    const periodId = period.rows[0].period_id;
    const platformId = platform.rows[0].platform_id;

    const isrcs = rows.filter((r) => r.isrc).map((r) => r.isrc as string);
    const known = await c.query<{ track_id: number; isrc: string }>(
      "SELECT track_id, isrc FROM tracks WHERE isrc = ANY($1::text[]) AND status = 'active'",
      [isrcs],
    );
    const trackByIsrc = new Map(known.rows.map((t) => [t.isrc, t.track_id]));
    const matched = rows.filter((r) => r.isrc && trackByIsrc.has(r.isrc));
    const unmatched = rows.filter((r) => !r.isrc || !trackByIsrc.has(r.isrc));

    // The report is authoritative for its platform and month: it replaces earlier figures.
    await c.query(
      `INSERT INTO stream_stats (period_id, platform_id, track_id, streams, revenue, source_report_id)
       SELECT $1, $2, t.track_id, t.streams, t.revenue, $3
       FROM unnest($4::int[], $5::bigint[], $6::numeric[]) AS t(track_id, streams, revenue)
       ON CONFLICT (period_id, platform_id, track_id) DO UPDATE
       SET streams = EXCLUDED.streams, revenue = EXCLUDED.revenue, source_report_id = EXCLUDED.source_report_id`,
      [
        periodId,
        platformId,
        reportId.toHexString(),
        matched.map((r) => trackByIsrc.get(r.isrc as string)),
        matched.map((r) => r.streams),
        matched.map((r) => r.revenue.toString()),
      ],
    );

    await c.query(
      `INSERT INTO unmatched_lines (period_id, platform_id, raw_title, raw_artist, streams, revenue, source_report_id)
       SELECT $1, $2, t.title, t.artist, t.streams, t.revenue, $3
       FROM unnest($4::text[], $5::text[], $6::bigint[], $7::numeric[]) AS t(title, artist, streams, revenue)`,
      [
        periodId,
        platformId,
        reportId.toHexString(),
        // keep a mistyped ISRC visible to the person matching the line
        unmatched.map((r) => (r.isrc ? `${r.title} [ISRC ${r.isrc} not in catalogue]` : r.title)),
        unmatched.map((r) => r.artist),
        unmatched.map((r) => r.streams),
        unmatched.map((r) => r.revenue.toString()),
      ],
    );

    return {
      reportId: reportId.toHexString(),
      matchedTracks: matched.length,
      unmatchedLines: unmatched.length,
      streams: rows.reduce((n, r) => n + r.streams, 0),
    };
  });

  // Postgres committed; record it on the Mongo side. If Postgres had failed, the
  // report would stay "uploaded" and could simply be loaded again.
  await db.collection("reports").updateOne(
    { _id: reportId },
    { $set: { status: "loaded", loaded_at: new Date(), loaded: { matched: result.matchedTracks, unmatched: result.unmatchedLines } } },
  );
  return result;
}

/** Parse + store raw + load, the whole upload flow. */
export async function ingestReportFile(input: {
  actor: Actor;
  platform: ReportPlatform;
  filePath: string;
  periodStart: string;
}): Promise<LoadResult> {
  if (input.actor.userId === null) throw new Error("An upload needs a signed-in user");
  const parsed = await parseReportFile(input.platform, input.filePath);
  const reportId = await storeRawReport({
    platform: input.platform,
    periodStart: input.periodStart,
    fileName: path.basename(input.filePath),
    uploadedBy: input.actor.userId,
    parsed,
  });
  return loadReport(input.actor, reportId);
}

export interface ReconciliationRow {
  platform: string;
  declared_streams: string | null;
  declared_revenue: string | null;
  received_streams: string;
  received_revenue: string;
  loaded_streams: string | null;
  loaded_revenue: string | null;
  status: "ok" | "declared_vs_received" | "received_vs_loaded";
}

/**
 * X1 reconciliation for one month, three ways per platform:
 *   declared  — the platform's own footer/summary totals
 *   received  — what the lines stored in MongoDB add up to
 *   loaded    — what reached Postgres (stream_stats + unmatched lines not yet matched)
 * Postgres finds the platforms where received <> loaded with a set operation (EXCEPT).
 */
export async function reconcilePeriod(periodStart: string): Promise<ReconciliationRow[]> {
  const db = await getMongoDb();
  const reports = await db
    .collection("reports")
    .find({ period_start: new Date(`${periodStart}T00:00:00Z`), status: "loaded" })
    .toArray();
  if (reports.length === 0) return [];
  const reportIds = reports.map((r) => r._id as ObjectId);

  const received = await db
    .collection("report_lines")
    .aggregate([
      ...normalizeLineStages(reportIds),
      { $group: { _id: "$platform", streams: { $sum: "$streams" }, revenue: { $sum: "$revenue" } } },
    ])
    .toArray();

  const declared = new Map<string, { streams: number; revenue: number } | null>();
  for (const r of reports) {
    const d = r.declared_totals as { streams: Long | number; revenue: Decimal128 } | null;
    const prev = declared.has(r.platform) ? declared.get(r.platform) : { streams: 0, revenue: 0 };
    declared.set(
      r.platform,
      d && prev ? { streams: prev.streams + Number(d.streams), revenue: prev.revenue + Number(d.revenue.toString()) } : null,
    );
  }

  return asReport(async (c) => {
    await c.query(
      `CREATE TEMP TABLE tmp_mongo_totals (
         platform_code TEXT, declared_streams BIGINT, declared_revenue NUMERIC, streams BIGINT, revenue NUMERIC
       ) ON COMMIT DROP`,
    );
    await c.query(
      `INSERT INTO tmp_mongo_totals
       SELECT * FROM unnest($1::text[], $2::bigint[], $3::numeric[], $4::bigint[], $5::numeric[])`,
      [
        received.map((r) => r._id),
        received.map((r) => declared.get(r._id)?.streams ?? null),
        received.map((r) => declared.get(r._id)?.revenue.toFixed(2) ?? null),
        received.map((r) => Number(r.streams)),
        received.map((r) => (r.revenue as Decimal128).toString()),
      ],
    );

    const loadedSql = `
      SELECT p.code AS platform_code, sum(x.streams)::bigint AS streams, round(sum(x.revenue), 2) AS revenue
      FROM (SELECT platform_id, streams, revenue FROM stream_stats
            WHERE source_report_id = ANY($1::text[])
            UNION ALL
            SELECT platform_id, streams, revenue FROM unmatched_lines
            WHERE source_report_id = ANY($1::text[]) AND status <> 'matched') AS x
      JOIN platforms p USING (platform_id)
      GROUP BY p.code`;

    // platforms whose MongoDB totals did not all reach Postgres
    const mismatched = await c.query<{ platform_code: string }>(
      `SELECT platform_code, streams, round(revenue, 2) FROM tmp_mongo_totals
       EXCEPT
       SELECT platform_code, streams, revenue FROM (${loadedSql}) AS loaded`,
      [reportIds.map((id) => id.toHexString())],
    );
    const notLoaded = new Set(mismatched.rows.map((r) => r.platform_code));

    const all = await c.query(
      `SELECT m.platform_code AS platform,
              m.declared_streams, round(m.declared_revenue, 2) AS declared_revenue,
              m.streams AS received_streams, round(m.revenue, 2) AS received_revenue,
              l.streams AS loaded_streams, l.revenue AS loaded_revenue
       FROM tmp_mongo_totals m
       LEFT JOIN (${loadedSql}) AS l USING (platform_code)
       ORDER BY m.platform_code`,
      [reportIds.map((id) => id.toHexString())],
    );

    return all.rows.map((r) => ({
      ...r,
      status: notLoaded.has(r.platform)
        ? "received_vs_loaded"
        : r.declared_streams !== null && (r.declared_streams !== r.received_streams || r.declared_revenue !== r.received_revenue)
          ? "declared_vs_received"
          : "ok",
    })) as ReconciliationRow[];
  });
}
