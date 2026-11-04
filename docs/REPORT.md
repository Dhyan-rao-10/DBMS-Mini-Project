# Music Royalty Split & Payout System: Project Report

DBMS Experiential Learning, Level 3 · PES University · Team: Dhyan Rao (PES1UG24AM090), Sunay Hegde (PES1UG24AM903)

This report follows the order in the project brief (§14). Long sections link to the detailed design
documents in this folder.

## 1. Problem statement

A record label pays many contributors (artists, producers, songwriters, composers) from monthly streaming
revenue reported by several platforms. Ownership splits change over time and must always total exactly
100% and be agreed by everyone on them. Tracks that sample other tracks owe a share upstream. Advances must
be recouped before contributors are paid again. Suspicious stream spikes must be held back. Report lines
that can't be matched to a track must still reach the right people. And a month must never be paid twice.
With lakhs of play-count rows per month and several staff working at once, a spreadsheet cannot guarantee
any of this.

**Why a DBMS and not Excel macros:**
- **Referential integrity:** foreign keys stop a contributor being deleted while 200 rows still refer to them.
- **Concurrency:** row locking stops two people paying the same month at the same time.
- **Automatic rules:** triggers check every split totals 100% on every insert and update.
- **Scale:** joins and indexes over about 2 lakh stream rows.
- **Access control:** database roles separate admin, staff and contributor.
- **Audit:** a trigger-written history of who changed what.

Each of these is demonstrated (see §13).

## 2. Objectives

1. Store ownership, revenue and payouts in a normalised relational schema (BCNF) where the database itself enforces every business rule.
2. Pay a month in one transaction, exact to the paisa, including sample chains, advances, TDS and fraud holds.
3. Use each additional database paradigm only for the data it fits: documents for raw reports, a graph for the sample network, vectors for fuzzy matching, key-value for sessions and leaderboards.
4. Provide a role-based Next.js web interface for admins, label staff and contributors.

## 3. Scope

**In scope:**
- Contributors, releases, tracks, versioned splits with approvals, and samples.
- Monthly platform reports from 3 formats.
- Unmatched-line matching, fraud detection and review.
- Advances, payouts with TDS, statements and payments.
- Audit trail, three user roles, and a contributor portal.

**Out of scope:**
- Real bank transfers (payments get a reference number only).
- Currency conversion (all revenue is in INR).
- Platform API integrations (reports are uploaded as files).
- Mobile apps.

## 4. Functional requirements

| # | Requirement | Feature |
|---|---|---|
| FR1 | Staff propose a new split from a future month; it goes live only when every contributor on it approves; any rejection rejects it | F1 |
| FR2 | A track that samples another pays a set share of its revenue upstream, through chains of any depth; loops are impossible | F2 |
| FR3 | Abnormal stream spikes are flagged automatically; their earnings are held until an admin clears (release) or confirms (forfeit) them | F3 |
| FR4 | Report lines without a usable ISRC get ranked track suggestions; staff confirm or write them off | F4 |
| FR5 | Sessions, login rate limiting and leaderboards are served from a key-value store | F5 |
| FR6 | Payouts are exact to the paisa, recoup advances oldest first, and withhold TDS (20% without a PAN) | F6 |
| FR7 | Upload a platform report; see declared vs received vs loaded totals per platform | X1 |
| FR8 | Preview what a changed split would pay without saving anything | X2 |
| FR9 | A month can be paid only once, even if two admins click at once | X3 |
| FR10 | Admin, Label Staff and Contributor see and do only what their role allows; every change is audited | — |

## 5. ER diagram

See **[01-er-model.md](01-er-model.md)**:
- 15 strong and 3 weak entity sets, a recursive relationship (*samples*) and a ternary relationship (*streamed*);
- three crow's-foot diagrams;
- the ER-to-tables mapping rules.

## 6. Relational schema

See **[02-relational-schema.md](02-relational-schema.md)**: 26 tables, referential actions, the 15 business
rules and the database roles. How the schema was normalised from the label's spreadsheet (FDs, Armstrong's
axioms, 1NF → BCNF, 4NF, 5NF) is in **[04-normalization.md](04-normalization.md)**.

## 7. Database choice and justification

