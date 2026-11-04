-- =====================================================================
-- 01_schema.sql — tables, keys and declarative constraints
-- Music Royalty Split & Payout System (PostgreSQL 16 + pgvector)
--
-- Re-runnable: drops everything first. Business rules that need more
-- than a CHECK/UNIQUE/FK (R1–R15 in docs/02-relational-schema.md) are
-- added as triggers in 05_triggers.sql. Secondary indexes are added in
-- 08_indexes.sql so their effect can be measured with EXPLAIN ANALYZE.
-- =====================================================================

-- ---------- reset (DROP) ----------
DROP TABLE IF EXISTS
    audit_log, payments, statement_lines, statements, advance_recoupments,
    advances, held_earnings, fraud_flags, unmatched_lines, stream_stats,
    samples, split_approvals, split_shares, split_versions, royalty_periods,
    track_embeddings, track_platforms, track_genres, genres, tracks,
    releases, contributor_managers, staff_platforms, platforms, users,
    contributors
CASCADE;

CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector: VECTOR type + <=> operator
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- crypt()/gen_salt() for bcrypt hashes in seed data

-- =====================================================================
-- People and access
-- =====================================================================

CREATE TABLE contributors (
    contributor_id  INT GENERATED ALWAYS AS IDENTITY,
    legal_name      VARCHAR(120)  NOT NULL,
    stage_name      VARCHAR(120),
    email           VARCHAR(254)  NOT NULL,
    pan             CHAR(10),
    tds_rate        NUMERIC(5,2)  NOT NULL DEFAULT 10.00,
    search_vector   TSVECTOR GENERATED ALWAYS AS (
                        to_tsvector('simple', legal_name || ' ' || coalesce(stage_name, ''))
                    ) STORED,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT pk_contributors        PRIMARY KEY (contributor_id),
    CONSTRAINT uq_contributors_email  UNIQUE (email),
    CONSTRAINT uq_contributors_pan    UNIQUE (pan),
    CONSTRAINT chk_contributors_name  CHECK (length(trim(legal_name)) > 0),
    CONSTRAINT chk_contributors_email CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT chk_contributors_pan   CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
    CONSTRAINT chk_contributors_tds   CHECK (tds_rate BETWEEN 0 AND 100)
);

CREATE TABLE users (
    user_id         INT GENERATED ALWAYS AS IDENTITY,
    email           VARCHAR(254)  NOT NULL,
    password_hash   TEXT          NOT NULL,
    full_name       VARCHAR(120)  NOT NULL,
    role            VARCHAR(12)   NOT NULL,
    contributor_id  INT,
    is_active       BOOLEAN       NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT pk_users              PRIMARY KEY (user_id),
    CONSTRAINT uq_users_email        UNIQUE (email),
    CONSTRAINT uq_users_contributor  UNIQUE (contributor_id),
    CONSTRAINT fk_users_contributor  FOREIGN KEY (contributor_id)
        REFERENCES contributors (contributor_id) ON DELETE RESTRICT,
    CONSTRAINT chk_users_email       CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT chk_users_role        CHECK (role IN ('admin', 'staff', 'contributor')),
    -- only contributor logins point to a contributor, and they must
    CONSTRAINT chk_users_contributor_link
        CHECK ((role = 'contributor') = (contributor_id IS NOT NULL))
);

CREATE TABLE platforms (
    platform_id     INT GENERATED ALWAYS AS IDENTITY,
    code            VARCHAR(20)   NOT NULL,
    name            VARCHAR(60)   NOT NULL,

    CONSTRAINT pk_platforms       PRIMARY KEY (platform_id),
    CONSTRAINT uq_platforms_code  UNIQUE (code),
    CONSTRAINT uq_platforms_name  UNIQUE (name),
    CONSTRAINT chk_platforms_code CHECK (code ~ '^[A-Z_]+$')
);

