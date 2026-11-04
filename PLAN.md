# Project Plan — Music Royalty Split & Payout System

DBMS Experiential Learning, Level 3 (PES University). 2-member team.
Stack: **PostgreSQL 16 + pgvector · MongoDB 7 · Neo4j 5 · Redis 7 · Next.js 16**.

## 1. Problem statement

A record label pays many contributors (artists, producers, songwriters, composers) out of monthly
streaming revenue reported by several platforms. Splits change over time and every version must total
exactly 100% and be agreed by everyone on it. Tracks that sample other tracks owe a share upstream.
Advances must be recouped, suspicious stream spikes must be held back, report lines that can't be
matched to a track must still reach the right people, and a royalty period must never be paid twice.
With lakhs of play-count rows per month and several staff working at once, a spreadsheet cannot
guarantee any of this.

## 2. Why a real DBMS, not Excel macros (mentor's question)

| Excel weakness | What the database gives us | Where we demo it |
|---|---|---|
| Nothing stops deleting a Contributor row while 200 rows still reference it | Foreign keys with `ON DELETE RESTRICT` across Track → Split → Contributor → Payment → Advance | Delete a contributor with splits → rejected |
| No locking — two people can process payouts for the same period at once | Transaction + `SELECT … FOR UPDATE` on the period row; `UNIQUE` statement per contributor per period | Two sessions run payout concurrently → second blocks, then fails cleanly |
| "Splits must total 100%" is a manual check someone forgets | Deferred constraint trigger checked at COMMIT | Split editor shows the DB rejecting 90% / 110% |
| VLOOKUP / pivots fall over on lakhs of play counts | Joins + composite indexes | `EXPLAIN ANALYZE` before vs after indexes on ~2 lakh rows |
| File permissions can't express Admin vs Label Staff vs Contributor | DB roles + `GRANT` on views, plus app-level RBAC | Contributor login sees only their own rows |
| Spreadsheet edit history isn't a reliable audit | Audit triggers write old/new row + who changed it | Audit log page |

## 3. Database choice and justification

| Data | Store | Why this paradigm |
|---|---|---|
| Contributors, tracks, split versions, samples, periods, statements, advances, payments, users, audit | **PostgreSQL** | Money and relationships: ACID, FKs, CHECKs, triggers, locking. Source of truth. |
| Track and unmatched-line embeddings | **pgvector** (inside Postgres) | Vector search *with a relational DB*: vectors sit next to the rows they describe, so a match joins straight back to tracks and splits |
| Raw platform reports | **MongoDB** | Each platform sends different columns and nesting. Originals are kept as-is for audit and reprocessing; an aggregation pipeline normalises them into per-track-per-period totals for Postgres |
| Sample and collaboration network | **Neo4j** | Exploring "who is connected to whom" and multi-hop sample chains is a graph traversal problem. Read-only mirror of Postgres |
| Sessions, login rate limits, cached leaderboards | **Redis** (key-value) | Short-lived, read-heavy data with TTLs; doesn't need SQL's guarantees |

Why Postgres over MySQL: deferrable constraint triggers make the 100% rule enforceable at commit
(splits are inserted one row at a time, so a per-row "sum = 100" check would reject the first row),
plus native full-text search, recursive CTEs and the pgvector extension.

## 4. Features (beyond basic CRUD)

