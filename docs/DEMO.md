# Demo script (about 15 minutes)

Follows the evaluation order in the brief (§16), except that the concurrency demo and the tests come
before the Next.js walkthrough. **Keep this order:** both need the clean data, and approving a split or
paying September in the app (step 10) makes them fail until you run `bash db/setup_all.sh` again.

**Before the demo:**
1. Run `bash db/setup_all.sh`; it gives a clean state with September open and its fraud spikes in place.
2. Run `cd web && npm run dev`.
3. Open http://localhost:3000 and http://localhost:7474 (Neo4j Browser).
4. Have a terminal open at the repo root.

Logins use `SEED_USER_PASSWORD` from `.env`.

| # | Time | Section | Do / show | Say |
|---|---|---|---|---|
| 1 | 1 min | Problem & motivation | REPORT §1 | A label's royalties, and the six things Excel can't guarantee |
| 2 | 2 min | ER diagram & design | `docs/01-er-model.md` diagrams; `04-normalization.md` §4.7 | Recursive *samples*, ternary *streamed*; the spreadsheet → BCNF, and the FD kept by a trigger |
| 3 | 1 min | Relational schema | `docs/02-relational-schema.md` | 26 tables, RESTRICT vs CASCADE, rules R1–R15 |
| 4 | 1 min | Database implementation | `db/postgres/01_schema.sql`, `04_migration_alter_drop.sql` | Named constraints; ALTER/DROP on live data |
| 5 | 1 min | Important queries | Run Q1 and Q4 from REPORT §10 in psql | JOIN/GROUP BY/HAVING; correlated subquery |
| 6 | 1 min | Concurrency | Terminal: `bash db/postgres/demo_concurrency.sh` | Session B waits 5.0 s on A's row lock |
| 7 | 1 min | Test cases | Terminal: `bash db/postgres/test.sh` | 108 / 108 pass; show one failure message from each file |
| 8 | 3 min | Next.js interface | **Admin** → Dashboard → Tracks → search "mons let" → *Monsoon Letters (Lofi Flip)*: split, sample chain, history. Change Kabir to 50/20 → **What-if** | Full-text search (GIN). The simulator runs the real payout twice and rolls back |
| 9 | 1 min | Database integration | Try proposing 90% → error shown | The message comes from the database (trigger R1); the request runs under the signed-in user's database role |
| 10 | 4 min | Advanced features | (a) **Reports**: reconciliation flags Spotify's truncated file. (b) **Unmatched**: "Monsoon Letters - Lofi Flip" → 0.984 match → Confirm. (c) **Network**: Tara → Leela, 5 hops; same chain in Neo4j Browser (`db/neo4j/queries.cypher` #1). (d) Sign in as **Kabir** → approve *Untitled Demo 1* → it goes live. (e) **Admin → Fraud**: spike z-scores; **Payouts**: lock + pay September → ₹19.86 L held. (f) **Audit**: who did each step | MongoDB aggregation, pgvector, Neo4j, deferred triggers, window functions, the procedure, audit triggers |
| 11 | 1 min | Individual contribution | REPORT §15 + `git log --format='%an %s'` | Who built what |

**If something goes wrong:** run `bash db/setup_all.sh` to restore everything in about a minute. If a
database isn't reachable, check Docker Desktop is running, then run `docker compose up -d --wait`.
