-- =====================================================================
-- 06_functions.sql — functions and procedures the application calls
--
--   fn_version_at            split version in effect on a date (F1)
--   fn_advance_outstanding   unrecouped advance balance
--   fn_effective_tds_rate    TDS rate incl. the no-PAN rule (F6)
--   search_catalogue         full-text search over tracks + contributors
--   propose_split_version    create a proposal with its shares (F1)
--   approve_split            a contributor approves/rejects (F1)
--   detect_fraud             window-function fraud rules (F3)
--   confirm_unmatched_line   assign a matched report line (F4)
--   write_off_unmatched_line
--   process_payout           THE payout transaction (F1, F2, F3, F6)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Split version in effect on a date (live versions never overlap: R2)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_version_at(p_track_id INT, p_on DATE) RETURNS INT
LANGUAGE sql STABLE AS $$
    SELECT version_id
    FROM split_versions
    WHERE track_id = p_track_id
      AND status IN ('active', 'superseded')
      AND valid_from <= p_on
      AND (valid_to IS NULL OR valid_to > p_on)
$$;

-- ---------------------------------------------------------------------
-- Outstanding (unrecouped) advances for a contributor
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_advance_outstanding(p_contributor_id INT) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT coalesce(sum(a.amount - coalesce(r.recouped, 0)), 0)
    FROM advances a
    LEFT JOIN (SELECT advance_id, sum(amount) AS recouped
               FROM advance_recoupments GROUP BY advance_id) r USING (advance_id)
    WHERE a.contributor_id = p_contributor_id
$$;

-- ---------------------------------------------------------------------
-- F6: contributors without a PAN are withheld at no less than 20%
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_effective_tds_rate(p_contributor_id INT) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN pan IS NULL THEN greatest(tds_rate, 20.00) ELSE tds_rate END
    FROM contributors
    WHERE contributor_id = p_contributor_id
$$;

-- ---------------------------------------------------------------------
-- Full-text search with prefix matching ("mons let" finds "Monsoon Letters")
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_catalogue(p_query TEXT, p_limit INT DEFAULT 20)
RETURNS TABLE (kind TEXT, id INT, label TEXT, detail TEXT, rank REAL)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tsq TSQUERY;
BEGIN
    SELECT to_tsquery('simple', string_agg(quote_literal(w) || ':*', ' & '))
    INTO v_tsq
    FROM regexp_split_to_table(lower(trim(p_query)), '[^[:alnum:]]+') AS w
    WHERE w <> '';

    IF v_tsq IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT * FROM (
        SELECT 'track'::text, t.track_id, t.title::text, t.isrc::text, ts_rank(t.search_vector, v_tsq)
        FROM tracks t WHERE t.search_vector @@ v_tsq
        UNION ALL
        SELECT 'contributor', c.contributor_id, c.legal_name::text,
               coalesce(c.stage_name, '')::text, ts_rank(c.search_vector, v_tsq)
        FROM contributors c WHERE c.search_vector @@ v_tsq
    ) AS hits
    ORDER BY 5 DESC, 3
    LIMIT p_limit;
END $$;

-- ---------------------------------------------------------------------
-- F1: propose a new split version in one call.
-- p_shares: [{"contributor_id": 1, "role": "artist", "share_pct": 60}, ...]
-- The 100% check (R1) is forced to run now so the caller gets the error
-- immediately instead of at COMMIT.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION propose_split_version(p_track_id INT, p_valid_from DATE, p_shares JSONB)
RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
    v_version_id INT;
BEGIN
    INSERT INTO split_versions (track_id, valid_from, proposed_by)
    VALUES (p_track_id, p_valid_from, app_user_id())
    RETURNING version_id INTO v_version_id;

    INSERT INTO split_shares (version_id, contributor_id, role, share_pct)
    SELECT v_version_id, x.contributor_id, x.role, x.share_pct
    FROM jsonb_to_recordset(p_shares) AS x(contributor_id INT, role VARCHAR, share_pct NUMERIC);

    SET CONSTRAINTS r1_split_shares_total, r1_split_versions_have_shares IMMEDIATE;
    SET CONSTRAINTS r1_split_shares_total, r1_split_versions_have_shares DEFERRED;

    RETURN v_version_id;
