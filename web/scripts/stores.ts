/**
 * Command line for the non-relational stores (Phase 4).
 *
 *   npm run stores -- setup                  rebuild Mongo, embeddings, Neo4j and Redis from Postgres
 *   npm run stores -- sample-reports         regenerate db/mongo/sample_reports/*
 *   npm run stores -- ingest <PLATFORM> <file> <YYYY-MM> <uploader-email>
 *   npm run stores -- reconcile <YYYY-MM>
 *   npm run stores -- embed                  embed new/changed tracks and unmatched lines
 *   npm run stores -- match                  top suggestions for every unmatched line
 *   npm run stores -- graph                  rebuild Neo4j and run the example queries
 *   npm run stores -- redis                  leaderboard, rate-limit and session demo
 *
 * Run `bash db/postgres/setup.sh` first; `setup` here assumes that fresh Postgres state.
 */
import path from "node:path";
import { config } from "dotenv";

config({ path: path.resolve(__dirname, "..", "..", ".env"), quiet: true });

import { closeMongo, ensureMongoCollections, getMongoDb } from "../src/lib/db/mongo";
import { closeNeo4j } from "../src/lib/db/neo4j";
import { actorByEmail, asReport, closePool, withTx } from "../src/lib/db/pg";
import { closeRedis, getRedis } from "../src/lib/db/redis";
import {
  clearLoginFailures,
  createSession,
  destroyUserSessions,
  getSession,
  loginBlockedFor,
  rebuildLeaderboard,
  recordLoginFailure,
  topTracks,
} from "../src/lib/stores/cache";
import { embedTracks, embedUnmatchedLines, suggestMatches } from "../src/lib/stores/embeddings";
import { collaborators, mostSampled, rebuildGraph, shortestConnection, upstreamOf } from "../src/lib/stores/graph";
import { ingestReportFile, reconcilePeriod, type ReportPlatform } from "../src/lib/stores/reports";
import { writeSampleReports } from "./sample-reports";

const SAMPLE_DIR = path.resolve(__dirname, "..", "..", "db", "mongo", "sample_reports");
const SAMPLE_PERIOD = "2026-10";
const SAMPLES: { platform: ReportPlatform; file: string; uploader: string }[] = [
  { platform: "SPOTIFY", file: "spotify_2026_10.csv", uploader: "riya.spotify@monsoonrecords.test" },
  { platform: "YT_MUSIC", file: "yt_music_2026_10.json", uploader: "sana.youtube@monsoonrecords.test" },
  { platform: "JIOSAAVN", file: "jiosaavn_2026_10.csv", uploader: "dev.jiosaavn@monsoonrecords.test" },
];

const STAFF = "riya.spotify@monsoonrecords.test";
const ADMIN = "admin@monsoonrecords.test";

const monthStart = (yyyyMm: string) => {
  if (!/^\d{4}-\d{2}$/.test(yyyyMm)) throw new Error(`Expected YYYY-MM, got ${yyyyMm}`);
  return `${yyyyMm}-01`;
};

async function ensurePeriod(yyyyMm: string): Promise<void> {
  const start = monthStart(yyyyMm);
  await withTx(await actorByEmail(ADMIN), (c) =>
    c.query(
      `INSERT INTO royalty_periods (period_start, period_end)
       VALUES ($1::date, ($1::date + INTERVAL '1 month - 1 day')::date)
       ON CONFLICT (period_start) DO NOTHING`,
      [start],
    ),
  );
}

async function reconcile(yyyyMm: string) {
  const rows = await reconcilePeriod(monthStart(yyyyMm));
  console.log(`\nReconciliation ${yyyyMm} (declared by platform / received in MongoDB / loaded into Postgres):`);
  console.table(
    rows.map((r) => ({
      platform: r.platform,
      declared: r.declared_streams ? `${r.declared_streams} / ₹${r.declared_revenue}` : "—",
      received: `${r.received_streams} / ₹${r.received_revenue}`,
      loaded: `${r.loaded_streams} / ₹${r.loaded_revenue}`,
      status: r.status,
    })),
  );
}

async function match() {
  const staff = await actorByEmail(STAFF);
  const { rows } = await asReport((c) =>
    c.query<{ line_id: string; code: string; raw_title: string; raw_artist: string | null; streams: string }>(
      `SELECT u.line_id, p.code, u.raw_title, u.raw_artist, u.streams
       FROM unmatched_lines u JOIN platforms p USING (platform_id)
       WHERE u.status = 'unmatched' ORDER BY u.line_id`,
    ),
  );
  console.log(`\n${rows.length} unmatched lines, top 3 vector matches each:`);
  for (const line of rows) {
    const s = await suggestMatches(staff, line.line_id, 3);
    console.log(`\n  #${line.line_id} [${line.code}] "${line.raw_title}" — ${line.raw_artist ?? "?"} (${line.streams} streams)`);
    for (const m of s) console.log(`      ${m.similarity.toFixed(3)}  ${m.confidence.padEnd(8)}  ${m.isrc}  ${m.source_text}`);
  }
}

