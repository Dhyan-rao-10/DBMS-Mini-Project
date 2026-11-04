-- =====================================================================
-- explain_compare.sql — the same query with and without its index
--
-- DROP INDEX is transactional in PostgreSQL, so each "without" plan is
-- taken inside BEGIN ... ROLLBACK: the index is back afterwards.
-- Run:  docker exec royalty-postgres psql -U royalty_admin -d royalty -f /sql/explain_compare.sql
-- Results are written up in docs/07-query-optimization.md.
-- =====================================================================

\pset pager off
SELECT track_id AS t FROM tracks WHERE isrc = 'INB0K2401234' \gset
SELECT max(version_id) AS v FROM split_versions WHERE status = 'active' \gset

\echo '=================== Q1: one track''s monthly history (2.1 lakh-row stream_stats) ==================='
\echo '--- with ix_stream_stats_track_period'
EXPLAIN (ANALYZE, BUFFERS)
SELECT rp.period_start, sum(s.streams) AS streams, sum(s.revenue) AS revenue
FROM stream_stats s JOIN royalty_periods rp USING (period_id)
WHERE s.track_id = :t
GROUP BY rp.period_start ORDER BY rp.period_start;

BEGIN;
DROP INDEX ix_stream_stats_track_period;
\echo '--- without it'
EXPLAIN (ANALYZE, BUFFERS)
SELECT rp.period_start, sum(s.streams) AS streams, sum(s.revenue) AS revenue
FROM stream_stats s JOIN royalty_periods rp USING (period_id)
WHERE s.track_id = :t
GROUP BY rp.period_start ORDER BY rp.period_start;
ROLLBACK;

\echo '=================== Q2: lines paid through one split version (1.15 lakh-row statement_lines) ==================='
\echo '--- with ix_statement_lines_version'
EXPLAIN (ANALYZE, BUFFERS)
SELECT s.period_id, sum(sl.amount)
FROM statement_lines sl JOIN statements s USING (statement_id)
WHERE sl.version_id = :v
GROUP BY s.period_id;

BEGIN;
DROP INDEX ix_statement_lines_version;
\echo '--- without it'
EXPLAIN (ANALYZE, BUFFERS)
SELECT s.period_id, sum(sl.amount)
FROM statement_lines sl JOIN statements s USING (statement_id)
WHERE sl.version_id = :v
GROUP BY s.period_id;
ROLLBACK;

\echo '=================== Q3: full-text prefix search on track titles ==================='
\echo '--- with GIN ix_tracks_search'
EXPLAIN (ANALYZE, BUFFERS)
SELECT track_id, title FROM tracks
WHERE search_vector @@ to_tsquery('simple', 'monsoon:* & letter:*');

BEGIN;
DROP INDEX ix_tracks_search;
\echo '--- without it'
EXPLAIN (ANALYZE, BUFFERS)
SELECT track_id, title FROM tracks
WHERE search_vector @@ to_tsquery('simple', 'monsoon:* & letter:*');
ROLLBACK;

\echo '=================== Q4: top 10 earners of a period (join + group + sort, no single index fixes it) ==================='
EXPLAIN (ANALYZE, BUFFERS)
SELECT c.legal_name, sum(s.gross_earned) AS earned
FROM statements s JOIN contributors c USING (contributor_id)
WHERE s.period_id BETWEEN 1 AND 11
GROUP BY c.legal_name
HAVING sum(s.gross_earned) > 100000
ORDER BY earned DESC
LIMIT 10;