-- BCNF decomposition of MANAGER (docs/04-normalization.md §4.7)
CREATE TABLE staff_platforms (
    user_id         INT NOT NULL,
    platform_id     INT NOT NULL,

    CONSTRAINT pk_staff_platforms          PRIMARY KEY (user_id),
    CONSTRAINT fk_staff_platforms_user     FOREIGN KEY (user_id)
        REFERENCES users (user_id) ON DELETE CASCADE,
    CONSTRAINT fk_staff_platforms_platform FOREIGN KEY (platform_id)
        REFERENCES platforms (platform_id) ON DELETE RESTRICT
);

CREATE TABLE contributor_managers (
    contributor_id  INT NOT NULL,
    user_id         INT NOT NULL,

    CONSTRAINT pk_contributor_managers      PRIMARY KEY (contributor_id, user_id),
    CONSTRAINT fk_contrib_managers_contrib  FOREIGN KEY (contributor_id)
        REFERENCES contributors (contributor_id) ON DELETE CASCADE,
    CONSTRAINT fk_contrib_managers_user     FOREIGN KEY (user_id)
        REFERENCES users (user_id) ON DELETE CASCADE
);

-- =====================================================================
-- Catalogue
-- =====================================================================

CREATE TABLE releases (
    release_id      INT GENERATED ALWAYS AS IDENTITY,
    upc             VARCHAR(13)   NOT NULL,
    title           VARCHAR(200)  NOT NULL,
    release_type    VARCHAR(10)   NOT NULL,
    release_date    DATE          NOT NULL,
    label_name      VARCHAR(100)  NOT NULL DEFAULT 'Monsoon Records',  -- v1.0 only; dropped in 04_migration_alter_drop.sql

    CONSTRAINT pk_releases      PRIMARY KEY (release_id),
    CONSTRAINT uq_releases_upc  UNIQUE (upc),
    CONSTRAINT chk_releases_upc CHECK (upc ~ '^[0-9]{12,13}$'),
    CONSTRAINT chk_releases_type CHECK (release_type IN ('single', 'ep', 'album'))
);

