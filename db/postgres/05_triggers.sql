-- =====================================================================
-- 05_triggers.sql — business rules a CHECK/UNIQUE/FK cannot express
--
-- Rule numbers R1..R15 match docs/02-relational-schema.md §2.3.
-- Runs after the seed and bulk data, so the rules (and the audit
-- trail) apply to every change made from now on.
--
-- Errors use standard SQLSTATEs so the API can map them:
--   23514 check_violation         a business rule was broken
--   55000 object_not_in_prerequisite_state   wrong lifecycle state
-- =====================================================================

-- ---------------------------------------------------------------------
-- Who is making the change: the API runs SET LOCAL app.user_id = '<id>'
-- at the start of every transaction. NULL for direct psql sessions.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_user_id() RETURNS INT
LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.user_id', true), '')::int
$$;

-- =====================================================================
-- R1  A split version's shares total exactly 100.00%
--     Deferred to COMMIT: shares are inserted one row at a time, so the
--     total is only meaningful once the whole transaction is done.
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_check_split_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_version INT;
    v_total   NUMERIC;
BEGIN
    FOR v_version IN
        SELECT DISTINCT x FROM unnest(ARRAY[
            CASE WHEN TG_TABLE_NAME = 'split_versions' THEN NEW.version_id
                 WHEN TG_OP <> 'DELETE' THEN NEW.version_id END,
            CASE WHEN TG_TABLE_NAME = 'split_shares' AND TG_OP <> 'INSERT' THEN OLD.version_id END
        ]) AS x WHERE x IS NOT NULL
    LOOP
        -- the version itself may have been deleted (cascade) in the same transaction
        CONTINUE WHEN NOT EXISTS (SELECT 1 FROM split_versions WHERE version_id = v_version);

        SELECT sum(share_pct) INTO v_total FROM split_shares WHERE version_id = v_version;
        IF v_total IS DISTINCT FROM 100.00 THEN
            RAISE EXCEPTION 'Split version % totals %, must be exactly 100%%',
                            v_version, coalesce(v_total, 0) || '%'
                USING ERRCODE = '23514', CONSTRAINT = 'r1_split_total_100';
        END IF;
    END LOOP;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER r1_split_shares_total
    AFTER INSERT OR UPDATE OR DELETE ON split_shares
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_check_split_total();

-- a version created without any shares is caught too
CREATE CONSTRAINT TRIGGER r1_split_versions_have_shares
    AFTER INSERT ON split_versions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_check_split_total();

-- =====================================================================
-- R2  Live versions of one track never overlap in time
-- R5  New versions start after the last paid period, on the 1st of a
--     month, open-ended; one open proposal per track
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_split_versions_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_last_paid DATE;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'proposed' THEN
            RAISE EXCEPTION 'New split versions must start as proposed (got %)', NEW.status
                USING ERRCODE = '23514';
        END IF;
        IF NEW.valid_to IS NOT NULL THEN
            RAISE EXCEPTION 'A proposed split version is open-ended; its end is set when it is superseded'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.valid_from <> date_trunc('month', NEW.valid_from)::date THEN
            RAISE EXCEPTION 'A split version must start on the 1st of a month (got %)', NEW.valid_from
                USING ERRCODE = '23514';
        END IF;

        SELECT max(period_end) INTO v_last_paid FROM royalty_periods WHERE status = 'paid';
        IF NEW.valid_from <= v_last_paid THEN
            RAISE EXCEPTION 'Split version cannot start on % — periods up to % are already paid',
                            NEW.valid_from, v_last_paid
                USING ERRCODE = '23514', CONSTRAINT = 'r5_paid_history_immutable';
        END IF;

        IF EXISTS (SELECT 1 FROM split_versions
                   WHERE track_id = NEW.track_id AND status = 'proposed') THEN
            RAISE EXCEPTION 'Track % already has an open proposal; approve or reject it first', NEW.track_id
                USING ERRCODE = '23514';
        END IF;

        NEW.proposed_by := coalesce(NEW.proposed_by, app_user_id());
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.track_id <> OLD.track_id OR NEW.valid_from <> OLD.valid_from THEN
            RAISE EXCEPTION 'A split version''s track and start date cannot change'
                USING ERRCODE = '23514';
        END IF;
        -- lifecycle: proposed -> active | rejected, active -> superseded
        IF NEW.status <> OLD.status AND NOT (
               (OLD.status = 'proposed' AND NEW.status IN ('active', 'rejected'))
            OR (OLD.status = 'active'   AND NEW.status = 'superseded')) THEN
            RAISE EXCEPTION 'Split version cannot go from % to %', OLD.status, NEW.status
                USING ERRCODE = '55000';
        END IF;
    END IF;

    -- R2: no overlap between live (active or superseded) versions of the same track
    IF NEW.status IN ('active', 'superseded') AND EXISTS (
        SELECT 1 FROM split_versions o
        WHERE o.track_id = NEW.track_id
          AND o.version_id <> NEW.version_id
          AND o.status IN ('active', 'superseded')
          AND o.valid_from < coalesce(NEW.valid_to, 'infinity'::date)
          AND NEW.valid_from < coalesce(o.valid_to, 'infinity'::date)) THEN
        RAISE EXCEPTION 'Split version % would overlap another version of track %',
                        NEW.version_id, NEW.track_id
            USING ERRCODE = '23514', CONSTRAINT = 'r2_split_versions_no_overlap';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER r2_r5_split_versions_rules
    BEFORE INSERT OR UPDATE ON split_versions
    FOR EACH ROW EXECUTE FUNCTION trg_split_versions_rules();

