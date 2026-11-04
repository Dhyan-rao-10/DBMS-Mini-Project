-- =====================================================================
-- tests/02_business_rules_test.sql — triggers R1..R15 and the F1/F3 workflows
--
-- Runs against the state left by setup.sh: Oct 2025..Aug 2026 paid,
-- Sep 2026 open with fraud flags. Everything runs in one transaction
-- that is rolled back at the end.
-- =====================================================================

\ir _helpers.sql
BEGIN;

SELECT pg_temp.act_as('riya.spotify@monsoonrecords.test');      -- staff member
SELECT track_id AS lofi FROM tracks WHERE isrc = 'INM0R2500004' \gset
SELECT track_id AS petrichor FROM tracks WHERE isrc = 'INM0R2500003' \gset
SELECT contributor_id AS kabir FROM contributors WHERE email = 'kabir.rao@example.com' \gset
SELECT contributor_id AS aarav FROM contributors WHERE email = 'aarav.mehta@example.com' \gset
SELECT period_id AS aug FROM royalty_periods WHERE period_start = DATE '2026-08-01' \gset
SELECT period_id AS sep FROM royalty_periods WHERE period_start = DATE '2026-09-01' \gset

-- ---------- R1: shares total exactly 100% (deferred constraint trigger) ----------
SELECT pg_temp.expect_error('R1 proposal totalling 90% is rejected', '23514',
    format($$SELECT propose_split_version(%s, DATE '2026-10-01',
             '[{"contributor_id": %s, "role": "artist", "share_pct": 60},
               {"contributor_id": %s, "role": "featured_artist", "share_pct": 30}]')$$, :petrichor, :aarav, :kabir));
SELECT pg_temp.expect_error('R1 proposal totalling 110% is rejected', '23514',
    format($$SELECT propose_split_version(%s, DATE '2026-10-01',
             '[{"contributor_id": %s, "role": "artist", "share_pct": 70},
               {"contributor_id": %s, "role": "producer", "share_pct": 40}]')$$, :petrichor, :aarav, :kabir));
SELECT pg_temp.expect_error('R1 editing a proposal down to 95% is rejected at commit', '23514',
    $$UPDATE split_shares SET share_pct = share_pct - 5
      WHERE version_id = (SELECT min(version_id) FROM split_versions WHERE status = 'proposed') AND role = 'artist'$$);
SELECT pg_temp.expect_ok('R1 moving 5% between two shares (still 100%) is fine',
    $$UPDATE split_shares SET share_pct = share_pct + CASE role WHEN 'artist' THEN -5 ELSE 5 END
      WHERE version_id = (SELECT max(version_id) FROM split_versions WHERE status = 'proposed')$$);

-- ---------- R5: paid history is immutable; versions start on the 1st ----------
SELECT pg_temp.expect_error('R5 version starting inside a paid period', '23514',
    format($$SELECT propose_split_version(%s, DATE '2026-08-01', '[{"contributor_id": %s, "role": "artist", "share_pct": 100}]')$$, :petrichor, :aarav));
SELECT pg_temp.expect_error('R5 version starting mid-month', '23514',
    format($$SELECT propose_split_version(%s, DATE '2026-10-15', '[{"contributor_id": %s, "role": "artist", "share_pct": 100}]')$$, :petrichor, :aarav));
SELECT pg_temp.expect_error('R5 second open proposal for the same track', '23514',
    $$SELECT propose_split_version(track_id, DATE '2026-12-01', '[{"contributor_id": 1, "role": "artist", "share_pct": 100}]')
      FROM split_versions WHERE status = 'proposed' LIMIT 1$$);

-- ---------- R2: live versions never overlap ----------
SELECT pg_temp.expect_error('R2 stretching a superseded version over the active one', '23514',
    $$UPDATE split_versions SET valid_to = DATE '2026-06-01' WHERE status = 'superseded'$$);

-- ---------- R4: live splits are frozen ----------
SELECT pg_temp.expect_error('R4 editing a share of an active version', '55000',
    format($$UPDATE split_shares SET share_pct = 50 WHERE contributor_id = %s AND role = 'producer'
             AND version_id = (SELECT version_id FROM split_versions WHERE track_id = %s AND status = 'active')$$, :kabir, :lofi));
SELECT pg_temp.expect_error('R4 deleting an active version', '55000',
    format($$DELETE FROM split_versions WHERE track_id = %s AND status = 'active'$$, :lofi));
SELECT pg_temp.expect_error('R4 reviving a superseded version', '55000',
    $$UPDATE split_versions SET status = 'active' WHERE status = 'superseded'$$);

-- ---------- F1 / R3: full approval workflow (kept for the rest of this test) ----------
SELECT propose_split_version(:lofi, DATE '2026-10-01',
       format('[{"contributor_id": %1$s, "role": "artist", "share_pct": 40},
                {"contributor_id": %1$s, "role": "producer", "share_pct": 25},
                {"contributor_id": %2$s, "role": "featured_artist", "share_pct": 35}]', :kabir, :aarav)::jsonb)
       AS new_version \gset
SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;

SELECT pg_temp.check('R3 one approval row per distinct contributor (Kabir has two roles)',
    (SELECT count(*) FROM split_approvals WHERE version_id = :new_version) = 2);

SELECT pg_temp.act_as('kabir.rao@example.com');
SELECT pg_temp.check('R3 first approval keeps the version proposed',
    approve_split(:new_version, 'approved') = 'proposed');
SELECT pg_temp.expect_error('R3 a contributor cannot change a decision', '55000',
    format($$SELECT approve_split(%s, 'rejected')$$, :new_version));

SELECT pg_temp.act_as('meera.iyer@example.com');
SELECT pg_temp.expect_error('R3 a contributor not on the split cannot approve it', '42501',
    format($$SELECT approve_split(%s, 'approved')$$, :new_version));

SELECT pg_temp.act_as('aarav.mehta@example.com');
SELECT pg_temp.check('R3 last approval activates the version',
    approve_split(:new_version, 'approved') = 'active');
SELECT pg_temp.check('R3 previous version superseded and closed on the new start date',
    EXISTS (SELECT 1 FROM split_versions WHERE track_id = :lofi AND status = 'superseded'
            AND valid_to = DATE '2026-10-01'));
SELECT pg_temp.check('F1 fn_version_at picks the right version on each side of the change',
    fn_version_at(:lofi, DATE '2026-09-30') <> :new_version
    AND fn_version_at(:lofi, DATE '2026-10-01') = :new_version);

-- approving every row in ONE statement must activate exactly once (AFTER ROW triggers
-- all fire after the statement, and each one sees "everyone approved")
SELECT propose_split_version(:petrichor, DATE '2026-10-01',
       format('[{"contributor_id": %s, "role": "artist", "share_pct": 70},
                {"contributor_id": %s, "role": "producer", "share_pct": 30}]', :aarav, :kabir)::jsonb)
       AS bulk_version \gset
SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
UPDATE split_approvals SET decision = 'approved' WHERE version_id = :bulk_version;
SELECT pg_temp.check('R3 approving all rows in one UPDATE activates the version once',
    (SELECT status FROM split_versions WHERE version_id = :bulk_version) = 'active'
    AND (SELECT count(*) FROM split_versions WHERE track_id = :petrichor AND status = 'active') = 1);

-- "Untitled Demo 1": Meera approved in the seed, Kabir is still pending
SELECT sv.version_id AS demo_version FROM split_versions sv JOIN tracks t USING (track_id)
WHERE t.isrc = 'INM0R2600001' AND sv.status = 'proposed' \gset
SELECT pg_temp.act_as('kabir.rao@example.com');
SELECT pg_temp.check('R3 a single rejection rejects the whole proposal',
    approve_split(:demo_version, 'rejected') = 'rejected');
SELECT pg_temp.act_as('riya.spotify@monsoonrecords.test');

-- ---------- R6: active tracks need an approved split ----------
SELECT pg_temp.expect_error('R6 activating a track with no approved split', '23514',
    $$UPDATE tracks SET status = 'active' WHERE isrc = 'INM0R2600001'$$);

-- ---------- R7 / R8: sample graph ----------
SELECT pg_temp.expect_error('R7 sample that would close a loop (Raag Megh sampling Rain Cypher)', '23514',
    $$INSERT INTO samples SELECT a.track_id, b.track_id, 10, DATE '2026-01-01'
      FROM tracks a, tracks b WHERE a.isrc = 'INM0R1900001' AND b.isrc = 'INM0R2500009'$$);
SELECT pg_temp.expect_error('R8 upstream shares reaching 100%', '23514',
    format($$INSERT INTO samples VALUES (%s, %s, 70, DATE '2026-01-01')$$, :lofi, :petrichor));
SELECT pg_temp.expect_ok('R7/R8 a valid new sample is accepted',
    format($$INSERT INTO samples VALUES (%s, %s, 10, DATE '2026-01-01')$$, :lofi, :petrichor));

-- ---------- R9: recoupments within the advance ----------
SELECT pg_temp.expect_error('R9 recouping more than the advance', '23514',
    format($$INSERT INTO advance_recoupments
             SELECT advance_id, %s, 1.00 FROM v_advance_balances WHERE outstanding = 0 LIMIT 1$$, :sep));

-- ---------- R10: report data only in open periods ----------
SELECT pg_temp.expect_error('R10 adding streams to a paid period', '55000',
    format($$UPDATE stream_stats SET streams = streams + 1 WHERE period_id = %s AND track_id = %s$$, :aug, :lofi));
SELECT pg_temp.expect_ok('R10 adding streams to the open period',
    format($$UPDATE stream_stats SET streams = streams + 1 WHERE period_id = %s AND track_id = %s$$, :sep, :lofi));
SELECT pg_temp.expect_error('R14 reopening a paid period', '55000',
    format($$UPDATE royalty_periods SET status = 'open' WHERE period_id = %s$$, :aug));

-- ---------- R11 / R14: payout records ----------
SELECT pg_temp.expect_error('R11 payment that differs from the statement', '23514',
    format($$WITH s AS (INSERT INTO statements (period_id, contributor_id, gross_earned, tds_rate_applied, tds_amount, net_payable)
                        VALUES (%s, 1, 100, 10, 10, 90) RETURNING statement_id)
             INSERT INTO payments (statement_id, amount, reference) SELECT statement_id, 80, 'UTR-X' FROM s$$, :sep));
SELECT pg_temp.expect_error('R14 editing a paid statement', '55000',
    $$UPDATE statements SET net_payable = net_payable + 1 WHERE statement_id = (SELECT min(statement_id) FROM statements)$$);
SELECT pg_temp.expect_error('R14 deleting a payment', '55000',
    $$DELETE FROM payments WHERE payment_id = (SELECT min(payment_id) FROM payments)$$);
SELECT pg_temp.expect_error('R14 paying a period twice', '55000',
    format($$CALL process_payout(%s)$$, :aug));
SELECT pg_temp.expect_error('R14 paying a period that is not locked', '55000',
    format($$CALL process_payout(%s)$$, :sep));

-- ---------- R12 / R13: account managers (FD kept after BCNF) ----------
INSERT INTO users (email, password_hash, full_name, role)
VALUES ('neha.spotify@monsoonrecords.test', crypt('x', gen_salt('bf', 4)), 'Neha (2nd Spotify desk)', 'staff');
INSERT INTO staff_platforms
SELECT u.user_id, p.platform_id FROM users u, platforms p
WHERE u.email = 'neha.spotify@monsoonrecords.test' AND p.code = 'SPOTIFY';

SELECT pg_temp.expect_error('R12 second Spotify manager for the same contributor', '23514',
    format($$INSERT INTO contributor_managers
             SELECT %s, user_id FROM users WHERE email = 'neha.spotify@monsoonrecords.test'$$, :aarav));
SELECT pg_temp.expect_ok('R12 the same manager for a contributor with no Spotify manager',
    format($$INSERT INTO contributor_managers
             SELECT %s, user_id FROM users WHERE email = 'neha.spotify@monsoonrecords.test'$$, :kabir));
SELECT pg_temp.expect_error('R12 moving a manager onto a desk that creates a clash', '23514',
    $$UPDATE staff_platforms SET platform_id = (SELECT platform_id FROM platforms WHERE code = 'SPOTIFY')
      WHERE user_id = (SELECT user_id FROM users WHERE email = 'dev.jiosaavn@monsoonrecords.test')$$);
SELECT pg_temp.expect_error('R13 an admin cannot sit on a platform desk', '23514',
    $$INSERT INTO staff_platforms SELECT user_id, 1 FROM users WHERE email = 'admin@monsoonrecords.test'$$);

-- ---------- F3: fraud flag review ----------
SELECT pg_temp.act_as('admin@monsoonrecords.test');
UPDATE fraud_flags SET status = 'cleared', note = 'Label-run playlist campaign'
WHERE flag_id = (SELECT min(flag_id) FROM fraud_flags);
SELECT pg_temp.check('F3 reviewing a flag records who and when',
    (SELECT reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL FROM fraud_flags
     WHERE flag_id = (SELECT min(flag_id) FROM fraud_flags)));
SELECT pg_temp.expect_error('F3 a reviewed flag is final', '55000',
    $$UPDATE fraud_flags SET status = 'confirmed' WHERE flag_id = (SELECT min(flag_id) FROM fraud_flags)$$);

-- ---------- R15: audit trail ----------
UPDATE contributors SET stage_name = 'Aarav M.' WHERE email = 'aarav.mehta@example.com';
SELECT pg_temp.check('R15 change is audited with old and new values and the acting user',
    EXISTS (SELECT 1 FROM audit_log
            WHERE table_name = 'contributors' AND operation = 'UPDATE'
              AND old_row ->> 'stage_name' = 'Aarav' AND new_row ->> 'stage_name' = 'Aarav M.'
              AND changed_by = (SELECT user_id FROM users WHERE email = 'admin@monsoonrecords.test')));
UPDATE users SET password_hash = crypt('new', gen_salt('bf', 4)) WHERE email = 'meera.iyer@example.com';
SELECT pg_temp.check('R15 password changes are audited without the hash',
    EXISTS (SELECT 1 FROM audit_log
            WHERE table_name = 'users' AND new_row ->> 'password_changed' = 'true'
              AND NOT (new_row ? 'password_hash') AND NOT (old_row ? 'password_hash')));
SELECT pg_temp.check('R15 the approval workflow above was fully audited',
    (SELECT count(*) FROM audit_log
     WHERE table_name IN ('split_versions', 'split_shares', 'split_approvals')
       AND (row_key ->> 'version_id')::int = :new_version) >= 8);

\ir _report.sql
ROLLBACK;