CREATE TABLE tracks (
    track_id        INT GENERATED ALWAYS AS IDENTITY,
    isrc            CHAR(12)      NOT NULL,
    title           VARCHAR(200)  NOT NULL,
    release_id      INT           NOT NULL,
    duration_sec    INT           NOT NULL,
    status          VARCHAR(10)   NOT NULL DEFAULT 'draft',
    search_vector   TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', title)) STORED,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT pk_tracks          PRIMARY KEY (track_id),
    CONSTRAINT uq_tracks_isrc     UNIQUE (isrc),
    CONSTRAINT fk_tracks_release  FOREIGN KEY (release_id)
        REFERENCES releases (release_id) ON DELETE RESTRICT,
    CONSTRAINT chk_tracks_isrc    CHECK (isrc ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$'),
    CONSTRAINT chk_tracks_duration CHECK (duration_sec BETWEEN 1 AND 3599),
    CONSTRAINT chk_tracks_status  CHECK (status IN ('draft', 'active', 'retired'))
);

CREATE TABLE genres (
    genre_id        INT GENERATED ALWAYS AS IDENTITY,
    name            VARCHAR(40)   NOT NULL,

    CONSTRAINT pk_genres      PRIMARY KEY (genre_id),
    CONSTRAINT uq_genres_name UNIQUE (name)
);

-- 4NF: multivalued attribute Track ->> Genre
CREATE TABLE track_genres (
    track_id        INT NOT NULL,
    genre_id        INT NOT NULL,

    CONSTRAINT pk_track_genres       PRIMARY KEY (track_id, genre_id),
    CONSTRAINT fk_track_genres_track FOREIGN KEY (track_id)
        REFERENCES tracks (track_id) ON DELETE CASCADE,
    CONSTRAINT fk_track_genres_genre FOREIGN KEY (genre_id)
        REFERENCES genres (genre_id) ON DELETE RESTRICT
);

-- 4NF: multivalued attribute Track ->> AvailableOn
CREATE TABLE track_platforms (
    track_id        INT  NOT NULL,
    platform_id     INT  NOT NULL,
    available_from  DATE NOT NULL,

    CONSTRAINT pk_track_platforms          PRIMARY KEY (track_id, platform_id),
    CONSTRAINT fk_track_platforms_track    FOREIGN KEY (track_id)
        REFERENCES tracks (track_id) ON DELETE CASCADE,
    CONSTRAINT fk_track_platforms_platform FOREIGN KEY (platform_id)
        REFERENCES platforms (platform_id) ON DELETE RESTRICT
);

-- Weak entity of Track (F4)
CREATE TABLE track_embeddings (
    track_id        INT          NOT NULL,
    embedding       VECTOR(384)  NOT NULL,
    source_text     TEXT         NOT NULL,
    model           VARCHAR(60)  NOT NULL,
    embedded_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT pk_track_embeddings       PRIMARY KEY (track_id),
    CONSTRAINT fk_track_embeddings_track FOREIGN KEY (track_id)
        REFERENCES tracks (track_id) ON DELETE CASCADE
);

-- =====================================================================
-- Revenue periods
-- =====================================================================

CREATE TABLE royalty_periods (
    period_id       INT GENERATED ALWAYS AS IDENTITY,
    period_start    DATE         NOT NULL,
    period_end      DATE         NOT NULL,
    status          VARCHAR(8)   NOT NULL DEFAULT 'open',
    processed_by    INT,
    processed_at    TIMESTAMPTZ,

    CONSTRAINT pk_royalty_periods        PRIMARY KEY (period_id),
    CONSTRAINT uq_royalty_periods_start  UNIQUE (period_start),
    CONSTRAINT fk_royalty_periods_user   FOREIGN KEY (processed_by)
        REFERENCES users (user_id) ON DELETE RESTRICT,
    -- one calendar month exactly
    CONSTRAINT chk_periods_month_start   CHECK (period_start = date_trunc('month', period_start)::date),
    CONSTRAINT chk_periods_month_end     CHECK (period_end = (period_start + INTERVAL '1 month - 1 day')::date),
    CONSTRAINT chk_periods_status        CHECK (status IN ('open', 'locked', 'paid')),
    CONSTRAINT chk_periods_paid          CHECK ((status = 'paid') = (processed_at IS NOT NULL)),
    CONSTRAINT chk_periods_processed_by  CHECK ((processed_by IS NULL) = (processed_at IS NULL))
);

-- =====================================================================
-- Ownership (F1 split versions, F2 samples)
-- =====================================================================

CREATE TABLE split_versions (
    version_id      INT GENERATED ALWAYS AS IDENTITY,
    track_id        INT          NOT NULL,
    valid_from      DATE         NOT NULL,
    valid_to        DATE,                        -- exclusive; NULL = open-ended
    status          VARCHAR(12)  NOT NULL DEFAULT 'proposed',
    proposed_by     INT          NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    activated_at    TIMESTAMPTZ,

    CONSTRAINT pk_split_versions        PRIMARY KEY (version_id),
    CONSTRAINT fk_split_versions_track  FOREIGN KEY (track_id)
        REFERENCES tracks (track_id) ON DELETE RESTRICT,
    CONSTRAINT fk_split_versions_user   FOREIGN KEY (proposed_by)
        REFERENCES users (user_id) ON DELETE RESTRICT,
    CONSTRAINT chk_split_versions_range CHECK (valid_to IS NULL OR valid_to > valid_from),
    CONSTRAINT chk_split_versions_status
        CHECK (status IN ('proposed', 'active', 'superseded', 'rejected')),
    CONSTRAINT chk_split_versions_activated
        CHECK ((status IN ('active', 'superseded')) = (activated_at IS NOT NULL)),
    -- the active version is open-ended; closing its range means superseding it
    CONSTRAINT chk_split_versions_active_open
        CHECK (status <> 'active' OR valid_to IS NULL)
);

-- Weak entity of SplitVersion
CREATE TABLE split_shares (
    version_id      INT           NOT NULL,
    contributor_id  INT           NOT NULL,
    role            VARCHAR(16)   NOT NULL,
    share_pct       NUMERIC(5,2)  NOT NULL,

    CONSTRAINT pk_split_shares         PRIMARY KEY (version_id, contributor_id, role),
    CONSTRAINT fk_split_shares_version FOREIGN KEY (version_id)
        REFERENCES split_versions (version_id) ON DELETE CASCADE,
    CONSTRAINT fk_split_shares_contrib FOREIGN KEY (contributor_id)
        REFERENCES contributors (contributor_id) ON DELETE RESTRICT,
    CONSTRAINT chk_split_shares_role
        CHECK (role IN ('artist', 'featured_artist', 'producer', 'songwriter', 'composer', 'lyricist')),
    CONSTRAINT chk_split_shares_pct    CHECK (share_pct > 0 AND share_pct <= 100)
);

CREATE TABLE split_approvals (
    version_id      INT          NOT NULL,
    contributor_id  INT          NOT NULL,
    decision        VARCHAR(10)  NOT NULL DEFAULT 'pending',
    decided_at      TIMESTAMPTZ,

    CONSTRAINT pk_split_approvals          PRIMARY KEY (version_id, contributor_id),
    CONSTRAINT fk_split_approvals_version  FOREIGN KEY (version_id)
        REFERENCES split_versions (version_id) ON DELETE CASCADE,
    CONSTRAINT fk_split_approvals_contrib  FOREIGN KEY (contributor_id)
        REFERENCES contributors (contributor_id) ON DELETE RESTRICT,
    CONSTRAINT chk_split_approvals_decision
        CHECK (decision IN ('pending', 'approved', 'rejected')),
    CONSTRAINT chk_split_approvals_decided
        CHECK ((decision = 'pending') = (decided_at IS NULL))
);

-- Recursive M:N relationship Track samples Track
CREATE TABLE samples (
    sampling_track_id INT           NOT NULL,
    sampled_track_id  INT           NOT NULL,
    upstream_pct      NUMERIC(5,2)  NOT NULL,
    cleared_on        DATE          NOT NULL,

    CONSTRAINT pk_samples           PRIMARY KEY (sampling_track_id, sampled_track_id),
    CONSTRAINT fk_samples_sampling  FOREIGN KEY (sampling_track_id)
        REFERENCES tracks (track_id) ON DELETE RESTRICT,
    CONSTRAINT fk_samples_sampled   FOREIGN KEY (sampled_track_id)
        REFERENCES tracks (track_id) ON DELETE RESTRICT,
    CONSTRAINT chk_samples_not_self CHECK (sampling_track_id <> sampled_track_id),
    CONSTRAINT chk_samples_pct      CHECK (upstream_pct > 0 AND upstream_pct < 100)
);

-- =====================================================================
-- Revenue intake (F3 fraud, F4 unmatched lines)
-- =====================================================================

-- Ternary relationship Track x Platform x Period. Largest table.
CREATE TABLE stream_stats (
    period_id         INT            NOT NULL,
    platform_id       INT            NOT NULL,
    track_id          INT            NOT NULL,
    streams           BIGINT         NOT NULL,
    revenue           NUMERIC(14,4)  NOT NULL,
    source_report_id  CHAR(24),                  -- MongoDB ObjectId (hex)

    CONSTRAINT pk_stream_stats          PRIMARY KEY (period_id, platform_id, track_id),
    CONSTRAINT fk_stream_stats_period   FOREIGN KEY (period_id)
        REFERENCES royalty_periods (period_id) ON DELETE RESTRICT,
    CONSTRAINT fk_stream_stats_platform FOREIGN KEY (platform_id)
        REFERENCES platforms (platform_id) ON DELETE RESTRICT,
    CONSTRAINT fk_stream_stats_track    FOREIGN KEY (track_id)
        REFERENCES tracks (track_id) ON DELETE RESTRICT,
    CONSTRAINT chk_stream_stats_streams CHECK (streams >= 0),
    CONSTRAINT chk_stream_stats_revenue CHECK (revenue >= 0)
);

CREATE TABLE unmatched_lines (
    line_id           BIGINT GENERATED ALWAYS AS IDENTITY,
    period_id         INT            NOT NULL,
    platform_id       INT            NOT NULL,
    raw_title         VARCHAR(300)   NOT NULL,
    raw_artist        VARCHAR(300),
    streams           BIGINT         NOT NULL,
    revenue           NUMERIC(14,4)  NOT NULL,
    source_report_id  CHAR(24)       NOT NULL,
    embedding         VECTOR(384),
    status            VARCHAR(12)    NOT NULL DEFAULT 'unmatched',
    matched_track_id  INT,
    matched_by        INT,
    matched_at        TIMESTAMPTZ,

    CONSTRAINT pk_unmatched_lines          PRIMARY KEY (line_id),
    CONSTRAINT fk_unmatched_lines_period   FOREIGN KEY (period_id)
        REFERENCES royalty_periods (period_id) ON DELETE RESTRICT,
    CONSTRAINT fk_unmatched_lines_platform FOREIGN KEY (platform_id)
        REFERENCES platforms (platform_id) ON DELETE RESTRICT,
    CONSTRAINT fk_unmatched_lines_track    FOREIGN KEY (matched_track_id)
        REFERENCES tracks (track_id) ON DELETE RESTRICT,
    CONSTRAINT fk_unmatched_lines_user     FOREIGN KEY (matched_by)
        REFERENCES users (user_id) ON DELETE RESTRICT,
    CONSTRAINT chk_unmatched_streams       CHECK (streams >= 0),
    CONSTRAINT chk_unmatched_revenue       CHECK (revenue >= 0),
    CONSTRAINT chk_unmatched_status        CHECK (status IN ('unmatched', 'matched', 'written_off')),
    CONSTRAINT chk_unmatched_track         CHECK ((status = 'matched') = (matched_track_id IS NOT NULL)),
    CONSTRAINT chk_unmatched_resolved      CHECK ((status = 'unmatched') = (matched_at IS NULL)),
    CONSTRAINT chk_unmatched_resolved_by   CHECK ((matched_by IS NULL) = (matched_at IS NULL))
);

CREATE TABLE fraud_flags (
    flag_id           INT GENERATED ALWAYS AS IDENTITY,
    track_id          INT            NOT NULL,
    period_id         INT            NOT NULL,
    platform_id       INT,
    rule              VARCHAR(24)    NOT NULL,
    observed_value    NUMERIC(12,4)  NOT NULL,
    threshold_value   NUMERIC(12,4)  NOT NULL,
    status            VARCHAR(10)    NOT NULL DEFAULT 'open',
    reviewed_by       INT,
    reviewed_at       TIMESTAMPTZ,
    note              TEXT,
    created_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),

    CONSTRAINT pk_fraud_flags              PRIMARY KEY (flag_id),
    CONSTRAINT uq_fraud_flags_track_rule   UNIQUE (track_id, period_id, rule),
    CONSTRAINT fk_fraud_flags_track        FOREIGN KEY (track_id)
        REFERENCES tracks (track_id) ON DELETE RESTRICT,
    CONSTRAINT fk_fraud_flags_period       FOREIGN KEY (period_id)
        REFERENCES royalty_periods (period_id) ON DELETE RESTRICT,
    CONSTRAINT fk_fraud_flags_platform     FOREIGN KEY (platform_id)
        REFERENCES platforms (platform_id) ON DELETE RESTRICT,
    CONSTRAINT fk_fraud_flags_reviewer     FOREIGN KEY (reviewed_by)
        REFERENCES users (user_id) ON DELETE RESTRICT,
    CONSTRAINT chk_fraud_flags_rule
        CHECK (rule IN ('stream_spike', 'platform_concentration')),
    CONSTRAINT chk_fraud_flags_platform
        CHECK ((rule = 'platform_concentration') = (platform_id IS NOT NULL)),
    CONSTRAINT chk_fraud_flags_status      CHECK (status IN ('open', 'cleared', 'confirmed')),
    CONSTRAINT chk_fraud_flags_reviewed    CHECK ((status = 'open') = (reviewed_at IS NULL)),
    CONSTRAINT chk_fraud_flags_reviewer    CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL))
);