| Data | Database | Why this paradigm |
|---|---|---|
| Ownership, money, users, audit | **PostgreSQL 16** | ACID transactions, keys, CHECKs, triggers, row locking; the source of truth |
| Track and report-line embeddings | **pgvector** in PostgreSQL | Vector search *with a relational DB*: a match joins straight back to tracks and splits |
| Raw platform reports | **MongoDB 7** | Every platform's format differs; keep originals untouched and normalise them with an aggregation pipeline |
| Sample and collaboration network | **Neo4j 5** | Paths of unknown depth are graph traversals |
| Sessions, rate limits, leaderboards | **Redis 7** | Small, hot, expiring data with no need for joins |

Details: **[05-nosql-vector-models.md](05-nosql-vector-models.md)**.

## 8. Data dictionary

Every column with its type, nullability and constraints: **[03-data-dictionary.md](03-data-dictionary.md)**.

## 9. SQL / NoSQL / vector implementation

| Part | Where |
|---|---|
| DDL (CREATE, ALTER, DROP), seed and 2.1 lakh generated rows | `db/postgres/01`–`04_*.sql` |
| Triggers, functions, the `process_payout` procedure, views, indexes, roles | `db/postgres/05`–`09_*.sql`, explained in **[06-database-logic.md](06-database-logic.md)** |
| MongoDB collections, validators, aggregation pipelines | `web/src/lib/db/mongo.ts`, `web/src/lib/stores/reports.ts` |
| Embeddings and vector search | `web/src/lib/stores/embeddings.ts` |
| Neo4j graph sync and queries | `web/src/lib/stores/graph.ts`, `db/neo4j/queries.cypher` |
| Redis | `web/src/lib/stores/cache.ts` |

Advanced features used (the brief asks for at least 4):
- transactions with row locking;
- triggers, including a deferred constraint trigger;
- stored functions and a procedure;
- views;
- B-tree, partial, GIN and HNSW indexes;
- full-text search;
- window functions and recursive CTEs;
- MongoDB aggregation;
- vector similarity search.

## 10. Important queries

All run on the demo data; results are as of the August 2026 payout.

**Q1. Top earners of a month** (JOIN, GROUP BY, HAVING, ORDER BY)
```sql
SELECT c.legal_name, sum(s.gross_earned) AS earned
FROM statements s JOIN contributors c USING (contributor_id) JOIN royalty_periods rp USING (period_id)
WHERE rp.period_start = DATE '2026-08-01'
GROUP BY c.legal_name HAVING sum(s.gross_earned) > 50000
ORDER BY earned DESC;
```
τ<sub>earned↓</sub>( σ<sub>earned>50000</sub>( γ<sub>legal_name; SUM(gross_earned)→earned</sub>( σ<sub>period_start='2026-08-01'</sub>( STATEMENTS ⋈ CONTRIBUTORS ⋈ ROYALTY_PERIODS ) ) ) )
→ Arjun Nair ₹2,73,209.30, Kabir Rao ₹1,64,715.24, Rohan Gupta ₹1,59,289.89, …

**Q2. Split versions not totalling 100%** (GROUP BY + HAVING; must be empty, enforced by trigger R1)
```sql
SELECT version_id, sum(share_pct) FROM split_shares GROUP BY version_id HAVING sum(share_pct) <> 100;
```
σ<sub>total≠100</sub>( γ<sub>version_id; SUM(share_pct)→total</sub>( SPLIT_SHARES ) ) → 0 rows

**Q3. Contributors with advances still to recoup** (nested subquery)
```sql
SELECT c.legal_name FROM contributors c
WHERE c.contributor_id IN (SELECT contributor_id FROM v_advance_balances WHERE outstanding > 0);
```
π<sub>legal_name</sub>( CONTRIBUTORS ⋉ σ<sub>outstanding>0</sub>( ADVANCE_BALANCES ) ) → Meera Iyer, Zoya Khan

