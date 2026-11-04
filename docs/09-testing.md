# 9. Testing results

All results below were produced on the demo data built by `bash db/setup_all.sh`.

## 9.1 Automated SQL tests: 108 / 108 pass

```bash
bash db/postgres/test.sh
```

Each case runs in its own subtransaction (or a transaction rolled back at the end), so the tests never
change the data.

| File | Cases | What it proves |
|---|---|---|
| `01_constraints_test.sql` | 30 | Foreign keys (e.g. deleting a contributor who still has splits is refused), CHECKs (shares 0–100, PAN/ISRC/email formats, a statement's net must add up), UNIQUE (one statement per contributor per month, one payment per statement), NOT NULL; and valid data is still accepted |
| `02_business_rules_test.sql` | 42 | Triggers R1–R15: 100% splits, no overlapping versions, frozen live splits, approval workflow (incl. approving all rows in one UPDATE), sample loops blocked, recoupment limits, paid months immutable, audit rows written with the acting user and without password hashes |
| `03_payout_test.sql` | 14 | Pays September: every paisa of revenue reaches a statement line, fraud-flagged money is held, sample-chain money reaches Raag Megh's composers 3 hops up, no-PAN contributors taxed at 20%, paying twice is refused; then a cleared flag's money is released in October |
| `04_access_test.sql` | 22 | Each database role: contributors read only their `v_my_*` views, staff can't see password hashes / run payouts / read the audit log, even admins can't edit or delete audit rows, the login role can only call `authenticate()` |

## 9.2 Concurrency (X3)

`bash db/postgres/demo_concurrency.sh --commit`: two sessions pay September at once. Session B waits
**5.0 s** on A's row lock, then sees `paid` and is refused: *"Period 12 (Sep 2026) has already been paid"*.
In the web app, two simultaneous `POST /api/periods/12 {"action":"pay"}` requests gave one **200**
(412 statements) and one **409** with the same message.

## 9.3 Web app and API

Every page was requested as admin, staff and contributor. Admin got 200 on all 17 URLs. Staff and
contributors were redirected away from pages outside their role, and anonymous visitors went to `/login`.
The browser console showed no errors on any page. The write paths were exercised through the API: login
and rate limiting, propose (90% and mid-month splits refused by the database), simulate, approve,
upload, duplicate upload refused, matching, fraud review, payout race, deactivation. The full table is in
[08-web-app.md §8.5](08-web-app.md#85-verified-behaviour-manual-run-against-the-demo-data).

## 9.4 Other measured results

| Check | Result | Where |
|---|---|---|
| Payout exactness, 11 months | Revenue − money allocated = **₹0.00** every month | doc 06 §6.3 |
| Fraud detection | Flags exactly the 9 planted spikes (18 flags), no false positives | doc 06 §6.2 |
| Reconciliation | Catches Spotify's truncated file (declared 9,456,364 vs received 9,444,019 streams) | doc 05 §5.1 |
| Vector matching | Top suggestion correct for **9/9** real lines; the non-label line scores "weak" (0.54) | doc 05 §5.3 |
| HNSW recall vs exact search | 6/10 at `ef_search` 40 → 10/10 at 400 | doc 05 §5.3 |
| Index speed-ups | One track's history 21.3 ms → 0.30 ms (index-only scan) | doc 07 |

## 9.5 Bugs found by testing and fixed

| Bug | Found by | Fix |
|---|---|---|
| Approving every row in one UPDATE tried to activate the split twice | What-if simulator | `activate_split_version()` made idempotent; test added |
| HNSW missed the true nearest track for 4 of 10 lines | Comparing with exact search | `hnsw.ef_search = 400` for matching |
| Dates shown one day early | Reading the rendered track page | DATE columns returned as strings |
| Same report could be uploaded twice | API upload test (reconciliation flagged it) | Upload refuses a platform+month already loaded |

## 9.6 Screenshots

In [`docs/screenshots/`](screenshots/):

| File | Shows |
|---|---|
| `01-login.png` | Sign-in page |
| `02-dashboard.png` | KPIs, revenue by platform, top tracks (Redis) |
| `03-tracks.png` | Track list with full-text search and filters |
| `04-track-detail.png` | Split, sample chain, streams per month, payouts, split history |
| `05-what-if-simulator.png` | Simulated payout for a changed split (rolled back) |
| `06-contributor.png` | Contributor detail with Neo4j collaborators |
| `07-network.png` | Shortest path Tara → Leela through the sample chain (Neo4j) |
| `08-reports-reconciliation.png` | Report upload and 3-way reconciliation |
| `09-unmatched-vector-matches.png` | Unmatched lines with pgvector suggestions |
| `10-fraud-review.png` | Flags with z-scores and platform shares |
| `11-payouts.png` | Months, totals, lock/pay, statements |
| `12-audit-log.png` | Trigger-written history with field diffs |
| `13-users.png` | User management |
| `14-staff-dashboard.png` | Staff view (no payouts / audit / users in the menu) |
| `15-contributor-portal-approval.png` | Contributor portal with a split waiting for approval |
| `16-contributor-statement.png` | One statement's breakdown and lines |