-- =====================================================================
-- Payouts (F3 holds, F6 exact paise + TDS)
-- =====================================================================

CREATE TABLE held_earnings (
    hold_id                INT GENERATED ALWAYS AS IDENTITY,
    flag_id                INT            NOT NULL,
    contributor_id         INT            NOT NULL,
    period_id              INT            NOT NULL,
    amount                 NUMERIC(14,2)  NOT NULL,
    status                 VARCHAR(10)    NOT NULL DEFAULT 'held',
    released_in_period_id  INT,

    CONSTRAINT pk_held_earnings          PRIMARY KEY (hold_id),
    CONSTRAINT fk_held_earnings_flag     FOREIGN KEY (flag_id)
        REFERENCES fraud_flags (flag_id) ON DELETE RESTRICT,
    CONSTRAINT fk_held_earnings_contrib  FOREIGN KEY (contributor_id)
        REFERENCES contributors (contributor_id) ON DELETE RESTRICT,
    CONSTRAINT fk_held_earnings_period   FOREIGN KEY (period_id)
        REFERENCES royalty_periods (period_id) ON DELETE RESTRICT,
    CONSTRAINT fk_held_earnings_released FOREIGN KEY (released_in_period_id)
        REFERENCES royalty_periods (period_id) ON DELETE RESTRICT,
    CONSTRAINT chk_held_earnings_amount  CHECK (amount > 0),
    CONSTRAINT chk_held_earnings_status  CHECK (status IN ('held', 'released', 'forfeited')),
    CONSTRAINT chk_held_earnings_release
        CHECK ((status = 'released') = (released_in_period_id IS NOT NULL))
);