-- only proposals can be deleted; live versions are history
CREATE OR REPLACE FUNCTION trg_split_versions_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'proposed' THEN
        RAISE EXCEPTION 'Only proposed split versions can be deleted (version % is %)',
                        OLD.version_id, OLD.status
            USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
END $$;

CREATE TRIGGER r4_split_versions_no_delete
    BEFORE DELETE ON split_versions
    FOR EACH ROW EXECUTE FUNCTION trg_split_versions_no_delete();

-- =====================================================================
-- R4  Shares can change only while their version is still proposed.
--     Any change resets everyone's approval, because the terms changed,
--     and keeps one approval row per contributor on the version.
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_split_shares_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_status VARCHAR;
BEGIN
    SELECT status INTO v_status FROM split_versions
    WHERE version_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;

    -- NULL: the parent version is being deleted (cascade), which R4 already allowed
    IF v_status IS NOT NULL AND v_status <> 'proposed' THEN
        RAISE EXCEPTION 'This split version is %, so its shares are frozen; propose a new version instead', v_status
            USING ERRCODE = '55000', CONSTRAINT = 'r4_split_shares_frozen';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.version_id <> OLD.version_id THEN
        RAISE EXCEPTION 'A share cannot move to another version' USING ERRCODE = '23514';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER r4_split_shares_frozen
    BEFORE INSERT OR UPDATE OR DELETE ON split_shares
    FOR EACH ROW EXECUTE FUNCTION trg_split_shares_frozen();

-- SECURITY DEFINER: staff edit shares but must not be able to write approvals themselves
CREATE OR REPLACE FUNCTION trg_split_shares_sync_approvals() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_version INT := CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM split_versions WHERE version_id = v_version) THEN
        RETURN NULL;   -- version deleted; approvals cascade away
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        INSERT INTO split_approvals (version_id, contributor_id)
        VALUES (NEW.version_id, NEW.contributor_id)
        ON CONFLICT (version_id, contributor_id) DO NOTHING;
    END IF;

    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        DELETE FROM split_approvals a
        WHERE a.version_id = OLD.version_id
          AND a.contributor_id = OLD.contributor_id
          AND NOT EXISTS (SELECT 1 FROM split_shares s
                          WHERE s.version_id = OLD.version_id
                            AND s.contributor_id = OLD.contributor_id);
    END IF;

    -- terms changed: everyone must approve again
    UPDATE split_approvals
    SET decision = 'pending', decided_at = NULL
    WHERE version_id = v_version AND decision <> 'pending';

    RETURN NULL;
END $$;

CREATE TRIGGER r3_split_shares_sync_approvals
    AFTER INSERT OR UPDATE OR DELETE ON split_shares
    FOR EACH ROW EXECUTE FUNCTION trg_split_shares_sync_approvals();

