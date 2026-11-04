# Music Royalty Split & Payout System

DBMS Experiential Learning — Level 3 Project, PES University.

A label-side system that tracks who owns what share of every track (with versioned, all-party-approved
splits and sample chains), ingests monthly streaming reports from multiple platforms, matches
unidentified report lines, holds back suspicious earnings, recoups artist advances and pays
contributors — with the database (not the application) guaranteeing that splits total 100%, nothing is
paid twice, and every change is audited. See [PLAN.md](PLAN.md) for the full plan and the
"why a DBMS, not Excel" rationale.

| Layer | Technology | Holds |
|---|---|---|
| Relational DB | PostgreSQL 16 + pgvector | All money and ownership data (source of truth), embeddings |
| Document DB | MongoDB 7 | Raw platform reports |
| Graph DB | Neo4j 5 | Sample and collaboration network (mirror) |
| Key-value | Redis 7 | Sessions, rate limits, leaderboards |
| Web app | Next.js 16 (App Router + Route Handlers) | |
| Local infra | Docker Compose | |

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Node.js 20 LTS or newer](https://nodejs.org/) (developed on Node 24)
- Git

## Setup

```bash
git clone <repo-url>
cd <repo>
cp .env.example .env          # then set real passwords in .env
docker compose up -d --wait   # starts Postgres, MongoDB, Neo4j and Redis
docker compose ps             # all four should show "healthy"
```

Build every database from scratch, then run the SQL tests:

```bash
bash db/setup_all.sh          # about a minute; see below for what it does
bash db/postgres/test.sh      # 108 SQL tests; exits non-zero on failure
```

`setup_all.sh` runs two steps:
1. `db/postgres/setup.sh`: schema, demo data, about 2 lakh generated stream rows, the migration, triggers,
   functions, views, indexes and roles, then pays Oct 2025 – Aug 2026.
2. `npm run stores -- setup` in `web/`:
   - loads the three October 2026 sample platform reports through MongoDB and reconciles them;
   - embeds every track and unmatched line (downloads the 23 MB embedding model on first run);
   - rebuilds the Neo4j graph and the Redis leaderboards.

The store steps can also be run one at a time from `web/`:

```bash
npm run stores -- reconcile 2026-10   # declared vs received (MongoDB) vs loaded (Postgres)
npm run stores -- match               # vector-search suggestions for each unmatched report line
npm run stores -- graph               # rebuild Neo4j and run the example graph queries
npm run stores -- redis               # leaderboard, login rate limit and session demo
```

Demos:

```bash
bash db/postgres/demo_concurrency.sh            # two sessions pay September at once; B waits on A's lock
bash db/postgres/demo_concurrency.sh --commit   # ...and B is refused "already paid" (then re-run setup_all.sh)
```

The EXPLAIN comparison (each query with and without its index) is in `db/postgres/explain_compare.sql`;
example graph queries for the Neo4j Browser (http://localhost:7474) are in `db/neo4j/queries.cypher`.

On Windows run these from Git Bash. `db/postgres/setup.sh 03 04` runs only the listed SQL files.

Demo logins all use the password in `SEED_USER_PASSWORD` (`.env`):

| Email | Role |
|---|---|
| `admin@monsoonrecords.test` | Admin |
| `riya.spotify@monsoonrecords.test`, `sana.youtube@…`, `dev.jiosaavn@…` | Label Staff (Spotify / YouTube Music / JioSaavn desk) |
| `aarav.mehta@example.com`, `kabir.rao@example.com`, `meera.iyer@example.com`, `zoya.khan@example.com` | Contributor |

Web app (after `setup_all.sh`):

```bash
cd web
npm install                   # first time only
npm run dev                   # http://localhost:3000
```

Sign in with one of the demo logins below. Admin sees everything, Label Staff see the catalogue and report
intake, and contributors only see their own portal (`/me`).

Connect to the databases:

```bash
docker exec -it royalty-postgres psql -U royalty_admin -d royalty
docker exec -it royalty-mongo mongosh -u royalty_admin -p --authenticationDatabase admin
docker exec -it royalty-neo4j cypher-shell -u neo4j -p <NEO4J_PASSWORD>
docker exec -it royalty-redis redis-cli -a <REDIS_PASSWORD>
```

Neo4j Browser is at http://localhost:7474.

The `db/postgres`, `db/mongo` and `db/neo4j` folders are mounted read-only inside their containers
(`/sql`, `/scripts`, `/scripts`), so scripts can be run with e.g.
`docker exec royalty-postgres psql -U royalty_admin -d royalty -f /sql/<file>.sql`.

## Design documents

Start with **[docs/REPORT.md](docs/REPORT.md)** (the full report in the brief's order) and
**[docs/DEMO.md](docs/DEMO.md)** (the demo script).


| Doc | Contents |
|---|---|
| [docs/01-er-model.md](docs/01-er-model.md) | Entities, relationships, ER diagrams, ER → relational mapping |
| [docs/02-relational-schema.md](docs/02-relational-schema.md) | All tables, referential actions, business rules, views, DB roles |
| [docs/03-data-dictionary.md](docs/03-data-dictionary.md) | Every column with type and constraints |
| [docs/04-normalization.md](docs/04-normalization.md) | Excel sheet → FDs → 1NF, 2NF, 3NF, BCNF, 4NF, 5NF |
| [docs/05-nosql-vector-models.md](docs/05-nosql-vector-models.md) | MongoDB, Neo4j, pgvector and Redis models and queries |
| [docs/06-database-logic.md](docs/06-database-logic.md) | Triggers, functions, the payout procedure, views, DB roles, tests |
| [docs/07-query-optimization.md](docs/07-query-optimization.md) | Query processing, EXPLAIN before/after each index |
| [docs/08-web-app.md](docs/08-web-app.md) | System architecture, security, pages, API, verified behaviour |
| [docs/09-testing.md](docs/09-testing.md) | Test results and screenshots |

## Repository layout

```
db/postgres/   setup.sh, test.sh, numbered SQL files (schema, seed, bulk data, migration,
               triggers, functions, views, indexes, grants), tests/
db/mongo/      Collection validators and aggregation pipelines
db/neo4j/      Constraints, sync and exploration Cypher
web/           Next.js application
docs/          Design documents, screenshots, test results
```

## Team

| Member | Responsibilities |
|---|---|
| Dhyan Rao (PES1UG24AM090) | Relational core: schema, split versions + approvals, sample chain SQL, fraud detection, payout procedure, views, indexes; tracks, splits, payout, fraud and audit pages |
| Sunay Hegde (PES1UG24AM903) | Multi-store + app shell: MongoDB ingestion + reconciliation, Neo4j, vector matching, Redis, auth + roles; upload, reconciliation, unmatched-lines, dashboard pages and contributor portal |
