-- =====================================================================
-- 07_views.sql — views for the application and for access control
--
-- Plain views run with the view owner's privileges, so a role can be
-- given SELECT on a view without any access to the tables under it.
-- The v_my_* views show only the signed-in contributor's own rows;
-- they are the only thing the app_contributor role can read.
-- =====================================================================

-- ---------- ownership ----------

-- total share per version; feeds the split editor and the "splits not at 100%" check
CREATE OR REPLACE VIEW v_split_totals AS
SELECT sv.version_id, sv.track_id, t.isrc, t.title, sv.status, sv.valid_from, sv.valid_to,
       count(DISTINCT ss.contributor_id) AS contributors,
       coalesce(sum(ss.share_pct), 0)    AS total_pct
FROM split_versions sv
JOIN tracks t USING (track_id)
LEFT JOIN split_shares ss USING (version_id)
GROUP BY sv.version_id, t.isrc, t.title;

-- every track's current split, one row per share
CREATE OR REPLACE VIEW v_current_splits AS
SELECT t.track_id, t.isrc, t.title, sv.version_id, sv.valid_from,
       c.contributor_id, c.legal_name, c.stage_name, ss.role, ss.share_pct
FROM tracks t
JOIN split_versions sv ON sv.track_id = t.track_id AND sv.status = 'active'
JOIN split_shares ss   ON ss.version_id = sv.version_id
JOIN contributors c    ON c.contributor_id = ss.contributor_id;

-- proposals waiting for approval, with who has / hasn't decided
CREATE OR REPLACE VIEW v_open_proposals AS
SELECT sv.version_id, t.track_id, t.isrc, t.title, sv.valid_from, sv.created_at,
       u.full_name AS proposed_by,
       count(*) FILTER (WHERE sa.decision = 'approved') AS approved,
       count(*)                                         AS needed,
       string_agg(c.legal_name, ', ' ORDER BY c.legal_name)
           FILTER (WHERE sa.decision = 'pending')       AS waiting_on
FROM split_versions sv
JOIN tracks t           USING (track_id)
JOIN users u            ON u.user_id = sv.proposed_by
JOIN split_approvals sa USING (version_id)
JOIN contributors c     ON c.contributor_id = sa.contributor_id
WHERE sv.status = 'proposed'
GROUP BY sv.version_id, t.track_id, u.full_name;

-- ---------- money ----------

-- the derived attribute "advance balance" (docs/04-normalization.md §4.6)
CREATE OR REPLACE VIEW v_advance_balances AS
SELECT a.advance_id, a.contributor_id, c.legal_name, a.amount, a.issued_on, a.note,
       coalesce(r.recouped, 0)            AS recouped,
       a.amount - coalesce(r.recouped, 0) AS outstanding
FROM advances a
JOIN contributors c USING (contributor_id)
LEFT JOIN (SELECT advance_id, sum(amount) AS recouped
           FROM advance_recoupments GROUP BY advance_id) r USING (advance_id);

-- statement totals per contributor per period
CREATE OR REPLACE VIEW v_contributor_earnings AS
SELECT s.statement_id, s.period_id, rp.period_start, to_char(rp.period_start, 'Mon YYYY') AS period_label,
       s.contributor_id, c.legal_name, c.stage_name,
       s.gross_earned, s.held_amount, s.released_amount, s.recouped_amount,
       s.tds_rate_applied, s.tds_amount, s.net_payable,
       p.payment_id, p.reference AS payment_reference, p.paid_at
FROM statements s
JOIN royalty_periods rp USING (period_id)
JOIN contributors c     USING (contributor_id)
LEFT JOIN payments p    USING (statement_id);

-- streams and revenue per track per period (dashboard, charts)
CREATE OR REPLACE VIEW v_track_period_revenue AS
SELECT s.track_id, t.isrc, t.title, s.period_id, rp.period_start,
       sum(s.streams) AS streams,
       sum(s.revenue) AS revenue
FROM stream_stats s
JOIN tracks t           USING (track_id)
JOIN royalty_periods rp USING (period_id)
GROUP BY s.track_id, t.isrc, t.title, s.period_id, rp.period_start;

-- ---------- the signed-in contributor's own data ----------
-- app_user_id() comes from SET LOCAL app.user_id, set by the API per request.

CREATE OR REPLACE VIEW v_my_contributor WITH (security_barrier) AS
SELECT c.contributor_id
FROM users u JOIN contributors c USING (contributor_id)
WHERE u.user_id = app_user_id() AND u.is_active;

CREATE OR REPLACE VIEW v_my_statements WITH (security_barrier) AS
SELECT e.*
FROM v_contributor_earnings e
WHERE e.contributor_id = (SELECT contributor_id FROM v_my_contributor);

CREATE OR REPLACE VIEW v_my_statement_lines WITH (security_barrier) AS
SELECT sl.statement_id, sl.line_no, t.isrc, t.title, sl.role, ss.share_pct,
       via.title AS via_track, sl.amount, sl.is_held
FROM statement_lines sl
JOIN statements s     USING (statement_id)
JOIN split_versions sv USING (version_id)
JOIN tracks t         ON t.track_id = sv.track_id
JOIN split_shares ss  ON ss.version_id = sl.version_id
                     AND ss.contributor_id = s.contributor_id
                     AND ss.role = sl.role
LEFT JOIN tracks via  ON via.track_id = sl.via_track_id
WHERE s.contributor_id = (SELECT contributor_id FROM v_my_contributor);

CREATE OR REPLACE VIEW v_my_splits WITH (security_barrier) AS
SELECT t.track_id, t.isrc, t.title, sv.version_id, sv.status, sv.valid_from, sv.valid_to,
       ss.role, ss.share_pct, sa.decision AS my_decision, sa.decided_at
FROM split_shares ss
JOIN split_versions sv USING (version_id)
JOIN tracks t          USING (track_id)
LEFT JOIN split_approvals sa
       ON sa.version_id = ss.version_id AND sa.contributor_id = ss.contributor_id
WHERE ss.contributor_id = (SELECT contributor_id FROM v_my_contributor)
  AND sv.status <> 'rejected';

CREATE OR REPLACE VIEW v_my_advances WITH (security_barrier) AS
SELECT advance_id, amount, issued_on, note, recouped, outstanding
FROM v_advance_balances
WHERE contributor_id = (SELECT contributor_id FROM v_my_contributor);

-- full proposal (everyone's shares) for proposals the contributor must decide on
CREATE OR REPLACE VIEW v_my_pending_proposals WITH (security_barrier) AS
SELECT sv.version_id, t.isrc, t.title, sv.valid_from,
       c.legal_name, ss.role, ss.share_pct,
       (c.contributor_id = me.contributor_id) AS is_me
FROM v_my_contributor me
JOIN split_approvals mine ON mine.contributor_id = me.contributor_id AND mine.decision = 'pending'
JOIN split_versions sv    ON sv.version_id = mine.version_id AND sv.status = 'proposed'
JOIN tracks t             ON t.track_id = sv.track_id
JOIN split_shares ss      ON ss.version_id = sv.version_id
JOIN contributors c       ON c.contributor_id = ss.contributor_id;
