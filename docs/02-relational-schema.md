# 2. Relational Schema

Notation: <u>underlined</u> = primary key, `→ table` = foreign key, *UK* = unique (candidate key).
Column types and every constraint are in [03-data-dictionary.md](03-data-dictionary.md).
The ER model these tables come from is in [01-er-model.md](01-er-model.md).

## 2.1 Tables (26)

### People and access
- **contributors** (<u>contributor_id</u>, legal_name, stage_name, email UK, pan UK, tds_rate, created_at)
- **users** (<u>user_id</u>, email UK, password_hash, full_name, role, contributor_id → contributors UK, is_active, created_at)
- **staff_platforms** (<u>user_id</u> → users, platform_id → platforms)
- **contributor_managers** (<u>contributor_id</u> → contributors, <u>user_id</u> → users)

### Catalogue
- **releases** (<u>release_id</u>, upc UK, title, release_type, release_date)
- **tracks** (<u>track_id</u>, isrc UK, title, release_id → releases, duration_sec, status, search_vector, created_at)
- **genres** (<u>genre_id</u>, name UK)
- **track_genres** (<u>track_id</u> → tracks, <u>genre_id</u> → genres)
- **platforms** (<u>platform_id</u>, code UK, name UK)
- **track_platforms** (<u>track_id</u> → tracks, <u>platform_id</u> → platforms, available_from)
- **track_embeddings** (<u>track_id</u> → tracks, embedding, source_text, model, embedded_at)

### Ownership (F1, F2)
- **split_versions** (<u>version_id</u>, track_id → tracks, valid_from, valid_to, status, proposed_by → users, created_at, activated_at)
- **split_shares** (<u>version_id</u> → split_versions, <u>contributor_id</u> → contributors, <u>role</u>, share_pct)
- **split_approvals** (<u>version_id</u> → split_versions, <u>contributor_id</u> → contributors, decision, decided_at)
- **samples** (<u>sampling_track_id</u> → tracks, <u>sampled_track_id</u> → tracks, upstream_pct, cleared_on)

### Revenue intake (F3, F4)
- **royalty_periods** (<u>period_id</u>, period_start UK, period_end, status, processed_by → users, processed_at)
- **stream_stats** (<u>period_id</u> → royalty_periods, <u>platform_id</u> → platforms, <u>track_id</u> → tracks, streams, revenue, source_report_id)
- **unmatched_lines** (<u>line_id</u>, period_id → royalty_periods, platform_id → platforms, raw_title, raw_artist, streams, revenue, source_report_id, embedding, status, matched_track_id → tracks, matched_by → users, matched_at)
- **fraud_flags** (<u>flag_id</u>, track_id → tracks, period_id → royalty_periods, platform_id → platforms, rule, observed_value, threshold_value, status, reviewed_by → users, reviewed_at, note, created_at) UK (track_id, period_id, rule)

### Payouts (F3, F6)
- **held_earnings** (<u>hold_id</u>, flag_id → fraud_flags, contributor_id → contributors, period_id → royalty_periods, amount, status, released_in_period_id → royalty_periods)
- **advances** (<u>advance_id</u>, contributor_id → contributors, amount, issued_on, note)
- **advance_recoupments** (<u>advance_id</u> → advances, <u>period_id</u> → royalty_periods, amount)
- **statements** (<u>statement_id</u>, period_id → royalty_periods, contributor_id → contributors, gross_earned, held_amount, released_amount, recouped_amount, tds_rate_applied, tds_amount, net_payable, generated_at) UK (period_id, contributor_id)
- **statement_lines** (<u>statement_id</u> → statements, <u>line_no</u>, version_id → split_versions, role, via_track_id → tracks, amount, is_held)
- **payments** (<u>payment_id</u>, statement_id → statements UK, amount, paid_at, reference UK)

### Audit
- **audit_log** (<u>audit_id</u>, table_name, operation, row_key, old_row, new_row, changed_by, changed_at, tx_id)

## 2.2 Referential actions