CREATE TABLE advances (
    advance_id      INT GENERATED ALWAYS AS IDENTITY,
    contributor_id  INT            NOT NULL,
    amount          NUMERIC(14,2)  NOT NULL,
    issued_on       DATE           NOT NULL,
    note            TEXT,

    CONSTRAINT pk_advances          PRIMARY KEY (advance_id),
    CONSTRAINT fk_advances_contrib  FOREIGN KEY (contributor_id)
        REFERENCES contributors (contributor_id) ON DELETE RESTRICT,
    CONSTRAINT chk_advances_amount  CHECK (amount > 0)
);

CREATE TABLE advance_recoupments (
    advance_id      INT            NOT NULL,
    period_id       INT            NOT NULL,
    amount          NUMERIC(14,2)  NOT NULL,

    CONSTRAINT pk_advance_recoupments        PRIMARY KEY (advance_id, period_id),
    CONSTRAINT fk_advance_recoupments_adv    FOREIGN KEY (advance_id)
        REFERENCES advances (advance_id) ON DELETE RESTRICT,
    CONSTRAINT fk_advance_recoupments_period FOREIGN KEY (period_id)
        REFERENCES royalty_periods (period_id) ON DELETE RESTRICT,
    CONSTRAINT chk_advance_recoupments_amount CHECK (amount > 0)
);