**Q4. Who earned well above their own usual month in August** (correlated subquery)
```sql
SELECT c.legal_name, s.gross_earned
FROM statements s JOIN contributors c USING (contributor_id)
WHERE s.period_id = (SELECT period_id FROM royalty_periods WHERE period_start = DATE '2026-08-01')
  AND s.gross_earned > 1.3 * (SELECT avg(s2.gross_earned) FROM statements s2
                              WHERE s2.contributor_id = s.contributor_id);
```
→ Arjun Nair, Rohan Gupta, Tara D'Souza, … (the inner query is re-evaluated for each outer row)

**Q5. Month-over-month revenue change per platform** (window function `LAG`)
```sql
SELECT rp.period_start, p.name, sum(s.revenue) AS revenue,
       100.0 * (sum(s.revenue) / lag(sum(s.revenue)) OVER (PARTITION BY p.name ORDER BY rp.period_start) - 1) AS pct_change
FROM stream_stats s JOIN platforms p USING (platform_id) JOIN royalty_periods rp USING (period_id)
GROUP BY rp.period_start, p.name;
```
→ Spotify: Aug 2026 +4.5%, Sep 2026 +3.7%.

**Q6. Tracks distributed to JioSaavn with no October JioSaavn figures yet** (set difference)
```sql
SELECT tp.track_id FROM track_platforms tp JOIN platforms p USING (platform_id) WHERE p.code = 'JIOSAAVN'
EXCEPT
SELECT s.track_id FROM stream_stats s JOIN platforms p USING (platform_id) JOIN royalty_periods rp USING (period_id)
WHERE p.code = 'JIOSAAVN' AND rp.period_start = DATE '2026-10-01';
```
π<sub>track_id</sub>( σ<sub>code='JIOSAAVN'</sub>( TRACK_PLATFORMS ⋈ PLATFORMS ) ) − π<sub>track_id</sub>( σ<sub>code='JIOSAAVN' ∧ period_start='2026-10-01'</sub>( STREAM_STATS ⋈ PLATFORMS ⋈ ROYALTY_PERIODS ) ) → 3,159 tracks

**More**, in the detailed docs:
- recursive CTE for the sample chain (doc 05 §5.2);
- payout allocation with recursive CTE + largest-remainder rounding (`06_functions.sql`);
- fraud detection with window frames (doc 06 §6.2);
- reconciliation `EXCEPT` across MongoDB and Postgres (doc 05 §5.1);
- pgvector nearest-neighbour query (doc 05 §5.3);
- `EXPLAIN ANALYZE` before and after each index (**[07-query-optimization.md](07-query-optimization.md)**).

## 11. System architecture

Diagram, request flow, security and the full API list: **[08-web-app.md](08-web-app.md)**.
Each request runs in a transaction under the user's own database role, so the database also enforces
permissions.

## 12. Application screenshots

16 screenshots in [`screenshots/`](screenshots/), listed in [09-testing.md §9.6](09-testing.md#96-screenshots).

## 13. Testing results

See **[09-testing.md](09-testing.md)**:
- **108/108 SQL tests pass** (constraints, business rules, payout, database roles);
- concurrent payout refused with "already paid";
- every page checked for each role;
- payouts exact to ₹0.00 over 11 months;
- vector matching correct for 9/9 lines.

## 14. Conclusion and future enhancements

The project shows that the rules a label cares about can live in the database itself, not in application
code or a spreadsheet:
- splits that always total 100%;
- history that can't be rewritten;
- a month that can't be paid twice;
- exact money;
- an append-only audit trail.

Every rule then holds for every client, and the other databases each earn their place with data that suits
them.

**Future enhancements:**
- Currency conversion with stored exchange rates.
- Partitioning `stream_stats` by year as data grows.
- Direct platform API ingestion.
- A re-ranking step for vector matches using exact artist overlap.
- Exporting statements as PDF.
- Bank payout integration.
- Two-factor login for admins.

## 15. Individual contribution

| Member | Responsibilities |
|---|---|
| Dhyan Rao (PES1UG24AM090) | Relational core: schema, split versions and approvals, sample chain SQL, fraud detection, payout procedure, views, indexes; tracks, splits, payout, fraud and audit pages |
| Sunay Hegde (PES1UG24AM903) | MongoDB ingestion and reconciliation, Neo4j, vector matching, Redis, authentication and database roles; upload, reconciliation, unmatched-lines, dashboard pages and the contributor portal |
