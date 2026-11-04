-- =====================================================================
-- 10_demo_payouts.sql — payout history for the demo
--
-- Pays October 2025 .. August 2026 through the real process_payout()
-- procedure, one transaction per month, acting as the admin, so the
-- app starts with statements, recoupments and payments to show.
-- September 2026 is left open with its planted stream spikes: fraud
-- detection runs on it here, and paying it is the live demo.
-- =====================================================================

SELECT set_config('app.user_id', user_id::text, false) AS admin_id
FROM users WHERE email = 'admin@monsoonrecords.test' \gset

\echo 'month    | statements |        gross |  held |          net'
SELECT format($f$
    BEGIN;
    UPDATE royalty_periods SET status = 'locked' WHERE period_id = %1$s;
    CALL process_payout(%1$s);
    COMMIT;$f$, period_id)
FROM royalty_periods
WHERE period_start < DATE '2026-09-01'
ORDER BY period_start \gexec

-- flag September's suspicious tracks so the fraud review page has work
SELECT detect_fraud(period_id) AS september_flags
FROM royalty_periods WHERE period_start = DATE '2026-09-01';
