import path from "node:path";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { asReport, withTx, type Actor } from "../db/pg";

/**
 * F4: vector search for report lines that couldn't be matched by ISRC
 * (docs/05-nosql-vector-models.md §5.3).
 *
 *  - Model: all-MiniLM-L6-v2 (384 dims), run locally; no API key, no data leaves the machine.
 *  - Text:  "title — artist names" for tracks, "raw title — raw artist" for report lines.
 *  - Store: pgvector VECTOR(384) next to the rows they describe; HNSW index, cosine distance.
 */

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const MATCH_LIKELY = 0.85; // shown as "likely match"
export const MATCH_POSSIBLE = 0.6; // below this: "no good match"

/**
 * HNSW is approximate: it explores `ef_search` candidates per query. The default (40)
 * found the exact nearest track for only 6 of our 10 sample lines, because thousands of
 * near-identical generated titles crowd the graph; 400 found all 10
 * (docs/05-nosql-vector-models.md §5.3). The table is small, so the wider search is cheap.
 */
export const HNSW_EF_SEARCH = 400;

let extractor: Promise<FeatureExtractionPipeline> | undefined;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    env.cacheDir = process.env.MODEL_CACHE_DIR ?? path.join(process.cwd(), ".cache", "models");
    extractor = pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "q8" }) as Promise<FeatureExtractionPipeline>;
  }
  return extractor;
}

/** Mean-pooled, L2-normalised sentence embeddings. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const fe = await getExtractor();
  const out = await fe(texts, { pooling: "mean", normalize: true });
  return out.tolist() as number[][];
}

/** pgvector's text input format: '[0.1,0.2,...]' */
export const toVectorLiteral = (v: number[]): string => `[${v.join(",")}]`;

async function embedInBatches(texts: string[], batch = 64): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batch) out.push(...(await embed(texts.slice(i, i + batch))));
  return out;
}

/**
 * Embeds every track whose text changed (or was never embedded).
 * Text = title + the active split's artists (all credited names if it has no artist role).
 */
export async function embedTracks(actor: Actor): Promise<number> {
  const { rows } = await asReport((c) =>
    c.query<{ track_id: number; source_text: string }>(
      `WITH texts AS (
         SELECT t.track_id,
                t.title || coalesce(' — ' || (
                    SELECT string_agg(coalesce(c.stage_name, c.legal_name), ', '
                                      ORDER BY CASE ss.role WHEN 'artist' THEN 0 WHEN 'featured_artist' THEN 1 ELSE 2 END,
                                               ss.share_pct DESC)
                    FROM split_versions sv
                    JOIN split_shares ss USING (version_id)
                    JOIN contributors c USING (contributor_id)
                    WHERE sv.track_id = t.track_id AND sv.status = 'active'
                      AND (ss.role IN ('artist', 'featured_artist')
                           OR NOT EXISTS (SELECT 1 FROM split_shares s2
                                          WHERE s2.version_id = sv.version_id
                                            AND s2.role IN ('artist', 'featured_artist')))
                ), '') AS source_text
         FROM tracks t
         WHERE t.status <> 'retired'
       )
       SELECT x.track_id, x.source_text
       FROM texts x
       LEFT JOIN track_embeddings e USING (track_id)
       WHERE e.track_id IS NULL OR e.source_text <> x.source_text OR e.model <> $1
       ORDER BY x.track_id`,
      [EMBEDDING_MODEL],
    ),
  );
  if (rows.length === 0) return 0;

  const vectors = await embedInBatches(rows.map((r) => r.source_text));

  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500);
    await withTx(actor, (c) =>
      c.query(
        `INSERT INTO track_embeddings (track_id, embedding, source_text, model)
         SELECT t.track_id, t.vec::vector, t.source_text, $4
         FROM unnest($1::int[], $2::text[], $3::text[]) AS t(track_id, vec, source_text)
         ON CONFLICT (track_id) DO UPDATE
         SET embedding = EXCLUDED.embedding, source_text = EXCLUDED.source_text,
             model = EXCLUDED.model, embedded_at = now()`,
        [
          slice.map((r) => r.track_id),
          vectors.slice(i, i + 500).map(toVectorLiteral),
          slice.map((r) => r.source_text),
          EMBEDDING_MODEL,
        ],
      ),
    );
  }
  return rows.length;
}

/** Embeds unmatched report lines that don't have a vector yet. */
export async function embedUnmatchedLines(actor: Actor): Promise<number> {
  const { rows } = await asReport((c) =>
    c.query<{ line_id: string; text: string }>(
      `SELECT line_id, raw_title || coalesce(' — ' || raw_artist, '') AS text
       FROM unmatched_lines
       WHERE embedding IS NULL AND status = 'unmatched'
       ORDER BY line_id`,
    ),
  );
  if (rows.length === 0) return 0;
  const vectors = await embedInBatches(rows.map((r) => r.text));
  await withTx(actor, (c) =>
    c.query(
      `UPDATE unmatched_lines u SET embedding = t.vec::vector
       FROM unnest($1::bigint[], $2::text[]) AS t(line_id, vec)
       WHERE u.line_id = t.line_id`,
      [rows.map((r) => r.line_id), vectors.map(toVectorLiteral)],
    ),
  );
  return rows.length;
}

export interface MatchSuggestion {
  track_id: number;
  isrc: string;
  title: string;
  source_text: string;
  similarity: number;
  confidence: "likely" | "possible" | "weak";
}

/**
 * Top-k candidate tracks for one unmatched line: nearest neighbours by cosine
 * distance (pgvector `<=>`, served by the HNSW index). similarity = 1 - distance.
 */
export async function suggestMatches(actor: Actor, lineId: number | string, k = 5): Promise<MatchSuggestion[]> {
  const { rows } = await withTx(actor, async (c) => {
    await c.query(`SET LOCAL hnsw.ef_search = ${HNSW_EF_SEARCH}`);
    return c.query<{ track_id: number; isrc: string; title: string; source_text: string; similarity: string }>(
      `SELECT t.track_id, t.isrc, t.title, e.source_text,
              round((1 - (e.embedding <=> u.embedding))::numeric, 4) AS similarity
       FROM unmatched_lines u
       CROSS JOIN LATERAL (
           SELECT track_id, embedding, source_text
           FROM track_embeddings
           ORDER BY embedding <=> u.embedding
           LIMIT $2
       ) AS e
       JOIN tracks t USING (track_id)
       WHERE u.line_id = $1 AND u.embedding IS NOT NULL
       ORDER BY similarity DESC`,
      [lineId, k],
    );
  });
  return rows.map((r) => {
    const similarity = Number(r.similarity);
    return {
      ...r,
      similarity,
      confidence: similarity >= MATCH_LIKELY ? "likely" : similarity >= MATCH_POSSIBLE ? "possible" : "weak",
    };
  });
}
