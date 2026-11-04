#!/usr/bin/env bash
# Runs every SQL test in db/postgres/tests/ against the royalty-postgres container.
# Usage (from the repo root): bash db/postgres/test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
set -a; . "$ROOT/.env"; set +a
export MSYS_NO_PATHCONV=1   # stop Git Bash on Windows rewriting /sql/... paths

status=0
cd "$ROOT/db/postgres/tests"
for f in [0-9][0-9]_*.sql; do
  echo "==> tests/$f"
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" royalty-postgres \
    psql -h localhost -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
         -v ON_ERROR_STOP=1 -X -P pager=off \
         -f "/sql/tests/$f" || status=1
done
exit $status