-- =====================================================================
-- R3  The last approval activates a version; any rejection rejects it
-- =====================================================================
CREATE OR REPLACE FUNCTION activate_split_version(p_version_id INT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_new     split_versions%ROWTYPE;
    v_current split_versions%ROWTYPE;
BEGIN
    SELECT * INTO v_new FROM split_versions WHERE version_id = p_version_id;

    -- serialise activations of the same track
    PERFORM 1 FROM split_versions WHERE track_id = v_new.track_id FOR UPDATE;

    -- idempotent: when one UPDATE approves several rows, the AFTER trigger fires once
    -- per row after the statement, and every firing sees "all approved"
    SELECT * INTO v_new FROM split_versions WHERE version_id = p_version_id;
    IF v_new.status <> 'proposed' THEN
        RETURN;
    END IF;

    SELECT * INTO v_current FROM split_versions
    WHERE track_id = v_new.track_id AND status = 'active';

    IF FOUND THEN
        IF v_new.valid_from <= v_current.valid_from THEN
            RAISE EXCEPTION 'New version must start after the current one (% <= %)',
                            v_new.valid_from, v_current.valid_from
                USING ERRCODE = '23514';
        END IF;
        -- close the current version first, so the two never overlap (R2)
        UPDATE split_versions
        SET status = 'superseded', valid_to = v_new.valid_from
        WHERE version_id = v_current.version_id;
    END IF;

    UPDATE split_versions
    SET status = 'active', activated_at = now()
    WHERE version_id = p_version_id;
END $$;

CREATE OR REPLACE FUNCTION trg_split_approvals_decide() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_status VARCHAR;
BEGIN
    IF NEW.version_id <> OLD.version_id OR NEW.contributor_id <> OLD.contributor_id THEN
        RAISE EXCEPTION 'An approval cannot be moved' USING ERRCODE = '23514';
    END IF;

    IF NEW.decision IS DISTINCT FROM OLD.decision THEN
        SELECT status INTO v_status FROM split_versions WHERE version_id = NEW.version_id;
        -- resets to pending come from share edits (R4 trigger), which are only allowed on proposals
        IF v_status <> 'proposed' THEN
            RAISE EXCEPTION 'Version % is already %; decisions are final', NEW.version_id, v_status
                USING ERRCODE = '55000';
        END IF;
        IF OLD.decision <> 'pending' AND NEW.decision <> 'pending' THEN
            RAISE EXCEPTION 'Contributor % already decided (%)', NEW.contributor_id, OLD.decision
                USING ERRCODE = '55000';
        END IF;
        NEW.decided_at := CASE WHEN NEW.decision = 'pending' THEN NULL
                               ELSE coalesce(NEW.decided_at, now()) END;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER r3_split_approvals_decide
    BEFORE UPDATE ON split_approvals
    FOR EACH ROW EXECUTE FUNCTION trg_split_approvals_decide();

CREATE OR REPLACE FUNCTION trg_split_approvals_after() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.decision = 'rejected' THEN
        UPDATE split_versions SET status = 'rejected'
        WHERE version_id = NEW.version_id AND status = 'proposed';
    ELSIF NEW.decision = 'approved' AND NOT EXISTS (
            SELECT 1 FROM split_approvals
            WHERE version_id = NEW.version_id AND decision <> 'approved') THEN
        PERFORM activate_split_version(NEW.version_id);
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER r3_split_approvals_after
    AFTER UPDATE OF decision ON split_approvals
    FOR EACH ROW
    WHEN (NEW.decision IS DISTINCT FROM OLD.decision AND NEW.decision <> 'pending')
    EXECUTE FUNCTION trg_split_approvals_after();

-- =====================================================================
-- R6  A track can be active only with an active split version
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_tracks_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status <> 'active')
       AND NOT EXISTS (SELECT 1 FROM split_versions
                       WHERE track_id = NEW.track_id AND status = 'active') THEN
        RAISE EXCEPTION 'Track % has no approved split yet, so it cannot be active', NEW.isrc
            USING ERRCODE = '23514', CONSTRAINT = 'r6_active_track_needs_split';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER r6_tracks_status
    BEFORE INSERT OR UPDATE OF status ON tracks
    FOR EACH ROW EXECUTE FUNCTION trg_tracks_status();