| # | Feature | What it does | Syllabus |
|---|---|---|---|
| F1 | **Split versions with all-party consent** | Each track's split is versioned with valid-from / valid-to dates. A trigger blocks overlapping versions. A new version goes live only when every contributor on it approves (trigger on the last approval). Payouts use the version valid in that period (correlated subquery). | U1 keys/constraints, U2 triggers + correlated subqueries, U4 transactions |
| F2 | **Sample royalty chain** | When Track B samples Track A, a share of B's earnings flows up to A's owners, possibly several levels. Postgres `WITH RECURSIVE` computes the money and a trigger rejects cycles. Neo4j mirrors the network for exploration (shortest path between two contributors, most-sampled tracks). Same question shown in SQL and Cypher. | U2 CTEs + triggers, U4 graph DB |
| F3 | **Stream-fraud detection with held earnings** | Window functions (`AVG/STDDEV OVER`, `LAG`) flag streams far above a track's own history; a `HAVING` query flags one platform taking a suspicious share. Earnings from flagged tracks are held until an admin clears or confirms the flag. | U2 window functions + aggregates, U4 transactions |
| F4 | **Matching unmatched royalties with vector search** | Report lines with no usable ISRC (e.g. "Kesariya - Lofi Flip (feat. X)") are embedded with a small local model (all-MiniLM-L6-v2, 384 dims) and matched to the nearest catalog track by cosine similarity using pgvector. Staff confirm before money is assigned. | U4 vector DBs, vector search with relational |
| F5 | **Redis key-value layer** | Login sessions (hash + TTL), login rate limiting (`INCR` + `EXPIRE`), "top tracks this period" leaderboard (sorted set), cached dashboard numbers. | U4 key-value DBs |
| F6 | **Exact paise rounding + TDS** | Revenue is split so paise always add up exactly to the total (largest-remainder method with `ROW_NUMBER()`). TDS withheld at a configurable per-contributor rate; PAN format checked by a `CHECK` constraint. | U1 constraints, U2 window functions |
| X1 | **Reconciliation** | Compare MongoDB per-platform totals with Postgres using `EXCEPT`. | U2 set operations |
| X2 | **What-if split simulator** | Try a different split inside a transaction with `SAVEPOINT`s that always ends in `ROLLBACK`. | U4 transactions |
| X3 | **Concurrency demo** | Two payouts at once; `SELECT … FOR UPDATE` lets only one through. | U4 locking, concurrency control |

## 5. Syllabus coverage map