-- Immutable snapshot of what a contributor earned and was paid for a period
CREATE TABLE statements (
    statement_id      INT GENERATED ALWAYS AS IDENTITY,
    period_id         INT            NOT NULL,
    contributor_id    INT            NOT NULL,
    gross_earned      NUMERIC(14,2)  NOT NULL,
    held_amount       NUMERIC(14,2)  NOT NULL DEFAULT 0,
    released_amount   NUMERIC(14,2)  NOT NULL DEFAULT 0,
    recouped_amount   NUMERIC(14,2)  NOT NULL DEFAULT 0,
    tds_rate_applied  NUMERIC(5,2)   NOT NULL,
    tds_amount        NUMERIC(14,2)  NOT NULL DEFAULT 0,
    net_payable       NUMERIC(14,2)  NOT NULL,
    generated_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),

    CONSTRAINT pk_statements                PRIMARY KEY (statement_id),
    CONSTRAINT uq_statements_period_contrib UNIQUE (period_id, contributor_id),   -- R14
    CONSTRAINT fk_statements_period         FOREIGN KEY (period_id)
        REFERENCES royalty_periods (period_id) ON DELETE RESTRICT,
    CONSTRAINT fk_statements_contrib        FOREIGN KEY (contributor_id)
        REFERENCES contributors (contributor_id) ON DELETE RESTRICT,
    CONSTRAINT chk_statements_nonneg CHECK (
        gross_earned >= 0 AND held_amount >= 0 AND released_amount >= 0
        AND recouped_amount >= 0 AND tds_amount >= 0 AND net_payable >= 0),
    CONSTRAINT chk_statements_tds_rate CHECK (tds_rate_applied BETWEEN 0 AND 100),
    CONSTRAINT chk_statements_net CHECK (
        net_payable = gross_earned - held_amount + released_amount - recouped_amount - tds_amount)
);