-- =====================================================================
-- R7  The sample graph has no cycles (recursive CTE)
-- R8  A track's total upstream share stays below 100%
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_samples_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_total NUMERIC;
BEGIN
    IF NEW.sampling_track_id = NEW.sampled_track_id THEN
        RETURN NEW;                     -- chk_samples_not_self reports this one
    END IF;
    -- Walk upstream from the track being sampled. If we reach the sampling
    -- track, the new edge would close a loop: money would flow in a circle.
    IF EXISTS (
        WITH RECURSIVE upstream (track_id) AS (
            SELECT NEW.sampled_track_id
          UNION                                     -- UNION (not ALL) stops on revisits
            SELECT s.sampled_track_id
            FROM samples s
            JOIN upstream u ON s.sampling_track_id = u.track_id
            WHERE NOT (TG_OP = 'UPDATE'
                       AND s.sampling_track_id = OLD.sampling_track_id
                       AND s.sampled_track_id  = OLD.sampled_track_id)
        )
        SELECT 1 FROM upstream WHERE track_id = NEW.sampling_track_id) THEN
        RAISE EXCEPTION 'Track % already earns from track % through samples; this would create a loop',
                        NEW.sampled_track_id, NEW.sampling_track_id
            USING ERRCODE = '23514', CONSTRAINT = 'r7_samples_no_cycle';
    END IF;

    SELECT coalesce(sum(upstream_pct), 0) + NEW.upstream_pct INTO v_total
    FROM samples
    WHERE sampling_track_id = NEW.sampling_track_id
      AND NOT (TG_OP = 'UPDATE' AND sampled_track_id = OLD.sampled_track_id
               AND sampling_track_id = OLD.sampling_track_id);
    IF v_total >= 100 THEN
        RAISE EXCEPTION 'Track % would owe % upstream; the total must stay below 100%%',
                        NEW.sampling_track_id, v_total || '%'
            USING ERRCODE = '23514', CONSTRAINT = 'r8_samples_total_below_100';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER r7_r8_samples_rules
    BEFORE INSERT OR UPDATE ON samples
    FOR EACH ROW EXECUTE FUNCTION trg_samples_rules();

-- =====================================================================
-- R9  Recoupments never exceed the advance
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_recoupments_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_amount   NUMERIC;
    v_recouped NUMERIC;
BEGIN
    -- lock the advance so two concurrent recoupments can't both pass the check
    SELECT amount INTO v_amount FROM advances WHERE advance_id = NEW.advance_id FOR UPDATE;

    SELECT coalesce(sum(amount), 0) INTO v_recouped
    FROM advance_recoupments
    WHERE advance_id = NEW.advance_id
      AND NOT (TG_OP = 'UPDATE' AND period_id = OLD.period_id AND advance_id = OLD.advance_id);

    IF v_recouped + NEW.amount > v_amount THEN
        RAISE EXCEPTION 'Recouping ₹% would exceed advance % (₹% of its ₹% already recouped)',
                        NEW.amount, NEW.advance_id, v_recouped, v_amount
            USING ERRCODE = '23514', CONSTRAINT = 'r9_recoupment_within_advance';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER r9_recoupments_limit
    BEFORE INSERT OR UPDATE ON advance_recoupments
    FOR EACH ROW EXECUTE FUNCTION trg_recoupments_limit();

-- =====================================================================
-- R10 Report data changes only while the period is open
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_period_must_be_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_period INT := CASE WHEN TG_OP = 'DELETE' THEN OLD.period_id ELSE NEW.period_id END;
    v_status VARCHAR;
BEGIN
    SELECT status INTO v_status FROM royalty_periods WHERE period_id = v_period;
    IF v_status <> 'open' THEN
        RAISE EXCEPTION 'Period % is %; report data can only change while it is open', v_period, v_status
            USING ERRCODE = '55000', CONSTRAINT = 'r10_period_open';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER r10_stream_stats_period_open
    BEFORE INSERT OR UPDATE OR DELETE ON stream_stats
    FOR EACH ROW EXECUTE FUNCTION trg_period_must_be_open();

CREATE TRIGGER r10_unmatched_lines_period_open
    BEFORE INSERT ON unmatched_lines
    FOR EACH ROW EXECUTE FUNCTION trg_period_must_be_open();

-- period lifecycle: open <-> locked -> paid (paid is final)
CREATE OR REPLACE FUNCTION trg_period_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end THEN
        RAISE EXCEPTION 'A period''s dates cannot change' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
           (OLD.status = 'open'   AND NEW.status = 'locked')
        OR (OLD.status = 'locked' AND NEW.status IN ('open', 'paid'))) THEN
        RAISE EXCEPTION 'Period cannot go from % to %', OLD.status, NEW.status
            USING ERRCODE = '55000';
    END IF;
    IF OLD.status = 'paid' THEN
        RAISE EXCEPTION 'Period % is paid and can no longer change', OLD.period_id
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER r14_period_lifecycle
    BEFORE UPDATE ON royalty_periods
    FOR EACH ROW EXECUTE FUNCTION trg_period_lifecycle();

