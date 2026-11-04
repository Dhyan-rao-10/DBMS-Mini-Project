# 6. Database logic: triggers, functions, payout, views and roles

Everything here lives in the database, so the rules hold no matter which client changes the data:
the web app, `psql`, or a future mobile app. Files are in `db/postgres/`; they run in this order:

| File | Contents |
|---|---|
| `01_schema.sql` | Tables and declarative constraints (doc 03) |
| `02_seed.sql`, `03_bulk_generate.sql` | Demo data and ~2.1 lakh generated stream rows |
| `04_migration_alter_drop.sql` | v1.0 → v1.1 with `ALTER` / `DROP` on live data |
| `05_triggers.sql` | Business rules R1–R15 and the audit trail |
| `06_functions.sql` | Functions and the `process_payout` procedure |
| `07_views.sql` | Views, including the per-contributor `v_my_*` views |
| `08_indexes.sql` | Secondary, partial, GIN and HNSW indexes (doc 07) |
| `09_roles_grants.sql` | Database roles and privileges |
| `10_demo_payouts.sql` | Pays Oct 2025 – Aug 2026 through the real procedure |

Data is loaded **before** the triggers, so the audit trail records application changes, not the seed.

## 6.1 Triggers (business rules)

| Rule | Trigger | Kind | What it does |
|---|---|---|---|
| R1 | `r1_split_shares_total`, `r1_split_versions_have_shares` | `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` | At `COMMIT`, every split version touched must total exactly 100.00%. Deferred because shares are inserted one row at a time. `propose_split_version` forces it early with `SET CONSTRAINTS … IMMEDIATE` so the user sees the error straight away |
| R2 | `r2_r5_split_versions_rules` | `BEFORE INSERT OR UPDATE` | Live versions of a track never overlap in time |
| R3 | `r3_split_shares_sync_approvals`, `r3_split_approvals_decide`, `r3_split_approvals_after` | `AFTER` / `BEFORE` | One approval row per contributor; editing a proposal resets everyone to pending; decisions are final; the last approval calls `activate_split_version()`, which closes the old version (`valid_to`, `superseded`) and activates the new one; any rejection rejects the proposal |
| R4 | `r4_split_shares_frozen`, `r4_split_versions_no_delete` | `BEFORE` | Shares of a non-proposed version can't change; only proposals can be deleted; status follows proposed → active/rejected, active → superseded |
| R5 | `r2_r5_split_versions_rules` | `BEFORE INSERT` | New versions start on the 1st of a month, after the last paid period, open-ended; one open proposal per track |
| R6 | `r6_tracks_status` | `BEFORE INSERT OR UPDATE OF status` | A track can be `active` only with an active split |
| R7 | `r7_r8_samples_rules` | `BEFORE` | A `WITH RECURSIVE` walk up the sample graph rejects an edge that would close a loop |
| R8 | same | `BEFORE` | A track's total upstream share stays below 100% |
| R9 | `r9_recoupments_limit` | `BEFORE` | Locks the advance row (`FOR UPDATE`) and rejects recoupments beyond the advance |
| R10 | `r10_stream_stats_period_open`, `r10_unmatched_lines_period_open` | `BEFORE` | Report data changes only while its period is `open` |
| R11 | `r11_payment_amount` | `BEFORE INSERT` | A payment equals its statement's `net_payable` |
| R12 | `r12_contributor_managers_one_per_platform`, `r12_staff_platforms_desk_move` | `BEFORE` / `AFTER` | Enforces {contributor, platform} → manager, the FD lost by the BCNF decomposition (doc 04 §4.7) |
| R13 | `r13_*_staff_only` | `BEFORE` | Only staff sit on desks or manage contributors |
| R14 | `r14_period_lifecycle`, `r14_*_immutable` | `BEFORE` | open ⇄ locked → paid; paid is final; statements, lines, payments and recoupments can never be updated or deleted |
| F3 | `f3_fraud_flags_review`, `f3_fraud_flags_forfeit` | `BEFORE` / `AFTER` | Reviews record who and when and are final; confirming a flag forfeits the money held against it |
| R15 | `r15_audit` on 17 tables | `AFTER INSERT OR UPDATE OR DELETE`, `SECURITY DEFINER` | Writes old/new row as JSONB, the key, the acting user (`app.user_id`) and the transaction id. Password hashes, embeddings and search vectors are left out; a password change is recorded as `"password_changed": true` |

`stream_stats` is deliberately not audited row by row: one report load writes thousands of rows, and the
raw report kept in MongoDB is its audit trail.

Errors use standard SQLSTATEs (`23514` check violation for broken rules, `55000` for wrong lifecycle
state, `42501` for permissions) and carry a constraint name such as `r7_samples_no_cycle`, so the API can
turn them into clear messages.

## 6.2 Functions and procedures

| Routine | Type | Used for |
|---|---|---|
| `app_user_id()` | SQL function | Reads `SET LOCAL app.user_id`, which the API sets in every transaction |
| `fn_version_at(track, date)` | SQL function | The split version in effect on a date |
| `fn_advance_outstanding(contributor)` | SQL function | Unrecouped advance balance |
| `fn_effective_tds_rate(contributor)` | SQL function | TDS rate, at least 20% without a PAN |
| `search_catalogue(text)` | PL/pgSQL, returns a table | Full-text prefix search over tracks and contributors (`to_tsquery` with `:*`, `ts_rank`) |
| `propose_split_version(track, from, shares jsonb)` | PL/pgSQL | Creates a proposal and its shares in one call; approval rows appear automatically |
| `approve_split(version, decision)` | PL/pgSQL, `SECURITY DEFINER` | The signed-in contributor's decision; the only write a contributor can make |
| `activate_split_version(version)` | PL/pgSQL | Called by the approval trigger |
| `detect_fraud(period)` | PL/pgSQL | F3 rules (below); returns the number of new flags |
| `confirm_unmatched_line(line, track)` / `write_off_unmatched_line(line)` | PL/pgSQL | F4: assign or write off a report line, in one transaction with the `stream_stats` upsert |
| `process_payout(period)` | **Procedure** (`CALL`) | Pays one period (below) |
| `authenticate(email, password)` | SQL function, `SECURITY DEFINER` | Sign-in: compares with pgcrypto `crypt()` inside the database and returns only the identity; the hash never leaves Postgres |

