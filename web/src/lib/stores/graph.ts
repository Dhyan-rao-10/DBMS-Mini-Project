import { getNeo4j } from "../db/neo4j";
import { asReport } from "../db/pg";

/**
 * F2: Neo4j mirror of who is credited on what, and which tracks sample which
 * (docs/05-nosql-vector-models.md §5.2). Postgres stays the source of truth;
 * this graph is rebuilt or patched after Postgres commits, never the other way.
 *
 *   (:Contributor)-[:CREDITED_ON {role, share_pct, version_id}]->(:Track)
 *   (:Track)-[:SAMPLES {upstream_pct}]->(:Track)        sampling -> sampled
 */

interface GraphData {
  contributors: { contributor_id: number; name: string }[];
  tracks: { track_id: number; isrc: string; title: string }[];
  credits: { contributor_id: number; track_id: number; role: string; share_pct: number; version_id: number }[];
  samples: { sampling_track_id: number; sampled_track_id: number; upstream_pct: number }[];
}

async function readFromPostgres(trackIds?: number[]): Promise<GraphData> {
  return asReport(async (c) => {
    const filter = trackIds ? "WHERE t.track_id = ANY($1::int[])" : "";
    const params = trackIds ? [trackIds] : [];
    const tracks = await c.query(`SELECT t.track_id, t.isrc, t.title FROM tracks t ${filter}`, params);
    const credits = await c.query(
      `SELECT s.contributor_id, s.track_id, s.role, s.share_pct::float AS share_pct, s.version_id
       FROM v_current_splits s ${trackIds ? "WHERE s.track_id = ANY($1::int[])" : ""}`,
      params,
    );
    const contributors = await c.query(
      `SELECT contributor_id, coalesce(stage_name, legal_name) AS name FROM contributors
       WHERE contributor_id = ANY($1::int[])`,
      [[...new Set(credits.rows.map((r) => r.contributor_id))]],
    );
    const samples = await c.query(
      `SELECT sampling_track_id, sampled_track_id, upstream_pct::float AS upstream_pct FROM samples
       ${trackIds ? "WHERE sampling_track_id = ANY($1::int[]) OR sampled_track_id = ANY($1::int[])" : ""}`,
      params,
    );
    return { contributors: contributors.rows, tracks: tracks.rows, credits: credits.rows, samples: samples.rows };
  });
}

async function writeToNeo4j(data: GraphData): Promise<void> {
  const session = getNeo4j().session();
  try {
    await session.executeWrite(async (tx) => {
      await tx.run(
        `UNWIND $rows AS row
         MERGE (c:Contributor {contributor_id: toInteger(row.contributor_id)})
         SET c.name = row.name`,
        { rows: data.contributors },
      );
      await tx.run(
        `UNWIND $rows AS row
         MERGE (t:Track {track_id: toInteger(row.track_id)})
         SET t.isrc = row.isrc, t.title = row.title`,
        { rows: data.tracks },
      );
      await tx.run(
        `UNWIND $rows AS row
         MATCH (c:Contributor {contributor_id: toInteger(row.contributor_id)})
         MATCH (t:Track {track_id: toInteger(row.track_id)})
         MERGE (c)-[r:CREDITED_ON {role: row.role}]->(t)
         SET r.share_pct = row.share_pct, r.version_id = toInteger(row.version_id)`,
        { rows: data.credits },
      );
      await tx.run(
        `UNWIND $rows AS row
         MATCH (a:Track {track_id: toInteger(row.sampling_track_id)})
         MATCH (b:Track {track_id: toInteger(row.sampled_track_id)})
         MERGE (a)-[s:SAMPLES]->(b)
         SET s.upstream_pct = row.upstream_pct`,
        { rows: data.samples },
      );
    });
  } finally {
    await session.close();
  }
}

/** Drops and rebuilds the whole graph from Postgres. */
export async function rebuildGraph(): Promise<{ nodes: number; relationships: number }> {
  const session = getNeo4j().session();
  try {
    await session.run("CREATE CONSTRAINT contributor_id IF NOT EXISTS FOR (c:Contributor) REQUIRE c.contributor_id IS UNIQUE");
    await session.run("CREATE CONSTRAINT track_id IF NOT EXISTS FOR (t:Track) REQUIRE t.track_id IS UNIQUE");
    await session.run("MATCH (n) CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 5000 ROWS");
  } finally {
    await session.close();
  }

  await writeToNeo4j(await readFromPostgres());

  const check = getNeo4j().session();
  try {
    const res = await check.run(
      "MATCH (n) WITH count(n) AS nodes MATCH ()-[r]->() RETURN nodes, count(r) AS relationships",
    );
    return res.records[0].toObject() as { nodes: number; relationships: number };
  } finally {
    await check.close();
  }
}

/** Re-syncs one track after a split version activates or a sample is added/removed. */
export async function syncTrack(trackId: number): Promise<void> {
  const session = getNeo4j().session();
  try {
    await session.run(
      `MATCH (t:Track {track_id: toInteger($id)})
       OPTIONAL MATCH (t)<-[credit:CREDITED_ON]-()
       OPTIONAL MATCH (t)-[sample:SAMPLES]-()
       DELETE credit, sample`,
      { id: trackId },
    );
  } finally {
    await session.close();
  }
  await writeToNeo4j(await readFromPostgres([trackId]));
}

async function read<T>(cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const session = getNeo4j().session({ defaultAccessMode: "READ" });
  try {
    const res = await session.run(cypher, params);
    return res.records.map((r) => r.toObject() as T);
  } finally {
    await session.close();
  }
}

/** Shortest chain of shared tracks and samples between two contributors. */
export function shortestConnection(fromContributorId: number, toContributorId: number) {
  return read<{ path: { kind: string; label: string }[]; hops: number }>(
    `MATCH (a:Contributor {contributor_id: toInteger($a)}), (b:Contributor {contributor_id: toInteger($b)}),
           p = shortestPath((a)-[:CREDITED_ON|SAMPLES*..10]-(b))
     RETURN [n IN nodes(p) | {kind: labels(n)[0], label: coalesce(n.name, n.title)}] AS path,
            length(p) AS hops`,
    { a: fromContributorId, b: toContributorId },
  );
}

/** Tracks sampled the most, counting indirect samples (variable-length path). */
export function mostSampled(limit = 10) {
  return read<{ title: string; sampled_by: number; max_depth: number }>(
    `MATCH p = (d:Track)-[:SAMPLES*1..]->(t:Track)
     RETURN t.title AS title, count(DISTINCT d) AS sampled_by, max(length(p)) AS max_depth
     ORDER BY sampled_by DESC, title LIMIT toInteger($limit)`,
    { limit },
  );
}

/** Every track upstream of one track, with hop count (same question as the recursive CTE). */
export function upstreamOf(trackId: number) {
  return read<{ title: string; hops: number }>(
    `MATCH p = (:Track {track_id: toInteger($id)})-[:SAMPLES*1..]->(t:Track)
     RETURN t.title AS title, min(length(p)) AS hops ORDER BY hops`,
    { id: trackId },
  );
}

/** People who share a track with a contributor, most shared tracks first. */
export function collaborators(contributorId: number, limit = 10) {
  return read<{ name: string; shared_tracks: number }>(
    `MATCH (me:Contributor {contributor_id: toInteger($id)})-[:CREDITED_ON]->(t:Track)<-[:CREDITED_ON]-(other:Contributor)
     WHERE other <> me
     RETURN other.name AS name, count(DISTINCT t) AS shared_tracks
     ORDER BY shared_tracks DESC, name LIMIT toInteger($limit)`,
    { id: contributorId, limit },
  );
}