-- =====================================================================
-- R11 A payment equals its statement's net payable
-- R14 Statements, their lines and payments are immutable once written
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_payment_amount() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_net NUMERIC;
BEGIN
    SELECT net_payable INTO v_net FROM statements WHERE statement_id = NEW.statement_id;
    IF NEW.amount <> v_net THEN
        RAISE EXCEPTION 'Payment of ₹% does not match statement %''s net payable of ₹%',
                        NEW.amount, NEW.statement_id, v_net
            USING ERRCODE = '23514', CONSTRAINT = 'r11_payment_matches_statement';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER r11_payment_amount
    BEFORE INSERT ON payments
    FOR EACH ROW EXECUTE FUNCTION trg_payment_amount();

CREATE OR REPLACE FUNCTION trg_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are a permanent record and cannot be %d',
                    TG_TABLE_NAME, lower(TG_OP)
        USING ERRCODE = '55000', CONSTRAINT = 'r14_payout_records_immutable';
END $$;

CREATE TRIGGER r14_statements_immutable
    BEFORE UPDATE OR DELETE ON statements
    FOR EACH ROW EXECUTE FUNCTION trg_immutable();
CREATE TRIGGER r14_statement_lines_immutable
    BEFORE UPDATE OR DELETE ON statement_lines
    FOR EACH ROW EXECUTE FUNCTION trg_immutable();
CREATE TRIGGER r14_payments_immutable
    BEFORE UPDATE OR DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION trg_immutable();
CREATE TRIGGER r14_recoupments_immutable
    BEFORE DELETE ON advance_recoupments
    FOR EACH ROW EXECUTE FUNCTION trg_immutable();

-- =====================================================================
-- R12 One account manager per contributor per platform
--     (the FD lost in the BCNF decomposition, docs/04-normalization.md §4.7)
-- R13 Only staff users sit on platform desks or manage contributors
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_staff_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users WHERE user_id = NEW.user_id AND role = 'staff') THEN
        RAISE EXCEPTION 'User % is not a staff member', NEW.user_id
            USING ERRCODE = '23514', CONSTRAINT = 'r13_staff_only';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER r13_staff_platforms_staff_only
    BEFORE INSERT OR UPDATE ON staff_platforms
    FOR EACH ROW EXECUTE FUNCTION trg_staff_only();
CREATE TRIGGER r13_contributor_managers_staff_only
    BEFORE INSERT OR UPDATE ON contributor_managers
    FOR EACH ROW EXECUTE FUNCTION trg_staff_only();

CREATE OR REPLACE FUNCTION trg_one_manager_per_platform() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM staff_platforms WHERE user_id = NEW.user_id) THEN
        RAISE EXCEPTION 'User % has no platform desk, so cannot manage contributors', NEW.user_id
            USING ERRCODE = '23514', CONSTRAINT = 'r12_one_manager_per_platform';
    END IF;
    -- {contributor, platform} -> manager
    IF EXISTS (
        SELECT 1
        FROM contributor_managers cm
        JOIN staff_platforms sp_other ON sp_other.user_id = cm.user_id
        JOIN staff_platforms sp_new   ON sp_new.user_id = NEW.user_id
        WHERE cm.contributor_id = NEW.contributor_id
          AND cm.user_id <> NEW.user_id
          AND sp_other.platform_id = sp_new.platform_id) THEN
        RAISE EXCEPTION 'Contributor % already has a manager on that platform', NEW.contributor_id
            USING ERRCODE = '23514', CONSTRAINT = 'r12_one_manager_per_platform';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER r12_contributor_managers_one_per_platform
    BEFORE INSERT OR UPDATE ON contributor_managers
    FOR EACH ROW EXECUTE FUNCTION trg_one_manager_per_platform();

-- a manager moving desks must not leave a contributor with two managers on one platform
CREATE OR REPLACE FUNCTION trg_staff_desk_move() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT cm.contributor_id
        FROM contributor_managers cm
        JOIN staff_platforms sp USING (user_id)
        WHERE cm.contributor_id IN (SELECT contributor_id FROM contributor_managers
                                    WHERE user_id = NEW.user_id)
        GROUP BY cm.contributor_id, sp.platform_id
        HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'Moving user % to this desk gives a contributor two managers on one platform',
                        NEW.user_id
            USING ERRCODE = '23514', CONSTRAINT = 'r12_one_manager_per_platform';
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER r12_staff_platforms_desk_move
    AFTER UPDATE OF platform_id ON staff_platforms
    FOR EACH ROW EXECUTE FUNCTION trg_staff_desk_move();

