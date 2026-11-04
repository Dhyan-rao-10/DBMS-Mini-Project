import { withTx, type Actor } from "../db/pg";

/** Tracks, split versions, samples and contributors. Every query runs as the caller's DB role. */

export const PAGE_SIZE = 25;

/** "mons let" -> 'mons':* & 'let':*  (prefix full-text query, passed as a bind parameter) */
export function prefixQuery(q: string): string | null {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length ? words.map((w) => `'${w.replace(/'/g, "''")}':*`).join(" & ") : null;
}

export interface TrackListFilters {
  q?: string;
  status?: string;
  genre?: string;
  language?: string;
  proposals?: boolean;
  page?: number;
}

export interface TrackListRow {
  track_id: number;
  isrc: string;
  title: string;
  status: string;
  language: string;
  release_title: string;
  genres: string | null;
  artists: string | null;
  streams_12m: string | null;
  open_proposal: boolean;
  total: string;
}

export async function listTracks(actor: Actor, f: TrackListFilters) {
  const page = Math.max(1, f.page ?? 1);
  const tsq = f.q ? prefixQuery(f.q) : null;
  return withTx(actor, async (c) => {
    const { rows } = await c.query<TrackListRow>(
      `SELECT t.track_id, t.isrc, t.title, t.status, t.language, r.title AS release_title,
              (SELECT string_agg(g.name, ', ' ORDER BY g.name)
               FROM track_genres tg JOIN genres g USING (genre_id) WHERE tg.track_id = t.track_id) AS genres,
              (SELECT string_agg(coalesce(cs.stage_name, cs.legal_name), ', ' ORDER BY cs.share_pct DESC)
               FROM v_current_splits cs
               WHERE cs.track_id = t.track_id AND cs.role IN ('artist', 'featured_artist')) AS artists,
              (SELECT sum(s.streams) FROM stream_stats s WHERE s.track_id = t.track_id) AS streams_12m,
              EXISTS (SELECT 1 FROM split_versions sv WHERE sv.track_id = t.track_id AND sv.status = 'proposed') AS open_proposal,
              count(*) OVER () AS total
       FROM tracks t
       JOIN releases r USING (release_id)
       WHERE ($1::text IS NULL OR t.search_vector @@ to_tsquery('simple', $1) OR t.isrc = upper($2))
         AND ($3::text IS NULL OR t.status = $3)
         AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM track_genres tg JOIN genres g USING (genre_id)
                                          WHERE tg.track_id = t.track_id AND g.name = $4))
         AND ($5::text IS NULL OR t.language = $5)
         AND ($7::boolean IS NOT TRUE
              OR EXISTS (SELECT 1 FROM split_versions sv WHERE sv.track_id = t.track_id AND sv.status = 'proposed'))
       ORDER BY ${tsq ? "ts_rank(t.search_vector, to_tsquery('simple', $1)) DESC," : ""}
                streams_12m DESC NULLS LAST, t.title
       LIMIT ${PAGE_SIZE} OFFSET $6`,
      [tsq, f.q?.trim() ?? "", f.status || null, f.genre || null, f.language || null, (page - 1) * PAGE_SIZE, f.proposals ?? false],
    );
    const filters = await c.query<{ genres: string[]; languages: string[] }>(
      `SELECT (SELECT array_agg(name ORDER BY name) FROM genres) AS genres,
              (SELECT array_agg(DISTINCT language ORDER BY language) FROM tracks) AS languages`,
    );
    return { rows, total: Number(rows[0]?.total ?? 0), page, ...filters.rows[0] };
  });
}

export interface SplitVersionDetail {
  version_id: number;
  status: string;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
  activated_at: string | null;
  proposed_by: string;
  shares: { contributor_id: number; name: string; role: string; share_pct: string }[];
  approvals: { contributor_id: number; name: string; decision: string; decided_at: string | null }[];
}