| Unit | Where it shows up |
|---|---|
| **U1** ER model, ER → relational, relational algebra, aggregates, grouping, DDL, constraints, keys | `docs/01`–`03`; DDL scripts; important queries written in relational algebra next to their SQL |
| **U2** modification, set ops, NULLs, nested + correlated subqueries, joins, views, triggers, functions, procedures, CTEs, window functions, full-text search | F1, F2, F3, F6, X1; contributor views; audit triggers; full-text search on tracks and contributors |
| **U3** query processing + optimization, FDs, inference rules, 1NF–BCNF, higher NFs | `docs/04-normalization.md` (Excel sheet → BCNF, 4NF, Armstrong's axioms, dependency-preservation trade-off); `EXPLAIN ANALYZE` before/after indexes |
| **U4** transactions, concurrency, locking, NoSQL, key-value, graph (Neo4j), vector DBs, Next.js + SQL | Payout transaction, X2, X3; MongoDB; Redis (F5); Neo4j (F2); pgvector (F4); the web app |

Deliberately avoided (outside syllabus): Row-Level Security, `EXCLUDE` constraints, `LISTEN/NOTIFY`, table partitioning.

## 6. Data model (summary — full detail in `docs/`)

Postgres tables: `contributors`, `users`, `releases`, `tracks`, `genres`, `track_genres`, `platforms`,
`track_platforms`, `staff_platforms`, `contributor_managers`, `royalty_periods`, `split_versions`,
`split_shares`, `split_approvals`, `samples`, `stream_stats`, `unmatched_lines`, `track_embeddings`,
`fraud_flags`, `held_earnings`, `advances`, `advance_recoupments`, `statements`, `statement_lines`,
`payments`, `audit_log`.

- ER model and ER → relational mapping: [docs/01-er-model.md](docs/01-er-model.md)
- Relational schema: [docs/02-relational-schema.md](docs/02-relational-schema.md)
- Data dictionary: [docs/03-data-dictionary.md](docs/03-data-dictionary.md)
- Normalization: [docs/04-normalization.md](docs/04-normalization.md)
- MongoDB, Neo4j, pgvector and Redis models: [docs/05-nosql-vector-models.md](docs/05-nosql-vector-models.md)
- Triggers, functions, payout procedure, views, roles, tests: [docs/06-database-logic.md](docs/06-database-logic.md)
- Query processing and EXPLAIN before/after: [docs/07-query-optimization.md](docs/07-query-optimization.md)
- System architecture, security, pages and API: [docs/08-web-app.md](docs/08-web-app.md)

## 7. Payout run (the core transaction)

`process_payout(period_id)`, all in one transaction:

1. Lock the period row `FOR UPDATE`; it must be `open`, else raise.
2. Per track, take revenue from `stream_stats`; push sample shares upstream with a recursive CTE (F2).
3. For each track, pick the split version valid on the period end date (F1) and allocate to contributors, rounding to exact paise (F6).
4. Earnings of tracks with open fraud flags go to `held_earnings` instead (F3); previously held earnings whose flag was cleared are released into this run.
5. Recoup outstanding advances, oldest first.
6. Withhold TDS; write `statements` + `statement_lines` + `payments`.
7. Mark the period `paid`; commit. Audit triggers record everything.

## 8. Roles and application pages

| Role | Can do |
|---|---|
| Admin | Dashboard, run payouts, review fraud flags, audit log, user management, everything staff can do |
| Label Staff | Tracks, releases, contributors, propose split versions, samples, upload platform reports, confirm unmatched-line matches |
| Contributor | Approve/reject split versions they're on; read-only statements, splits, payments, advances; what-if simulator |

Pages: Login · Dashboard (leaderboard from Redis) · Tracks (full-text search, filters) · Track detail (split history, sample chain) · Split proposal + approvals · Contributors · Network explorer (Neo4j) · Report upload (CSV → Mongo → aggregate → Postgres) · Reconciliation · Unmatched lines (vector matches) · Fraud review · Payout run · Audit log · Contributor portal.

## 9. Repository layout

```
db/postgres/  setup.sh (runs the numbered files in order)   test.sh (runs tests/)
              01_schema.sql 02_seed.sql 03_bulk_generate.sql 04_migration_alter_drop.sql
              05_triggers.sql 06_functions.sql 07_views.sql 08_indexes.sql 09_roles_grants.sql
              10_demo_payouts.sql   demo_concurrency.sh   explain_compare.sql
              tests/
              (data loads before triggers, so triggers and audit apply to app changes, not
               the seed; indexes come after the bulk load so EXPLAIN can compare before/after)
db/mongo/     sample platform reports + README (validators and pipelines live in web/src/lib)
db/neo4j/     example Cypher for the Neo4j Browser
db/setup_all.sh      rebuilds Postgres, then MongoDB, embeddings, Neo4j and Redis
web/          Next.js app (App Router + Route Handlers; pg, mongodb, neo4j-driver, ioredis)
  src/lib/db/      one client per store (Postgres runs every request under SET LOCAL ROLE)
  src/lib/stores/  reports (MongoDB), embeddings (pgvector), graph (Neo4j), cache (Redis)
  scripts/stores.ts  `npm run stores -- <command>`
docs/         design docs, screenshots, test results
docker-compose.yml   Postgres(+pgvector), MongoDB, Neo4j, Redis
```

## 10. Phases

| # | Phase | Output |
|---|---|---|
| 0 | Setup ✅ | Git repo, README, `.env.example`, `.gitignore`, Docker Compose, Next.js scaffold |
| 1 | Design ✅ | ER model, relational schema, data dictionary, normalization, NoSQL/graph/vector/key-value models |
| 2 | Schema + data ✅ | DDL (26 tables, 138 named constraints), seed data, bulk generator (~2.1 lakh `stream_stats` rows), ALTER/DROP migration, 30 constraint tests |
| 3 | DB logic ✅ | Triggers (R1–R15), functions, `process_payout` procedure, views, indexes (EXPLAIN before/after), DB roles; 104 SQL tests; two-session concurrency demo |
| 4 | Other stores ✅ | Mongo ingestion of 3 platform formats + aggregation + 3-way reconciliation; local embeddings + pgvector matching (10/10 correct); Neo4j mirror; Redis sessions, rate limits, leaderboards; `db/setup_all.sh` rebuilds everything |
| 5 | Web app ✅ | DB-side login + Redis sessions; 16 Route Handlers; 14 pages incl. split editor + what-if simulator, report upload, vector matching, fraud review, payouts, audit, contributor portal; every request runs under a DB role |
| 6 | Testing ✅ | 108 SQL tests, concurrency demo, API checks, 16 screenshots (docs/09-testing.md) |
| 7 | Docs + demo ✅ | docs/REPORT.md (brief §14 order, important queries with relational algebra), docs/DEMO.md (brief §16 order) |

## 11. Team split

Both members do DB and app work (PDF §2); commit separately so GitHub shows individual contributions.

- **Dhyan Rao (PES1UG24AM090) — relational core:** schema, split versions + approvals (F1), sample chain SQL (F2), fraud detection (F3), payout procedure + paise/TDS (F6), views, indexes, what-if + concurrency demos; pages for tracks, splits, payouts, fraud review, audit.
- **Sunay Hegde (PES1UG24AM903) — multi-store + app shell:** MongoDB ingestion + reconciliation, Neo4j sync + network explorer, embeddings + vector matching (F4), Redis (F5), auth + roles + grants; pages for upload, reconciliation, unmatched lines, dashboard, contributor portal.

## 12. Open items

- Deadline and teammate's name for the docs.
- Course-style (Chen notation) ER diagram for the report, drawn from `docs/01-er-model.md`.
