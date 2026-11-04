-- =====================================================================
-- tests/01_constraints_test.sql — declarative constraints reject bad data
--
-- Each case runs a statement that must fail with a specific SQLSTATE:
--   23502 not_null_violation   23503 foreign_key_violation
--   23505 unique_violation     23514 check_violation
-- Cases target rows the business-rule triggers allow to change (a
-- proposed split, the open September period), so it is the CHECK / KEY
-- that rejects them, not a trigger. Nothing is left behind.
-- =====================================================================

\ir _helpers.sql

SELECT period_id AS open_period FROM royalty_periods WHERE period_start = DATE '2026-09-01' \gset
SELECT min(version_id) AS proposed_version FROM split_versions WHERE status = 'proposed' \gset

-- ---------- referential integrity ("200 dangling rows") ----------
SELECT pg_temp.expect_error('Delete a contributor who still has splits', '23503',
    $$DELETE FROM contributors WHERE email = 'rohan.gupta@example.com'$$);
SELECT pg_temp.expect_error('Delete a track that has stream data', '23503',
    $$DELETE FROM tracks WHERE isrc = 'INM0R2500001'$$);
SELECT pg_temp.expect_error('Split share for a contributor that does not exist', '23503',
    format($$INSERT INTO split_shares VALUES (%s, 999999, 'artist', 10)$$, :proposed_version));

-- ---------- CHECK constraints ----------
SELECT pg_temp.expect_error('Share above 100%', '23514',
    format($$UPDATE split_shares SET share_pct = 120 WHERE version_id = %s AND role = 'artist'$$, :proposed_version));
SELECT pg_temp.expect_error('Share of 0%', '23514',
    format($$UPDATE split_shares SET share_pct = 0 WHERE version_id = %s AND role = 'producer'$$, :proposed_version));
SELECT pg_temp.expect_error('Malformed PAN', '23514',
    $$UPDATE contributors SET pan = 'ABC123' WHERE email = 'kabir.rao@example.com'$$);
SELECT pg_temp.expect_error('Malformed ISRC', '23514',
    $$UPDATE tracks SET isrc = 'BAD-ISRC-001' WHERE isrc = 'INM0R2500002'$$);
SELECT pg_temp.expect_error('Malformed email', '23514',
    $$UPDATE contributors SET email = 'not-an-email' WHERE email = 'kabir.rao@example.com'$$);
SELECT pg_temp.expect_error('Contributor login not linked to a contributor', '23514',
    $$INSERT INTO users (email, password_hash, full_name, role) VALUES ('x@example.com', 'h', 'X', 'contributor')$$);
SELECT pg_temp.expect_error('Admin login linked to a contributor', '23514',
    $$INSERT INTO users (email, password_hash, full_name, role, contributor_id)
      VALUES ('y@example.com', 'h', 'Y', 'admin', (SELECT contributor_id FROM contributors WHERE email = 'leela.krishnan@example.com'))$$);
SELECT pg_temp.expect_error('Royalty period that is not a calendar month', '23514',
    $$INSERT INTO royalty_periods (period_start, period_end) VALUES (DATE '2026-10-05', DATE '2026-11-04')$$);
SELECT pg_temp.expect_error('Split version ending before it starts', '23514',
    $$UPDATE split_versions SET valid_to = valid_from - 1 WHERE status = 'superseded'$$);
SELECT pg_temp.expect_error('Active version with a closed date range', '23514',
    $$UPDATE split_versions SET valid_to = DATE '2030-01-01'
      WHERE version_id = (SELECT min(version_id) FROM split_versions WHERE status = 'active')$$);
SELECT pg_temp.expect_error('Track that samples itself', '23514',
    $$INSERT INTO samples SELECT track_id, track_id, 10, DATE '2026-01-01' FROM tracks WHERE isrc = 'INM0R2500002'$$);
SELECT pg_temp.expect_error('Sample owing 100% upstream', '23514',
    $$UPDATE samples SET upstream_pct = 100 WHERE upstream_pct = 30$$);
SELECT pg_temp.expect_error('Negative stream count', '23514',
    format($$UPDATE stream_stats SET streams = -1
             WHERE period_id = %s AND track_id = (SELECT track_id FROM tracks WHERE isrc = 'INM0R2500001')$$, :open_period));