export async function getTrack(actor: Actor, trackId: number) {
  return withTx(actor, async (c) => {
    const track = await c.query(
      `SELECT t.*, r.title AS release_title, r.release_type, r.release_date, r.upc,
              (SELECT string_agg(g.name, ', ' ORDER BY g.name)
               FROM track_genres tg JOIN genres g USING (genre_id) WHERE tg.track_id = t.track_id) AS genres
       FROM tracks t JOIN releases r USING (release_id) WHERE t.track_id = $1`,
      [trackId],
    );
    if (track.rowCount === 0) return null;

    const versions = await c.query<SplitVersionDetail>(
      `SELECT sv.version_id, sv.status, sv.valid_from::text, sv.valid_to::text, sv.created_at, sv.activated_at,
              u.full_name AS proposed_by,
              (SELECT json_agg(json_build_object('contributor_id', c.contributor_id,
                                                 'name', coalesce(c.stage_name, c.legal_name),
                                                 'role', ss.role, 'share_pct', ss.share_pct)
                               ORDER BY ss.share_pct DESC)
               FROM split_shares ss JOIN contributors c USING (contributor_id)
               WHERE ss.version_id = sv.version_id) AS shares,
              (SELECT json_agg(json_build_object('contributor_id', c.contributor_id,
                                                 'name', coalesce(c.stage_name, c.legal_name),
                                                 'decision', sa.decision, 'decided_at', sa.decided_at)
                               ORDER BY c.legal_name)
               FROM split_approvals sa JOIN contributors c USING (contributor_id)
               WHERE sa.version_id = sv.version_id) AS approvals
       FROM split_versions sv
       JOIN users u ON u.user_id = sv.proposed_by
       WHERE sv.track_id = $1
       ORDER BY sv.valid_from DESC, sv.version_id DESC`,
      [trackId],
    );

    // the whole chain this track's money flows up through (recursive CTE, F2)
    const upstream = await c.query<{ track_id: number; title: string; isrc: string; hops: number; upstream_pct: string; via: string }>(
      `WITH RECURSIVE up (track_id, hops, pct, via, path) AS (
           SELECT s.sampled_track_id, 1, s.upstream_pct, $1::int, ARRAY[$1::int, s.sampled_track_id]
           FROM samples s WHERE s.sampling_track_id = $1
         UNION ALL
           SELECT s.sampled_track_id, up.hops + 1, s.upstream_pct, up.track_id, up.path || s.sampled_track_id
           FROM samples s JOIN up ON s.sampling_track_id = up.track_id
           WHERE s.sampled_track_id <> ALL (up.path)
       )
       SELECT up.track_id, t.title, t.isrc, up.hops, up.pct AS upstream_pct, v.title AS via
       FROM up JOIN tracks t USING (track_id) JOIN tracks v ON v.track_id = up.via
       ORDER BY up.hops, t.title`,
      [trackId],
    );
    const sampledBy = await c.query<{ track_id: number; title: string; upstream_pct: string; cleared_on: string }>(
      `SELECT t.track_id, t.title, s.upstream_pct, s.cleared_on::text
       FROM samples s JOIN tracks t ON t.track_id = s.sampling_track_id
       WHERE s.sampled_track_id = $1 ORDER BY t.title`,
      [trackId],
    );

    const monthly = await c.query<{ period_start: string; platform: string; streams: string; revenue: string }>(
      `SELECT rp.period_start::text, p.name AS platform, s.streams, s.revenue
       FROM stream_stats s
       JOIN royalty_periods rp USING (period_id)
       JOIN platforms p USING (platform_id)
       WHERE s.track_id = $1
       ORDER BY rp.period_start, p.name`,
      [trackId],
    );

    const flags = await c.query(
      `SELECT f.flag_id, f.rule, f.status, f.observed_value, rp.period_start::text, p.name AS platform
       FROM fraud_flags f JOIN royalty_periods rp USING (period_id) LEFT JOIN platforms p USING (platform_id)
       WHERE f.track_id = $1 ORDER BY rp.period_start DESC`,
      [trackId],
    );

    const paid = await c.query<{ period_start: string; direct: string; via_samples: string }>(
      `SELECT rp.period_start::text,
              sum(sl.amount) FILTER (WHERE sl.via_track_id IS NULL)     AS direct,
              sum(sl.amount) FILTER (WHERE sl.via_track_id IS NOT NULL) AS via_samples
       FROM statement_lines sl
       JOIN split_versions sv USING (version_id)
       JOIN statements s USING (statement_id)
       JOIN royalty_periods rp ON rp.period_id = s.period_id
       WHERE sv.track_id = $1
       GROUP BY rp.period_start ORDER BY rp.period_start`,
      [trackId],
    );

    return {
      track: track.rows[0],
      versions: versions.rows,
      upstream: upstream.rows,
      sampledBy: sampledBy.rows,
      monthly: monthly.rows,
      flags: flags.rows,
      paid: paid.rows,
    };
  });
}

export interface ShareInput {
  contributor_id: number;
  role: string;
  share_pct: number;
}

