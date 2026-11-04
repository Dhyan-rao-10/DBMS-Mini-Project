#!/usr/bin/env bash
# Rebuilds every database from scratch, in order:
#   1. PostgreSQL: schema, data, triggers, functions, views, indexes, roles, demo payouts
#   2. MongoDB, pgvector embeddings, Neo4j and Redis from that Postgres state
#      (ingests the October 2026 sample reports, embeds tracks, rebuilds the graph)
#
# Usage (from the repo root, Git Bash on Windows):  bash db/setup_all.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

bash "$ROOT/db/postgres/setup.sh"

echo "==> MongoDB, embeddings, Neo4j, Redis"
cd "$ROOT/web"
[ -d node_modules ] || npm install
npm run -s stores -- setup