SELECT pg_temp.expect_error('Unmatched line marked matched without a track', '23514',
    format($$INSERT INTO unmatched_lines (period_id, platform_id, raw_title, streams, revenue, source_report_id, status, matched_by, matched_at)
             VALUES (%s, (SELECT min(platform_id) FROM platforms), 'x', 1, 1,
                     '6719f0c2a1b2c3d4e5f60718', 'matched', (SELECT min(user_id) FROM users), now())$$, :open_period));
SELECT pg_temp.expect_error('Concentration flag without its platform', '23514',
    $$INSERT INTO fraud_flags (track_id, period_id, rule, observed_value, threshold_value)
      VALUES ((SELECT min(track_id) FROM tracks), (SELECT min(period_id) FROM royalty_periods), 'platform_concentration', 0.9, 0.8)$$);
SELECT pg_temp.expect_error('Statement whose net does not add up', '23514',
    format($$INSERT INTO statements (period_id, contributor_id, gross_earned, tds_rate_applied, tds_amount, net_payable)
             VALUES (%s, (SELECT min(contributor_id) FROM contributors), 1000, 10, 100, 950)$$, :open_period));
SELECT pg_temp.expect_error('Audit INSERT entry carrying an old row', '23514',
    $$INSERT INTO audit_log (table_name, operation, row_key, old_row, new_row) VALUES ('x', 'INSERT', '{}', '{}', '{}')$$);
SELECT pg_temp.expect_error('Phone number with letters (added by migration)', '23514',
    $$UPDATE contributors SET phone = '98ABC12345' WHERE email = 'kabir.rao@example.com'$$);
SELECT pg_temp.expect_error('Unknown track language (added by migration)', '23514',
    $$UPDATE tracks SET language = 'Klingon' WHERE isrc = 'INM0R2500001'$$);

-- ---------- UNIQUE / primary keys ----------
SELECT pg_temp.expect_error('Second contributor with the same email', '23505',
    $$INSERT INTO contributors (legal_name, email) VALUES ('Copy', 'aarav.mehta@example.com')$$);
SELECT pg_temp.expect_error('Second contributor with the same PAN', '23505',
    $$INSERT INTO contributors (legal_name, email, pan) VALUES ('Copy', 'copy@example.com', 'ABCPM1234F')$$);
SELECT pg_temp.expect_error('Same track, platform and period reported twice', '23505',
    format($$INSERT INTO stream_stats SELECT period_id, platform_id, track_id, 1, 1 FROM stream_stats WHERE period_id = %s LIMIT 1$$, :open_period));
SELECT pg_temp.expect_error('Second statement for the same contributor and period', '23505',
    format($$INSERT INTO statements (period_id, contributor_id, gross_earned, tds_rate_applied, tds_amount, net_payable)
             VALUES (%1$s, 1, 100, 10, 10, 90), (%1$s, 1, 100, 10, 10, 90)$$, :open_period));
SELECT pg_temp.expect_error('Paying the same statement twice', '23505',
    format($$WITH s AS (INSERT INTO statements (period_id, contributor_id, gross_earned, tds_rate_applied, tds_amount, net_payable)
                        VALUES (%s, 1, 100, 10, 10, 90) RETURNING statement_id)
             INSERT INTO payments (statement_id, amount, reference)
             SELECT statement_id, 90, 'UTR-' || g FROM s, generate_series(1, 2) g$$, :open_period));

-- ---------- NOT NULL ----------
SELECT pg_temp.expect_error('Contributor without a legal name', '23502',
    $$INSERT INTO contributors (legal_name, email) VALUES (NULL, 'noname@example.com')$$);

-- ---------- valid data is still accepted ----------
SELECT pg_temp.expect_ok('Valid new contributor without a PAN',
    $$INSERT INTO contributors (legal_name, email, tds_rate) VALUES ('New Artist', 'new.artist@example.com', 20)$$);
SELECT pg_temp.expect_ok('Valid statement and payment',
    format($$WITH s AS (INSERT INTO statements (period_id, contributor_id, gross_earned, recouped_amount, tds_rate_applied, tds_amount, net_payable)
                        VALUES (%s, 1, 1000.00, 200.00, 10, 80.00, 720.00) RETURNING statement_id)
             INSERT INTO payments (statement_id, amount, reference) SELECT statement_id, 720.00, 'UTR-TEST-1' FROM s$$, :open_period));

\ir _report.sql