### F3 fraud rules (`detect_fraud`)

- **Stream spike.** For each track, the month's total streams is compared with that track's own
  history using window functions over earlier months only
  (`ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING`): `avg`, `stddev_samp` and `lag`. A flag is raised
  when the z-score exceeds 4 *and* streams more than doubled since last month.
- **Platform concentration.** A `GROUP BY … HAVING max(streams) / sum(streams) > 0.75` finds tracks where
  one platform dominates this month. A window average gives that platform's usual share, and the flag is
  raised only when the current share is more than twice that.

On the generated data this flags exactly the 9 planted spikes, both rules each, with no false positives
(z-scores 30–130, shares 0.85–0.87).

## 6.3 `process_payout`: the core transaction

`CALL process_payout(period_id)` does everything below in the caller's transaction. Any error rolls back
the whole payout.

1. **Lock.** `SELECT … FROM royalty_periods WHERE period_id = $1 FOR UPDATE`. A second payout of
   the same period blocks here, then sees `paid` and is refused (R14). The period must be `locked`, earlier
   periods must be paid, and it must have no unmatched report lines.
2. **Fraud detection** for the period.
3. **Sample chain (F2).** A recursive CTE pushes each track's revenue up the sample graph: a track keeps
   `1 − (its upstream %)` of whatever reaches it and passes the rest on, so the money is conserved at every hop.
4. **Split in effect (F1).** Each track's kept amount is split by the version valid on the period's last day.
5. **Exact paise (F6).** Every line is floored to whole paise; the leftover paise of each track
   (`round(total) − Σ floor`) go one each to the lines with the largest fractional parts (`row_number()`
   over the fractions). Every track's revenue is paid out to the paisa.
6. **Holds (F3).** Lines from tracks with an open flag are held; earlier holds whose flag was cleared are
   released into this run.
7. **Recoupment.** Advances are recouped oldest-first with a running total
   (`sum(outstanding) OVER (PARTITION BY contributor ORDER BY issued_on)`).
8. **TDS, statements, lines, payments.** The statement row's `CHECK` guarantees
   `net = gross − held + released − recouped − tds`; R11 guarantees each payment equals it.
9. Mark the period `paid` with who and when.

Results on the demo data (11 months, 412 contributors, about 10,500 lines per month): the difference
between revenue and money allocated is **₹0.00 in every month**; each run takes about 2.5 s.

## 6.4 Views

| View | Purpose |
|---|---|
| `v_split_totals` | Total share per version (split editor; "splits not at 100%" query) |
| `v_current_splits` | Each track's active split with contributor names |
| `v_open_proposals` | Proposals waiting for approval, with who hasn't decided (`string_agg … FILTER`) |
| `v_advance_balances` | The derived attribute "advance balance" (doc 04 §4.6) |
| `v_contributor_earnings` | Statements with period label and payment |
| `v_track_period_revenue` | Streams and revenue per track per month |
| `v_my_contributor`, `v_my_statements`, `v_my_statement_lines`, `v_my_splits`, `v_my_advances`, `v_my_pending_proposals` | Only the signed-in contributor's rows (`WITH (security_barrier)`); the only things `app_contributor` can read |

## 6.5 Database roles

The web app connects as `royalty_app`, a `NOINHERIT` login with no privileges of its own. Every API request
runs `SET LOCAL ROLE app_admin | app_staff | app_contributor` inside its transaction, so the
**database** decides what each kind of user can do. The app's own checks are a second layer.

| | app_admin | app_staff | app_contributor | app_report |
|---|---|---|---|---|
| Catalogue, splits, samples | read/write | read/write (proposals only) | own rows via views | read |
| Approve a split | — | — | `approve_split()` only | — |
| Report intake, matching | read/write | read/write | — | read |
| Run payouts, review fraud | yes | no | no | no |
| `users.password_hash` | yes | **no** (column-level grant) | no | **no** |
| `audit_log` | read only, **cannot edit or delete** | no | no | read |

## 6.6 Tests

`bash db/postgres/test.sh` runs four files. Every case runs in its own subtransaction or in a transaction
that is rolled back, so the demo data is never changed.

| File | Cases | Covers |
|---|---|---|
| `01_constraints_test.sql` | 30 | Every kind of declarative constraint: FK, CHECK, UNIQUE, NOT NULL, plus valid data still accepted |
| `02_business_rules_test.sql` | 42 | R1–R15 and the full propose → approve → activate / reject workflow, including approving every row in one `UPDATE` |
| `03_payout_test.sql` | 14 | Pays September (with the fraud spikes): paisa-exact allocation, holds, sample chain, TDS, recoupment, double-payment refusal; then releases cleared holds in a new October run |
| `04_access_test.sql` | 22 | Each database role can and cannot do what §6.5 says, including the login role |

All 108 cases pass.

`bash db/postgres/demo_concurrency.sh` runs two real sessions against each other. Session B waited
**5.0 s** for session A's row lock. With `--commit`, B then sees `paid` and is refused with
"Period 12 (Sep 2026) has already been paid".
