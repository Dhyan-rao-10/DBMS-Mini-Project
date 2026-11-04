-- =====================================================================
-- tests/04_access_test.sql — database roles enforce who can do what
--
-- Each case runs under SET LOCAL ROLE, exactly like an API request.
-- 42501 = insufficient_privilege.
-- =====================================================================

\ir _helpers.sql
BEGIN;

SELECT period_id AS aug FROM royalty_periods WHERE period_start = DATE '2026-08-01' \gset

-- ---------- contributor: only their own rows, through views ----------
SELECT pg_temp.act_as('aarav.mehta@example.com');
SELECT pg_temp.expect_error('Contributor cannot read the contributors table', '42501',
    'SELECT * FROM contributors', 'app_contributor');
SELECT pg_temp.expect_error('Contributor cannot read other people''s statements directly', '42501',
    'SELECT * FROM statements', 'app_contributor');
SELECT pg_temp.expect_error('Contributor cannot change approvals directly', '42501',
    $$UPDATE split_approvals SET decision = 'approved'$$, 'app_contributor');
SELECT pg_temp.expect_ok('Contributor sees only their own statements through v_my_statements',
    $t$DO $do$ BEGIN
        IF (SELECT count(DISTINCT contributor_id) FROM v_my_statements) <> 1
           OR (SELECT min(legal_name) FROM v_my_statements) <> 'Aarav Mehta' THEN
            RAISE EXCEPTION 'v_my_statements leaked other contributors';
        END IF;
      END $do$$t$, 'app_contributor');
SELECT pg_temp.expect_ok('Contributor sees their pending proposals',
    'SELECT * FROM v_my_pending_proposals', 'app_contributor');

-- ---------- staff: catalogue and intake, but no money or audit ----------
SELECT pg_temp.act_as('riya.spotify@monsoonrecords.test');
SELECT pg_temp.expect_error('Staff cannot read password hashes', '42501',
    'SELECT password_hash FROM users', 'app_staff');
SELECT pg_temp.expect_ok('Staff can read the rest of the users table',
    'SELECT user_id, email, role FROM users', 'app_staff');
SELECT pg_temp.expect_error('Staff cannot run a payout', '42501',
    format('CALL process_payout(%s)', :aug), 'app_staff');
SELECT pg_temp.expect_error('Staff cannot read the audit log', '42501',
    'SELECT * FROM audit_log', 'app_staff');
SELECT pg_temp.expect_error('Staff cannot create payments', '42501',
    $$INSERT INTO payments (statement_id, amount, reference) VALUES (1, 1, 'x')$$, 'app_staff');
SELECT pg_temp.expect_error('Staff cannot approve splits for contributors', '42501',
    $$UPDATE split_approvals SET decision = 'approved'$$, 'app_staff');
SELECT pg_temp.expect_ok('Staff can propose a split (approval rows created for them)',
    $$SELECT propose_split_version(t.track_id, DATE '2026-10-01',
              format('[{"contributor_id": %s, "role": "artist", "share_pct": 100}]', c.contributor_id)::jsonb)
      FROM tracks t, contributors c WHERE t.isrc = 'INM0R2500003' AND c.email = 'aarav.mehta@example.com'$$,
    'app_staff');
SELECT pg_temp.expect_ok('Staff can add a track',
    $$INSERT INTO tracks (isrc, title, release_id, duration_sec)
      SELECT 'INM0R2600099', 'New Single', release_id, 200 FROM releases LIMIT 1$$, 'app_staff');

-- ---------- admin: everything except rewriting history ----------
SELECT pg_temp.act_as('admin@monsoonrecords.test');
SELECT pg_temp.expect_error('Even an admin cannot delete audit entries', '42501',
    'DELETE FROM audit_log', 'app_admin');
SELECT pg_temp.expect_error('Even an admin cannot edit audit entries', '42501',
    $$UPDATE audit_log SET changed_by = NULL$$, 'app_admin');
SELECT pg_temp.expect_ok('Admin can read the audit log',
    'SELECT count(*) FROM audit_log', 'app_admin');

-- ---------- report role ----------
SELECT pg_temp.expect_error('Reporting role cannot write', '42501',
    $$UPDATE tracks SET title = title$$, 'app_report');
SELECT pg_temp.expect_error('Reporting role cannot read password hashes', '42501',
    'SELECT password_hash FROM users', 'app_report');

-- ---------- login role: can check a password, can't read anything ----------
SELECT pg_temp.expect_error('Login role cannot read the users table', '42501',
    'SELECT email, password_hash FROM users', 'app_login');
SELECT pg_temp.expect_ok('Login role can call authenticate() (wrong password: no rows, no error)',
    $$SELECT * FROM authenticate('admin@monsoonrecords.test', 'not-the-password')$$, 'app_login');
SELECT pg_temp.check('authenticate() returns nobody for a wrong password',
    NOT EXISTS (SELECT 1 FROM authenticate('admin@monsoonrecords.test', 'not-the-password')));

-- ---------- the app's login role has nothing of its own ----------
SELECT pg_temp.expect_error('royalty_app without SET ROLE can read nothing', '42501',
    'SELECT * FROM tracks LIMIT 1', 'royalty_app');

\ir _report.sql
ROLLBACK;