/** F1: create a proposal; the 100% rule and the date rules are checked by the database. */
export async function proposeSplit(actor: Actor, trackId: number, validFrom: string, shares: ShareInput[]) {
  return withTx(actor, async (c) => {
    const { rows } = await c.query<{ version_id: number }>(
      "SELECT propose_split_version($1, $2::date, $3::jsonb) AS version_id",
      [trackId, validFrom, JSON.stringify(shares)],
    );
    return rows[0];
  });
}

export async function withdrawProposal(actor: Actor, versionId: number) {
  return withTx(actor, async (c) => {
    const res = await c.query("DELETE FROM split_versions WHERE version_id = $1 AND status = 'proposed' RETURNING track_id", [
      versionId,
    ]);
    return { deleted: res.rowCount };
  });
}

/** First day of the month after the last paid period: the earliest a new split may start (R5). */
export async function earliestSplitStart(actor: Actor): Promise<string> {
  return withTx(actor, async (c) => {
    const { rows } = await c.query<{ d: string }>(
      `SELECT (coalesce(max(period_end), date_trunc('month', current_date)::date - 1) + 1)::text AS d
       FROM royalty_periods WHERE status = 'paid'`,
    );
    return rows[0].d;
  });
}

export async function contributorOptions(actor: Actor) {
  return withTx(actor, async (c) => {
    const { rows } = await c.query<{ contributor_id: number; label: string }>(
      `SELECT contributor_id, legal_name || coalesce(' (' || stage_name || ')', '') || ' · #' || contributor_id AS label
       FROM contributors ORDER BY legal_name`,
    );
    return rows;
  });
}

export async function listContributors(actor: Actor, q: string | undefined, page = 1) {
  const tsq = q ? prefixQuery(q) : null;
  return withTx(actor, async (c) => {
    const { rows } = await c.query(
      `SELECT c.contributor_id, c.legal_name, c.stage_name, c.email, c.pan IS NULL AS no_pan, c.tds_rate,
              (SELECT count(DISTINCT cs.track_id) FROM v_current_splits cs WHERE cs.contributor_id = c.contributor_id) AS tracks,
              (SELECT sum(s.net_payable) FROM statements s WHERE s.contributor_id = c.contributor_id) AS paid_total,
              fn_advance_outstanding(c.contributor_id) AS advance_outstanding,
              EXISTS (SELECT 1 FROM users u WHERE u.contributor_id = c.contributor_id) AS has_login,
              count(*) OVER () AS total
       FROM contributors c
       WHERE $1::text IS NULL OR c.search_vector @@ to_tsquery('simple', $1) OR c.email ILIKE $2
       ORDER BY paid_total DESC NULLS LAST, c.legal_name
       LIMIT ${PAGE_SIZE} OFFSET $3`,
      [tsq, q ? `%${q.trim()}%` : "", (Math.max(1, page) - 1) * PAGE_SIZE],
    );
    return { rows, total: Number(rows[0]?.total ?? 0), page: Math.max(1, page) };
  });
}

export async function getContributor(actor: Actor, contributorId: number) {
  return withTx(actor, async (c) => {
    const who = await c.query(
      `SELECT c.*, (SELECT u.email FROM users u WHERE u.contributor_id = c.contributor_id) AS login_email,
              fn_effective_tds_rate(c.contributor_id) AS effective_tds
       FROM contributors c WHERE c.contributor_id = $1`,
      [contributorId],
    );
    if (who.rowCount === 0) return null;
    const splits = await c.query(
      `SELECT cs.track_id, cs.title, cs.isrc, cs.role, cs.share_pct, cs.valid_from::text
       FROM v_current_splits cs WHERE cs.contributor_id = $1 ORDER BY cs.share_pct DESC, cs.title`,
      [contributorId],
    );
    const statements = await c.query(
      `SELECT * FROM v_contributor_earnings WHERE contributor_id = $1 ORDER BY period_start DESC`,
      [contributorId],
    );
    const advances = await c.query(`SELECT * FROM v_advance_balances WHERE contributor_id = $1 ORDER BY issued_on`, [
      contributorId,
    ]);
    const managers = await c.query(
      `SELECT u.full_name, p.name AS platform
       FROM contributor_managers cm JOIN users u USING (user_id)
       JOIN staff_platforms sp USING (user_id) JOIN platforms p USING (platform_id)
       WHERE cm.contributor_id = $1 ORDER BY p.name`,
      [contributorId],
    );
    return {
      contributor: who.rows[0],
      splits: splits.rows,
      statements: statements.rows,
      advances: advances.rows,
      managers: managers.rows,
    };
  });
}