-- Weak entity of Statement
CREATE TABLE statement_lines (
    statement_id    INT            NOT NULL,
    line_no         SMALLINT       NOT NULL,
    version_id      INT            NOT NULL,
    role            VARCHAR(16)    NOT NULL,
    via_track_id    INT,                         -- origin track when earned through a sample chain
    amount          NUMERIC(14,2)  NOT NULL,
    is_held         BOOLEAN        NOT NULL DEFAULT false,

    CONSTRAINT pk_statement_lines           PRIMARY KEY (statement_id, line_no),
    CONSTRAINT fk_statement_lines_statement FOREIGN KEY (statement_id)
        REFERENCES statements (statement_id) ON DELETE CASCADE,
    CONSTRAINT fk_statement_lines_version   FOREIGN KEY (version_id)
        REFERENCES split_versions (version_id) ON DELETE RESTRICT,
    CONSTRAINT fk_statement_lines_via       FOREIGN KEY (via_track_id)
        REFERENCES tracks (track_id) ON DELETE RESTRICT,
    CONSTRAINT chk_statement_lines_no       CHECK (line_no > 0),
    CONSTRAINT chk_statement_lines_amount   CHECK (amount >= 0)
);

CREATE TABLE payments (
    payment_id      INT GENERATED ALWAYS AS IDENTITY,
    statement_id    INT            NOT NULL,
    amount          NUMERIC(14,2)  NOT NULL,
    paid_at         TIMESTAMPTZ    NOT NULL DEFAULT now(),
    reference       VARCHAR(40)    NOT NULL,

    CONSTRAINT pk_payments            PRIMARY KEY (payment_id),
    CONSTRAINT uq_payments_statement  UNIQUE (statement_id),                      -- R14
    CONSTRAINT uq_payments_reference  UNIQUE (reference),
    CONSTRAINT fk_payments_statement  FOREIGN KEY (statement_id)
        REFERENCES statements (statement_id) ON DELETE RESTRICT,
    CONSTRAINT chk_payments_amount    CHECK (amount > 0)
);

-- =====================================================================
-- Audit (written only by triggers; no FKs on purpose)
-- =====================================================================

CREATE TABLE audit_log (
    audit_id        BIGINT GENERATED ALWAYS AS IDENTITY,
    table_name      VARCHAR(63)  NOT NULL,
    operation       VARCHAR(6)   NOT NULL,
    row_key         JSONB        NOT NULL,
    old_row         JSONB,
    new_row         JSONB,
    changed_by      INT,
    changed_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    tx_id           BIGINT       NOT NULL DEFAULT txid_current(),

    CONSTRAINT pk_audit_log           PRIMARY KEY (audit_id),
    CONSTRAINT chk_audit_log_operation CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    CONSTRAINT chk_audit_log_rows CHECK (
        (operation = 'INSERT' AND old_row IS NULL AND new_row IS NOT NULL) OR
        (operation = 'UPDATE' AND old_row IS NOT NULL AND new_row IS NOT NULL) OR
        (operation = 'DELETE' AND old_row IS NOT NULL AND new_row IS NULL))
);
