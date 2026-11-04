-- =====================================================================
-- 09_roles_grants.sql — database-level access control
--
-- Four group roles (NOLOGIN) hold the privileges:
--   app_admin        everything, except rewriting the audit trail
--   app_staff        catalogue, splits, report intake; no payouts, no audit
--   app_contributor  only the v_my_* views and approve_split()
--   app_report       read-only, no password hashes
-- The web app logs in as royalty_app, which has no privileges of its
-- own (NOINHERIT). Each request runs SET LOCAL ROLE <group role> inside
-- its transaction, so the database itself enforces what that user may do.
--
-- Needs psql variable app_db_password (setup.sh passes it from .env).
-- =====================================================================

-- ---------- roles (cluster-wide, so create only if missing) ----------
DO $$
DECLARE
    r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['app_admin', 'app_staff', 'app_contributor', 'app_report'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN', r);
        END IF;
    END LOOP;
END $$;

SELECT format('CREATE ROLE royalty_app LOGIN NOINHERIT PASSWORD %L', :'app_db_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'royalty_app') \gexec
ALTER ROLE royalty_app LOGIN NOINHERIT PASSWORD :'app_db_password';

GRANT app_admin, app_staff, app_contributor, app_report TO royalty_app;
SELECT format('GRANT CONNECT ON DATABASE %I TO royalty_app', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO app_admin, app_staff, app_contributor, app_report;

-- ---------- start from nothing (re-runnable) ----------
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM app_admin, app_staff, app_contributor, app_report;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app_admin, app_staff, app_contributor, app_report;

-- functions are executable by PUBLIC by default; lock down the ones that change data
REVOKE EXECUTE ON FUNCTION
    activate_split_version(INT), propose_split_version(INT, DATE, JSONB), approve_split(INT, TEXT),
    detect_fraud(INT, NUMERIC, NUMERIC), confirm_unmatched_line(BIGINT, INT),
    write_off_unmatched_line(BIGINT)
FROM PUBLIC;
REVOKE EXECUTE ON PROCEDURE process_payout(INT, INT, NUMERIC, NUMERIC, NUMERIC) FROM PUBLIC;

-- ---------- app_admin ----------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_admin;
GRANT EXECUTE ON ALL FUNCTIONS  IN SCHEMA public TO app_admin;
GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA public TO app_admin;
-- the audit trail is append-only, even for admins (only triggers write it)
REVOKE INSERT, UPDATE, DELETE ON audit_log FROM app_admin;

-- ---------- app_staff ----------
GRANT SELECT ON
    contributors, platforms, staff_platforms, contributor_managers, releases, tracks, genres,
    track_genres, track_platforms, track_embeddings, royalty_periods, split_versions, split_shares,
    split_approvals, samples, stream_stats, unmatched_lines, fraud_flags, held_earnings,
    advances, advance_recoupments, statements, statement_lines, payments,
    v_split_totals, v_current_splits, v_open_proposals, v_advance_balances,
    v_contributor_earnings, v_track_period_revenue
TO app_staff;
GRANT SELECT (user_id, email, full_name, role, contributor_id, is_active, created_at) ON users TO app_staff;

GRANT INSERT, UPDATE, DELETE ON
    contributors, releases, tracks, genres, track_genres, track_platforms, track_embeddings,
    samples, contributor_managers, split_shares
TO app_staff;
GRANT INSERT, DELETE ON split_versions TO app_staff;          -- proposals only (R4 trigger)
GRANT INSERT, UPDATE ON stream_stats, unmatched_lines TO app_staff;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_staff;
GRANT EXECUTE ON FUNCTION
    propose_split_version(INT, DATE, JSONB), confirm_unmatched_line(BIGINT, INT),
    write_off_unmatched_line(BIGINT)
TO app_staff;

-- ---------- app_contributor ----------
GRANT SELECT ON v_my_contributor, v_my_statements, v_my_statement_lines, v_my_splits,
                v_my_advances, v_my_pending_proposals
TO app_contributor;
GRANT EXECUTE ON FUNCTION approve_split(INT, TEXT) TO app_contributor;

-- ---------- app_report ----------
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_report;
REVOKE SELECT ON users FROM app_report;
GRANT SELECT (user_id, email, full_name, role, contributor_id, is_active, created_at) ON users TO app_report;

-- ---------- app_login: can only call authenticate() ----------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_login') THEN
        CREATE ROLE app_login NOLOGIN;
    END IF;
END $$;
GRANT app_login TO royalty_app;
GRANT USAGE ON SCHEMA public TO app_login;
REVOKE EXECUTE ON FUNCTION authenticate(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate(TEXT, TEXT) TO app_login;