-- =====================================================================
-- F3  Fraud flag review: open -> cleared | confirmed (final).
--     Confirming forfeits the money held against the flag; cleared money
--     is released by the next payout run.
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_fraud_flags_review() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'open' AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'Flag % was already %', OLD.flag_id, OLD.status
            USING ERRCODE = '55000';
    END IF;
    IF NEW.status <> 'open' AND OLD.status = 'open' THEN
        NEW.reviewed_at := coalesce(NEW.reviewed_at, now());
        NEW.reviewed_by := coalesce(NEW.reviewed_by, app_user_id());
        IF NEW.reviewed_by IS NULL THEN
            RAISE EXCEPTION 'Reviewing a flag needs a reviewer (set app.user_id)' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER f3_fraud_flags_review
    BEFORE UPDATE ON fraud_flags
    FOR EACH ROW EXECUTE FUNCTION trg_fraud_flags_review();

CREATE OR REPLACE FUNCTION trg_fraud_flags_forfeit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE held_earnings SET status = 'forfeited'
    WHERE flag_id = NEW.flag_id AND status = 'held';
    RETURN NULL;
END $$;

CREATE TRIGGER f3_fraud_flags_forfeit
    AFTER UPDATE OF status ON fraud_flags
    FOR EACH ROW WHEN (NEW.status = 'confirmed' AND OLD.status = 'open')
    EXECUTE FUNCTION trg_fraud_flags_forfeit();

-- =====================================================================
-- R15 Audit trail: every change to ownership, money and access tables.
--     Trigger arguments name the table's primary-key columns.
--     SECURITY DEFINER so roles without INSERT on audit_log still get
--     audited. Secrets and bulky columns are left out of the JSON.
--     stream_stats is not audited row by row (lakhs of rows per load);
--     its audit trail is the raw report kept in MongoDB.
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_old_full JSONB;
    v_new_full JSONB;
    v_old      JSONB;
    v_new      JSONB;
    v_key      JSONB := '{}';
    v_col      TEXT;
BEGIN
    IF TG_OP <> 'INSERT' THEN v_old_full := to_jsonb(OLD); END IF;
    IF TG_OP <> 'DELETE' THEN v_new_full := to_jsonb(NEW); END IF;
    v_old := v_old_full - 'password_hash' - 'embedding' - 'search_vector';
    v_new := v_new_full - 'password_hash' - 'embedding' - 'search_vector';

    IF TG_OP = 'UPDATE' AND v_old_full = v_new_full THEN
        RETURN NULL;                                   -- nothing really changed
    END IF;
    IF TG_OP = 'UPDATE' AND (v_old_full ->> 'password_hash') IS DISTINCT FROM (v_new_full ->> 'password_hash') THEN
        v_new := v_new || '{"password_changed": true}';
    END IF;

    FOREACH v_col IN ARRAY TG_ARGV LOOP
        v_key := v_key || jsonb_build_object(v_col, coalesce(v_new, v_old) -> v_col);
    END LOOP;

    INSERT INTO audit_log (table_name, operation, row_key, old_row, new_row, changed_by)
    VALUES (TG_TABLE_NAME, TG_OP, v_key, v_old, v_new, app_user_id());
    RETURN NULL;
END $$;

CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON contributors
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('contributor_id');
CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('user_id');
CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON staff_platforms
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('user_id');
CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON contributor_managers
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('contributor_id', 'user_id');
CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON tracks
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('track_id');
CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON split_versions
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('version_id');
CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON split_shares
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('version_id', 'contributor_id', 'role');
CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON split_approvals
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('version_id', 'contributor_id');
CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON samples
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('sampling_track_id', 'sampled_track_id');
CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON royalty_periods
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('period_id');
CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON unmatched_lines
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('line_id');
CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON fraud_flags
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('flag_id');
CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON held_earnings
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('hold_id');
CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON advances
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('advance_id');
CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON advance_recoupments
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('advance_id', 'period_id');
CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON statements
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('statement_id');
CREATE TRIGGER r15_audit AFTER INSERT OR UPDATE OR DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION trg_audit_row('payment_id');