END $$;

-- ---------------------------------------------------------------------
-- F1: the logged-in contributor approves or rejects a proposal.
-- SECURITY DEFINER: contributors have no direct table access; the
-- function only ever touches the caller's own approval row.
-- Returns the version's status afterwards (activated on the last approval).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION approve_split(p_version_id INT, p_decision TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_contributor INT;
    v_status      TEXT;
BEGIN
    SELECT contributor_id INTO v_contributor
    FROM users WHERE user_id = app_user_id() AND is_active;
    IF v_contributor IS NULL THEN
        RAISE EXCEPTION 'Only a signed-in contributor can approve splits' USING ERRCODE = '42501';
    END IF;
    IF p_decision NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'Decision must be approved or rejected' USING ERRCODE = '22023';
    END IF;

    UPDATE split_approvals
    SET decision = p_decision
    WHERE version_id = p_version_id AND contributor_id = v_contributor;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'You are not on split version %', p_version_id USING ERRCODE = '42501';
    END IF;

    SELECT status INTO v_status FROM split_versions WHERE version_id = p_version_id;
    RETURN v_status;
END $$;

-- ---------------------------------------------------------------------
-- F3: fraud detection for one period. Returns the number of new flags.
--   stream_spike            this month's total is more than p_z standard
--                           deviations above the track's own history
--                           (window over earlier months) and > 2x last month
--   platform_concentration  one platform has more than p_share of the
--                           track's streams (GROUP BY ... HAVING) and more
--                           than twice its usual share (window average)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION detect_fraud(p_period_id INT, p_z NUMERIC DEFAULT 4, p_share NUMERIC DEFAULT 0.75)
RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
    v_start DATE;
    v_spikes INT;
    v_concentrated INT;
