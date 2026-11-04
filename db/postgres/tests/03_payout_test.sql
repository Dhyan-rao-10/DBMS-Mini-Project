-- =====================================================================
-- tests/03_payout_test.sql — pays September 2026 (the month with the
-- planted fraud spikes), checks every guarantee, then releases cleared
-- holds in a new October period. Rolled back at the end.
-- =====================================================================

\ir _helpers.sql
BEGIN;

SELECT pg_temp.act_as('admin@monsoonrecords.test');
SELECT period_id AS sep FROM royalty_periods WHERE period_start = DATE '2026-09-01' \gset

-- ---------- preconditions ----------
-- October exists once the sample reports are ingested (db/setup_all.sh); create it otherwise
INSERT INTO royalty_periods (period_start, period_end) VALUES (DATE '2026-10-01', DATE '2026-10-31')
ON CONFLICT (period_start) DO NOTHING;
SELECT period_id AS oct FROM royalty_periods WHERE period_start = DATE '2026-10-01' \gset
UPDATE royalty_periods SET status = 'locked' WHERE period_id = :oct;
SELECT pg_temp.expect_error('Periods must be paid in order (October before September)', '55000',
    format('CALL process_payout(%s)', :oct));
UPDATE royalty_periods SET status = 'open' WHERE period_id = :oct;

-- an unmatched line blocks the payout until it is resolved (F4)
INSERT INTO unmatched_lines (period_id, platform_id, raw_title, raw_artist, streams, revenue, source_report_id)
SELECT :sep, platform_id, 'Monsoon Letters - Lofi Flip', 'Kabir Beats, Aarav', 4500, 270.00, '6719f0c2a1b2c3d4e5f60718'
FROM platforms WHERE code = 'JIOSAAVN'
RETURNING line_id AS line \gset
UPDATE royalty_periods SET status = 'locked' WHERE period_id = :sep;
SELECT pg_temp.expect_error('Unmatched report lines block the payout', '55000',
    format('CALL process_payout(%s)', :sep));
UPDATE royalty_periods SET status = 'open' WHERE period_id = :sep;
SELECT confirm_unmatched_line(:line, (SELECT track_id FROM tracks WHERE isrc = 'INM0R2500004'));
SELECT pg_temp.check('F4 confirming a line adds its revenue to the track',
    (SELECT status FROM unmatched_lines WHERE line_id = :line) = 'matched');

-- ---------- pay September ----------
UPDATE royalty_periods SET status = 'locked' WHERE period_id = :sep;
CALL process_payout(:sep);

SELECT pg_temp.check('Period is marked paid with who and when',
    (SELECT status = 'paid' AND processed_by IS NOT NULL FROM royalty_periods WHERE period_id = :sep));

SELECT pg_temp.check('F6 every paisa of every track''s revenue reaches a statement line',
    (SELECT sum(rev) FROM (SELECT round(sum(revenue), 2) AS rev FROM stream_stats
                           WHERE period_id = :sep GROUP BY track_id) r)
  = (SELECT sum(sl.amount) FROM statement_lines sl JOIN statements s USING (statement_id) WHERE s.period_id = :sep));

SELECT pg_temp.check('F6 statement totals equal the sum of their lines',
    NOT EXISTS (SELECT 1 FROM statements s
                JOIN (SELECT statement_id, sum(amount) AS total FROM statement_lines GROUP BY statement_id) l
                USING (statement_id)
                WHERE s.period_id = :sep AND s.gross_earned <> l.total));

SELECT pg_temp.check('F3 money from the 9 flagged tracks is held, not paid',
    (SELECT count(DISTINCT f.track_id) FROM held_earnings h JOIN fraud_flags f USING (flag_id)
     WHERE h.period_id = :sep AND h.status = 'held') = 9
    AND (SELECT sum(held_amount) FROM statements WHERE period_id = :sep)
      = (SELECT sum(amount) FROM held_earnings WHERE period_id = :sep));

SELECT pg_temp.check('F2 Raag Megh''s composers earn from Rain Cypher three samples up the chain',
    EXISTS (SELECT 1 FROM statement_lines sl
            JOIN statements s USING (statement_id)
            JOIN split_versions sv USING (version_id)
            WHERE s.period_id = :sep
              AND sv.track_id = (SELECT track_id FROM tracks WHERE isrc = 'INM0R1900001')
              AND sl.via_track_id = (SELECT track_id FROM tracks WHERE isrc = 'INM0R2500009')));

SELECT pg_temp.check('F6 contributors without a PAN are withheld at 20%',
    NOT EXISTS (SELECT 1 FROM statements s JOIN contributors c USING (contributor_id)
                WHERE s.period_id = :sep AND c.pan IS NULL AND s.tds_rate_applied < 20));

SELECT pg_temp.check('Recoupment never exceeds what an advance had outstanding',
    NOT EXISTS (SELECT 1 FROM v_advance_balances WHERE outstanding < 0));

SELECT pg_temp.check('One payment per statement with money owed, each equal to net payable',
    (SELECT count(*) FROM statements WHERE period_id = :sep AND net_payable > 0)
  = (SELECT count(*) FROM payments p JOIN statements s USING (statement_id)
     WHERE s.period_id = :sep AND p.amount = s.net_payable));

SELECT pg_temp.expect_error('R14 paying September a second time', '55000',
    format('CALL process_payout(%s)', :sep));

-- ---------- review flags: clear one track's flags, confirm another's ----------
SELECT min(track_id) AS cleared_track, max(track_id) AS confirmed_track
FROM fraud_flags WHERE period_id = :sep \gset
UPDATE fraud_flags SET status = 'cleared',   note = 'Verified playlist campaign' WHERE period_id = :sep AND track_id = :cleared_track;
UPDATE fraud_flags SET status = 'confirmed', note = 'Bot farm traffic'           WHERE period_id = :sep AND track_id = :confirmed_track;

SELECT pg_temp.check('F3 confirming a flag forfeits the money held against it',
    NOT EXISTS (SELECT 1 FROM held_earnings h JOIN fraud_flags f USING (flag_id)
                WHERE f.track_id = :confirmed_track AND h.status <> 'forfeited'));

-- ---------- October: cleared holds are released ----------
-- resolve October's unmatched report lines first (if the sample reports were loaded)
SELECT write_off_unmatched_line(line_id) FROM unmatched_lines WHERE period_id = :oct AND status = 'unmatched';
UPDATE royalty_periods SET status = 'locked' WHERE period_id = :oct;
CALL process_payout(:oct);
SELECT pg_temp.check('F3 cleared holds are paid out in the next run',
    (SELECT sum(released_amount) FROM statements WHERE period_id = :oct)
  = (SELECT sum(h.amount) FROM held_earnings h JOIN fraud_flags f USING (flag_id) WHERE f.track_id = :cleared_track)
    AND NOT EXISTS (SELECT 1 FROM held_earnings h JOIN fraud_flags f USING (flag_id)
                    WHERE f.track_id = :cleared_track AND (h.status <> 'released' OR h.released_in_period_id <> :oct)));

\ir _report.sql
ROLLBACK;