| Kind of FK | `ON DELETE` | Reason |
|---|---|---|
| Weak entity → owner (split_shares, statement_lines, track_embeddings) | `CASCADE` | The child has no meaning without its owner |
| Junction rows that describe the owner (track_genres, track_platforms) | `CASCADE` | Deleting a draft track removes its tags too |
| Everything that touches money or history (shares, statements, payments, stream_stats, advances, samples …) | `RESTRICT` | The "200 dangling rows" problem from the Excel comparison: the DB refuses the delete |
| Optional "who did it" links (proposed_by, reviewed_by, matched_by, processed_by) | `RESTRICT` | Users are deactivated (`is_active = false`), never deleted |

`audit_log.changed_by` is deliberately **not** a foreign key: the audit trail must survive whatever
happens to the rows it records.

## 2.3 Business rules enforced in the database

Rules a `CHECK` or key can't express are enforced by triggers or functions. How each one works is in
[06-database-logic.md](06-database-logic.md).

| # | Rule | Mechanism |
|---|---|---|
| R1 | A split version's shares total exactly 100.00% | Deferred constraint trigger on `split_shares`, checked at `COMMIT` |
| R2 | Two non-rejected versions of the same track can't overlap in time | Trigger on `split_versions` |
| R3 | A version becomes `active` only when every contributor on it has approved; the previous active version is closed (`valid_to`) and marked `superseded` | Trigger on `split_approvals` |
| R4 | Shares of a non-`proposed` version can't change | Trigger on `split_shares` |
| R5 | A version can't start on or before the end of the last paid period (paid history is immutable) | Trigger on `split_versions` |
| R6 | A track can be `active` only if it has an active split version | Trigger on `tracks` |
| R7 | The sample graph has no cycles | Trigger on `samples` using a recursive CTE |
| R8 | A track's total upstream sample share is below 100% | Trigger on `samples` |
| R9 | Recoupments never exceed the advance | Trigger on `advance_recoupments` |
| R10 | Report data can be loaded only into an `open` period | Trigger on `stream_stats`, `unmatched_lines` |
| R11 | A payment's amount equals its statement's `net_payable` | Trigger on `payments` |
| R12 | A contributor has at most one manager per platform (the FD lost in the BCNF decomposition, see [04-normalization.md](04-normalization.md)) | Trigger on `contributor_managers` |
| R13 | Only `staff` users can appear in `staff_platforms` / `contributor_managers` | Trigger |
| R14 | A period is paid once | `process_payout` locks the period row `FOR UPDATE` + `UNIQUE (period_id, contributor_id)` on statements + `UNIQUE (statement_id)` on payments |
| R15 | Every change to money or ownership tables is recorded | `AFTER INSERT OR UPDATE OR DELETE` audit triggers |

## 2.4 Views (planned)

| View | Purpose |
|---|---|
| `v_current_splits` | Each track's active version with its shares and contributor names |
| `v_advance_balances` | Advance amount − recouped so far, per advance and per contributor (the derived attribute) |
| `v_contributor_earnings` | Statement totals per contributor per period |
| `v_split_totals` | Sum of shares per version; used by the split editor and the "splits ≠ 100%" query |
| `v_my_statements`, `v_my_splits`, `v_my_payments` | Filtered to the logged-in contributor; the `app_contributor` DB role is granted `SELECT` on these views only |

## 2.5 Database roles

| DB role | Granted | Used by |
|---|---|---|
| `app_admin` | All tables, all functions | API routes running as Admin |
| `app_staff` | Catalogue, ownership and intake tables; no `payments`, no `audit_log` | API routes running as Label Staff |
| `app_contributor` | `SELECT` on the `v_my_*` views; `EXECUTE` on `approve_split()` (no table access at all) | Contributor portal |
| `app_report` | Read-only on everything except `users.password_hash` | Dashboards, reconciliation |
| `app_login` | `EXECUTE` on `authenticate()` only | The sign-in request, before anyone is identified |