BEGIN
    SELECT period_start INTO v_start FROM royalty_periods WHERE period_id = p_period_id;

    INSERT INTO fraud_flags (track_id, period_id, rule, observed_value, threshold_value)
    SELECT track_id, period_id, 'stream_spike', round((streams - hist_avg) / hist_sd, 4), p_z
    FROM (
        SELECT tp.*,
               avg(streams)         OVER w AS hist_avg,
               stddev_samp(streams) OVER w AS hist_sd,
               count(*)             OVER w AS hist_n,
               lag(streams) OVER (PARTITION BY track_id ORDER BY period_start) AS prev_streams
        FROM (
            SELECT s.track_id, s.period_id, rp.period_start, sum(s.streams) AS streams
            FROM stream_stats s
            JOIN royalty_periods rp USING (period_id)
            WHERE rp.period_start <= v_start
            GROUP BY s.track_id, s.period_id, rp.period_start
        ) AS tp
        WINDOW w AS (PARTITION BY track_id ORDER BY period_start
                     ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
    ) AS h
    WHERE period_id = p_period_id
      AND hist_n >= 3
      AND hist_sd > 0
      AND streams >= 1000
      AND (streams - hist_avg) / hist_sd > p_z
      AND streams > 2 * prev_streams
    ON CONFLICT (track_id, period_id, rule) DO NOTHING;
    GET DIAGNOSTICS v_spikes = ROW_COUNT;

    INSERT INTO fraud_flags (track_id, period_id, platform_id, rule, observed_value, threshold_value)
    SELECT cur.track_id, p_period_id, cur.platform_id, 'platform_concentration', round(cur.share, 4), p_share
    FROM (
        -- this period: tracks where one platform dominates
        SELECT s.track_id, s.platform_id,
               s.streams::numeric / t.total AS share
        FROM stream_stats s
        JOIN (SELECT track_id, sum(streams) AS total
              FROM stream_stats
              WHERE period_id = p_period_id
              GROUP BY track_id
              HAVING sum(streams) >= 1000
                 AND max(streams)::numeric / sum(streams) > p_share) AS t USING (track_id)
        WHERE s.period_id = p_period_id
          AND s.streams::numeric / t.total > p_share
    ) AS cur
    JOIN (
        -- that platform's usual share of the track in earlier months
        SELECT track_id, platform_id, avg(share) AS usual_share
        FROM (SELECT s.track_id, s.platform_id,
                     s.streams::numeric / nullif(sum(s.streams) OVER (PARTITION BY s.track_id, s.period_id), 0) AS share
              FROM stream_stats s
              JOIN royalty_periods rp USING (period_id)
              WHERE rp.period_start < v_start) AS past
        GROUP BY track_id, platform_id
    ) AS hist USING (track_id, platform_id)
    WHERE cur.share > 2 * hist.usual_share
    ON CONFLICT (track_id, period_id, rule) DO NOTHING;
    GET DIAGNOSTICS v_concentrated = ROW_COUNT;

    RETURN v_spikes + v_concentrated;
END $$;

-- ---------------------------------------------------------------------
-- F4: staff confirm which track an unmatched report line belongs to.
-- Adds the line's streams and revenue to that track (upsert), in the
-- same transaction as marking the line matched.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION confirm_unmatched_line(p_line_id BIGINT, p_track_id INT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_line unmatched_lines%ROWTYPE;
BEGIN
    SELECT * INTO v_line FROM unmatched_lines WHERE line_id = p_line_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unmatched line % does not exist' , p_line_id USING ERRCODE = 'P0002';
    END IF;
    IF v_line.status <> 'unmatched' THEN
        RAISE EXCEPTION 'Line % is already %', p_line_id, v_line.status USING ERRCODE = '55000';
    END IF;

    UPDATE unmatched_lines
    SET status = 'matched', matched_track_id = p_track_id,
        matched_by = app_user_id(), matched_at = now()
    WHERE line_id = p_line_id;

    INSERT INTO stream_stats (period_id, platform_id, track_id, streams, revenue, source_report_id)
    VALUES (v_line.period_id, v_line.platform_id, p_track_id, v_line.streams, v_line.revenue, v_line.source_report_id)
    ON CONFLICT (period_id, platform_id, track_id) DO UPDATE
    SET streams = stream_stats.streams + EXCLUDED.streams,
        revenue = stream_stats.revenue + EXCLUDED.revenue;
END $$;

CREATE OR REPLACE FUNCTION write_off_unmatched_line(p_line_id BIGINT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE unmatched_lines
    SET status = 'written_off', matched_by = app_user_id(), matched_at = now()
    WHERE line_id = p_line_id AND status = 'unmatched';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Line % is not an open unmatched line', p_line_id USING ERRCODE = '55000';
    END IF;
END $$;

-- =====================================================================
-- process_payout — pays one royalty period, all or nothing.
--
--  1. Lock the period row (SELECT ... FOR UPDATE). A second payout of the
--     same period waits here, then finds it already paid (R14).
--  2. Run fraud detection (F3).
--  3. Revenue per track, pushed up the sample chain (F2, recursive CTE):
--     each track keeps (1 - its upstream %) of what reaches it.
--  4. Allocate what each track keeps through the split version in effect
--     at the period end (F1), rounding to exact paise with the largest-
--     remainder method so every track's revenue is paid out to the paisa (F6).
--  5. Lines from flagged tracks are held; earlier holds whose flag was
--     cleared are released (F3).
--  6. Recoup advances oldest-first (running total, window function).
--  7. Withhold TDS, write statements, lines and payments, mark paid.
--
-- Call:  CALL process_payout(<period_id>);  with app.user_id set.
-- =====================================================================
CREATE OR REPLACE PROCEDURE process_payout(
    p_period_id      INT,
    INOUT o_statements INT     DEFAULT NULL,
    INOUT o_gross      NUMERIC DEFAULT NULL,
    INOUT o_held       NUMERIC DEFAULT NULL,
    INOUT o_net_paid   NUMERIC DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE
    v_period  royalty_periods%ROWTYPE;
    v_user    INT := app_user_id();
    v_missing TEXT;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'process_payout needs the acting admin (set app.user_id)' USING ERRCODE = '42501';
    END IF;

    -- 1. lock ----------------------------------------------------------
    SELECT * INTO v_period FROM royalty_periods WHERE period_id = p_period_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Period % does not exist', p_period_id USING ERRCODE = 'P0002';
    END IF;
    IF v_period.status = 'paid' THEN
        RAISE EXCEPTION 'Period % (%) has already been paid', p_period_id, to_char(v_period.period_start, 'Mon YYYY')
            USING ERRCODE = '55000', CONSTRAINT = 'r14_period_paid_once';
    END IF;
    IF v_period.status <> 'locked' THEN
        RAISE EXCEPTION 'Lock period % before paying it, so no report data changes mid-payout', p_period_id
            USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM royalty_periods
               WHERE period_start < v_period.period_start AND status <> 'paid') THEN
        RAISE EXCEPTION 'Earlier periods must be paid first' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM unmatched_lines
               WHERE period_id = p_period_id AND status = 'unmatched') THEN
        RAISE EXCEPTION 'Period % still has unmatched report lines; match or write them off first', p_period_id
            USING ERRCODE = '55000';
    END IF;

    -- 2. fraud ---------------------------------------------------------
    PERFORM detect_fraud(p_period_id);

    -- 3 + 4. exact allocation per contributor line ----------------------
    -- (temp tables are created empty, then filled with INSERT ... SELECT so
    --  the PL/pgSQL variables can be used inside the queries)
    IF to_regclass('pg_temp.payout_lines') IS NOT NULL THEN       -- second call in one transaction
        DROP TABLE pg_temp.payout_lines, pg_temp.payout_totals, pg_temp.payout_recoup;
    END IF;

    CREATE TEMP TABLE payout_lines (
        origin_track_id INT, track_id INT, version_id INT, contributor_id INT,
        role VARCHAR(16), held_flag_id INT, exact_paise NUMERIC, amount NUMERIC(14,2)
    ) ON COMMIT DROP;

    INSERT INTO payout_lines (origin_track_id, track_id, version_id, contributor_id, role, held_flag_id, exact_paise)
    WITH RECURSIVE
    track_revenue AS (
        SELECT track_id, round(sum(revenue), 2) AS revenue
        FROM stream_stats
        WHERE period_id = p_period_id
        GROUP BY track_id
        HAVING round(sum(revenue), 2) > 0
    ),
    upstream_total AS (
        SELECT sampling_track_id AS track_id, sum(upstream_pct) / 100 AS upstream_fraction
        FROM samples GROUP BY sampling_track_id
    ),
    flow (origin_track_id, track_id, amount, path) AS (
        SELECT track_id, track_id, revenue, ARRAY[track_id] FROM track_revenue
      UNION ALL
        SELECT f.origin_track_id, s.sampled_track_id, f.amount * s.upstream_pct / 100,
               f.path || s.sampled_track_id
        FROM flow f
        JOIN samples s ON s.sampling_track_id = f.track_id
        WHERE s.sampled_track_id <> ALL (f.path)              -- cycle guard (R7 prevents them anyway)
    ),
    kept AS (
        SELECT f.origin_track_id, f.track_id,
               f.amount * (1 - coalesce(u.upstream_fraction, 0)) AS amount
        FROM flow f
        LEFT JOIN upstream_total u USING (track_id)
    )
    SELECT k.origin_track_id, k.track_id, sv.version_id, ss.contributor_id, ss.role,
           (SELECT min(ff.flag_id) FROM fraud_flags ff
            WHERE ff.track_id = k.origin_track_id
              AND ff.period_id = p_period_id
              AND ff.status = 'open'),
           k.amount * ss.share_pct                               -- = amount * pct/100, in paise
    FROM kept k
    LEFT JOIN split_versions sv                                   -- version in effect at period end
           ON sv.track_id = k.track_id
          AND sv.status IN ('active', 'superseded')
          AND sv.valid_from <= v_period.period_end
          AND (sv.valid_to IS NULL OR sv.valid_to > v_period.period_end)
    LEFT JOIN split_shares ss ON ss.version_id = sv.version_id;

    SELECT string_agg(DISTINCT t.isrc, ', ') INTO v_missing
    FROM payout_lines l JOIN tracks t USING (track_id)
    WHERE l.version_id IS NULL;
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'No split version in effect for: %', v_missing USING ERRCODE = '23514';
    END IF;

    -- Largest remainder: floor every line to whole paise, then hand the
    -- leftover paise of each origin track, one each, to its lines with the
    -- largest fractional parts. Each track's revenue is paid to the paisa.
    UPDATE payout_lines l
    SET amount = ((r.base_paise + CASE WHEN r.rnk <= r.leftover THEN 1 ELSE 0 END) / 100)::numeric(14,2)
    FROM (
        SELECT origin_track_id, track_id, contributor_id, role, base_paise,
               round(sum(exact_paise) OVER o) - sum(base_paise) OVER o AS leftover,
               row_number() OVER (PARTITION BY origin_track_id
                                  ORDER BY exact_paise - base_paise DESC, contributor_id, role, track_id) AS rnk
        FROM (SELECT *, floor(exact_paise) AS base_paise FROM payout_lines) f
        WINDOW o AS (PARTITION BY origin_track_id)
    ) r
    WHERE l.origin_track_id = r.origin_track_id AND l.track_id = r.track_id
      AND l.contributor_id = r.contributor_id AND l.role = r.role;

    -- 5. what each contributor can be paid --------------------------------
    CREATE TEMP TABLE payout_totals (
        contributor_id INT PRIMARY KEY, gross NUMERIC(14,2), held NUMERIC(14,2),
        released NUMERIC(14,2), available NUMERIC(14,2),
        recouped NUMERIC(14,2) DEFAULT 0, tds_rate NUMERIC(5,2)
    ) ON COMMIT DROP;

    INSERT INTO payout_totals (contributor_id, gross, held, released, available, tds_rate)
    SELECT contributor_id, gross, held, released, gross - held + released,
           fn_effective_tds_rate(contributor_id)
    FROM (
        SELECT coalesce(e.contributor_id, r.contributor_id) AS contributor_id,
               coalesce(e.gross, 0) AS gross, coalesce(e.held, 0) AS held,
               coalesce(r.released, 0) AS released
        FROM (SELECT contributor_id, sum(amount) AS gross,
                     coalesce(sum(amount) FILTER (WHERE held_flag_id IS NOT NULL), 0) AS held
              FROM payout_lines GROUP BY contributor_id) e
        FULL OUTER JOIN
             (SELECT h.contributor_id, sum(h.amount) AS released     -- earlier holds now cleared
              FROM held_earnings h JOIN fraud_flags f USING (flag_id)
              WHERE h.status = 'held' AND f.status = 'cleared'
              GROUP BY h.contributor_id) r
        USING (contributor_id)
    ) x
    WHERE gross > 0 OR released > 0;

    -- 6. recoup advances, oldest first --------------------------------------
    CREATE TEMP TABLE payout_recoup (advance_id INT, contributor_id INT, take NUMERIC(14,2)) ON COMMIT DROP;

    INSERT INTO payout_recoup (advance_id, contributor_id, take)
    SELECT advance_id, contributor_id, take
    FROM (
        SELECT o.advance_id, o.contributor_id,
               -- what is left after older advances took their share (running total)
               least(o.outstanding,
                     greatest(t.available
                              - (sum(o.outstanding) OVER (PARTITION BY o.contributor_id
                                                          ORDER BY o.issued_on, o.advance_id)
                                 - o.outstanding), 0)) AS take
        FROM (SELECT a.advance_id, a.contributor_id, a.issued_on,
                     a.amount - coalesce((SELECT sum(r.amount) FROM advance_recoupments r
                                          WHERE r.advance_id = a.advance_id), 0) AS outstanding
              FROM advances a
              WHERE a.issued_on <= v_period.period_end) o
        JOIN payout_totals t USING (contributor_id)
        WHERE o.outstanding > 0
    ) x
    WHERE take > 0;

    UPDATE payout_totals t
    SET recouped = r.total
    FROM (SELECT contributor_id, sum(take) AS total FROM payout_recoup GROUP BY contributor_id) r
    WHERE t.contributor_id = r.contributor_id;

    INSERT INTO advance_recoupments (advance_id, period_id, amount)
    SELECT advance_id, p_period_id, take FROM payout_recoup;

    -- 7. statements, lines, holds, payments -----------------------------------
    INSERT INTO statements (period_id, contributor_id, gross_earned, held_amount, released_amount,
                            recouped_amount, tds_rate_applied, tds_amount, net_payable)
    SELECT p_period_id, contributor_id, gross, held, released, recouped, tds_rate, tds,
           available - recouped - tds
    FROM (SELECT t.*, round((t.available - t.recouped) * t.tds_rate / 100, 2) AS tds
          FROM payout_totals t) x;

    INSERT INTO statement_lines (statement_id, line_no, version_id, role, via_track_id, amount, is_held)
    SELECT s.statement_id,
           row_number() OVER (PARTITION BY s.statement_id
                              ORDER BY l.amount DESC, l.version_id, l.role, l.origin_track_id),
           l.version_id, l.role,
           nullif(l.origin_track_id, l.track_id),
           l.amount,
           l.held_flag_id IS NOT NULL
    FROM payout_lines l
    JOIN statements s ON s.period_id = p_period_id AND s.contributor_id = l.contributor_id
    WHERE l.amount > 0;

    UPDATE held_earnings h                                   -- release before adding new holds
    SET status = 'released', released_in_period_id = p_period_id
    FROM fraud_flags f
    WHERE h.flag_id = f.flag_id AND h.status = 'held' AND f.status = 'cleared';

    INSERT INTO held_earnings (flag_id, contributor_id, period_id, amount)
    SELECT held_flag_id, contributor_id, p_period_id, sum(amount)
    FROM payout_lines
    WHERE held_flag_id IS NOT NULL
    GROUP BY held_flag_id, contributor_id
    HAVING sum(amount) > 0;

    INSERT INTO payments (statement_id, amount, reference)
    SELECT statement_id, net_payable,
           'UTR' || to_char(v_period.period_start, 'YYYYMM') || lpad(statement_id::text, 8, '0')
    FROM statements
    WHERE period_id = p_period_id AND net_payable > 0;

    UPDATE royalty_periods
    SET status = 'paid', processed_by = v_user, processed_at = now()
    WHERE period_id = p_period_id;

    SELECT count(*), sum(gross_earned), sum(held_amount), sum(net_payable)
    INTO o_statements, o_gross, o_held, o_net_paid
    FROM statements WHERE period_id = p_period_id;
END $$;

-- ---------------------------------------------------------------------
-- Login. The bcrypt hash never leaves the database: the password is
-- checked here with pgcrypto's crypt(), and only the identity comes back.
-- SECURITY DEFINER so the login role needs no access to users at all.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION authenticate(p_email TEXT, p_password TEXT)
RETURNS TABLE (user_id INT, role VARCHAR, contributor_id INT, full_name VARCHAR)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT u.user_id, u.role, u.contributor_id, u.full_name
    FROM users u
    WHERE u.email = lower(trim(p_email))
      AND u.is_active
      AND u.password_hash = crypt(p_password, u.password_hash)
$$;