async function graphDemo() {
  const counts = await rebuildGraph();
  console.log(`\nNeo4j rebuilt: ${counts.nodes} nodes, ${counts.relationships} relationships`);
  const ids = await asReport((c) =>
    c.query<{ email: string; contributor_id: number; track_id: number | null }>(
      `SELECT c.email, c.contributor_id, NULL::int AS track_id FROM contributors c
       WHERE c.email IN ('leela.krishnan@example.com', 'tara.dsouza@example.com', 'kabir.rao@example.com')
       UNION ALL SELECT 'rain', NULL, track_id FROM tracks WHERE isrc = 'INM0R2500009'`,
    ),
  );
  const id = (email: string) => ids.rows.find((r) => r.email === email)!;
  console.log("\nShortest connection Tara D'Souza -> Leela Krishnan:");
  for (const r of await shortestConnection(id("tara.dsouza@example.com").contributor_id, id("leela.krishnan@example.com").contributor_id))
    console.log(`  ${r.hops} hops: ${r.path.map((n) => `${n.label} (${n.kind})`).join(" — ")}`);
  console.log("\nEverything upstream of Rain Cypher (same question as the recursive CTE):");
  console.table(await upstreamOf(id("rain").track_id!));
  console.log("Most-sampled tracks:");
  console.table(await mostSampled(5));
  console.log("Kabir Rao's most frequent collaborators:");
  console.table(await collaborators(id("kabir.rao@example.com").contributor_id, 5));
}

async function redisDemo() {
  const { rows } = await asReport((c) => c.query<{ period_id: number }>("SELECT period_id FROM royalty_periods ORDER BY period_start"));
  for (const p of rows) await rebuildLeaderboard(p.period_id);
  const latest = rows[rows.length - 1].period_id;
  console.log(`\nLeaderboards rebuilt for ${rows.length} periods. Top 5 in the latest (from a Redis sorted set):`);
  console.table(await topTracks(latest, 5));

  const email = "demo.ratelimit@example.com";
  await clearLoginFailures(email);
  for (let i = 1; i <= 5; i++) await recordLoginFailure(email);
  console.log(`After 5 failed logins, ${email} is blocked for ${await loginBlockedFor(email)} more seconds`);
  await clearLoginFailures(email);

  const { rows: me } = await asReport((c) =>
    c.query<{ user_id: number; contributor_id: number }>(
      "SELECT user_id, contributor_id FROM users WHERE email = 'aarav.mehta@example.com'",
    ),
  );
  const aarav = { userId: me[0].user_id };
  const token = await createSession({ userId: aarav.userId, role: "contributor", contributorId: me[0].contributor_id, name: "Aarav Mehta" });
  console.log("Session created:", await getSession(token));
  console.log(`Revoking all of that user's sessions: ${await destroyUserSessions(aarav.userId)} removed;`, "now:", await getSession(token));
}

async function setup() {
  console.log("MongoDB: resetting royalty_raw and creating validated collections…");
  await (await getMongoDb()).dropDatabase();
  await ensureMongoCollections();

  await ensurePeriod(SAMPLE_PERIOD);
  for (const s of SAMPLES) {
    const result = await ingestReportFile({
      actor: await actorByEmail(s.uploader),
      platform: s.platform,
      filePath: path.join(SAMPLE_DIR, s.file),
      periodStart: monthStart(SAMPLE_PERIOD),
    });
    console.log(`  ${s.platform.padEnd(8)} ${s.file}: ${result.matchedTracks} tracks loaded, ${result.unmatchedLines} unmatched lines`);
  }
  await reconcile(SAMPLE_PERIOD);

  console.log("\npgvector: embedding tracks and unmatched lines (local all-MiniLM-L6-v2)…");
  const staff = await actorByEmail(STAFF);
  const t0 = Date.now();
  console.log(`  ${await embedTracks(staff)} tracks, ${await embedUnmatchedLines(staff)} lines in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await match();

  await graphDemo();

  console.log("\nRedis: clearing and rebuilding…");
  await getRedis().flushdb();
  await redisDemo();
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "setup":
      return setup();
    case "sample-reports":
      for (const f of await writeSampleReports(SAMPLE_DIR)) console.log("wrote", path.relative(process.cwd(), f));
      return;
    case "ingest": {
      const [platform, file, yyyyMm, uploader] = args;
      if (!uploader) throw new Error("usage: ingest <PLATFORM> <file> <YYYY-MM> <uploader-email>");
      await ensurePeriod(yyyyMm);
      console.log(
        await ingestReportFile({
          actor: await actorByEmail(uploader),
          platform: platform as ReportPlatform,
          filePath: path.resolve(file),
          periodStart: monthStart(yyyyMm),
        }),
      );
      return reconcile(yyyyMm);
    }
    case "reconcile":
      return reconcile(args[0] ?? SAMPLE_PERIOD);
    case "embed": {
      const staff = await actorByEmail(STAFF);
      return console.log(`${await embedTracks(staff)} tracks, ${await embedUnmatchedLines(staff)} lines embedded`);
    }
    case "match":
      return match();
    case "graph":
      return graphDemo();
    case "redis":
      return redisDemo();
    default:
      console.log("commands: setup | sample-reports | ingest | reconcile | embed | match | graph | redis");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closePool(), closeMongo(), closeNeo4j(), closeRedis()]);
  });
