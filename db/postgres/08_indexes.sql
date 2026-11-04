-- =====================================================================
-- 08_indexes.sql — secondary indexes
--
-- Primary keys and UNIQUE constraints already have indexes. These are
-- added after the bulk load so the effect of each one can be measured
-- with EXPLAIN ANALYZE (docs/07-query-optimization.md, explain/compare.sql).
-- =====================================================================

-- ---------- the big table ----------
-- PK is (period_id, platform_id, track_id): good for "one period", useless
-- for "one track's history", which the fraud rules and track pages need.
CREATE INDEX IF NOT EXISTS ix_stream_stats_track_period ON stream_stats (track_id, period_id)
    INCLUDE (streams, revenue);          -- covering: answers the query from the index alone

-- ---------- foreign keys used in joins (Postgres doesn't index FKs itself) ----------
CREATE INDEX IF NOT EXISTS ix_tracks_release              ON tracks (release_id);
CREATE INDEX IF NOT EXISTS ix_split_versions_track        ON split_versions (track_id, valid_from);
CREATE INDEX IF NOT EXISTS ix_split_shares_contributor    ON split_shares (contributor_id);
CREATE INDEX IF NOT EXISTS ix_split_approvals_contributor ON split_approvals (contributor_id) WHERE decision = 'pending';
CREATE INDEX IF NOT EXISTS ix_samples_sampled             ON samples (sampled_track_id);
CREATE INDEX IF NOT EXISTS ix_track_genres_genre          ON track_genres (genre_id);
CREATE INDEX IF NOT EXISTS ix_track_platforms_platform    ON track_platforms (platform_id);
CREATE INDEX IF NOT EXISTS ix_advances_contributor        ON advances (contributor_id, issued_on);
CREATE INDEX IF NOT EXISTS ix_statements_contributor      ON statements (contributor_id, period_id);
CREATE INDEX IF NOT EXISTS ix_statement_lines_version     ON statement_lines (version_id);
CREATE INDEX IF NOT EXISTS ix_held_earnings_flag          ON held_earnings (flag_id);
CREATE INDEX IF NOT EXISTS ix_held_earnings_open          ON held_earnings (contributor_id) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS ix_fraud_flags_period          ON fraud_flags (period_id, status);
CREATE INDEX IF NOT EXISTS ix_unmatched_lines_period      ON unmatched_lines (period_id, status);

-- ---------- constraint enforced by a partial UNIQUE index ----------
-- at most one active split version per track
CREATE UNIQUE INDEX IF NOT EXISTS uq_split_versions_one_active
    ON split_versions (track_id) WHERE status = 'active';

-- ---------- full-text search (GIN) ----------
CREATE INDEX IF NOT EXISTS ix_tracks_search       ON tracks       USING gin (search_vector);
CREATE INDEX IF NOT EXISTS ix_contributors_search ON contributors USING gin (search_vector);

-- ---------- vector similarity search (HNSW, cosine distance) — F4 ----------
CREATE INDEX IF NOT EXISTS ix_track_embeddings_hnsw
    ON track_embeddings USING hnsw (embedding vector_cosine_ops);

-- ---------- audit lookups ----------
CREATE INDEX IF NOT EXISTS ix_audit_log_table_time ON audit_log (table_name, changed_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_log_tx         ON audit_log (tx_id);

VACUUM ANALYZE;   -- planner statistics + visibility map (enables index-only scans)
