#!/usr/bin/env bash
# Rebuilds the Postgres database from scratch: runs every numbered SQL file
# in db/postgres/ in order inside the royalty-postgres container.
#
# Usage (from the repo root):   bash db/postgres/setup.sh
#        only some files:        bash db/postgres/setup.sh 01 02
#
# Reads credentials, SEED_USER_PASSWORD and APP_DB_PASSWORD from .env.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
set -a; . "$ROOT/.env"; set +a
: "${SEED_USER_PASSWORD:?SEED_USER_PASSWORD must be set in .env}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set in .env}"

export MSYS_NO_PATHCONV=1   # stop Git Bash on Windows rewriting /sql/... paths

run_sql() {
  echo "==> $1"
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" royalty-postgres \
    psql -h localhost -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
         -v ON_ERROR_STOP=1 -q -X \
         -v seed_password="$SEED_USER_PASSWORD" \
         -v app_db_password="$APP_DB_PASSWORD" \
         -f "/sql/$1"
}

cd "$ROOT/db/postgres"
for f in [0-9][0-9]_*.sql; do
  if [ "$#" -eq 0 ] || printf '%s\n' "$@" | grep -qx "${f%%_*}"; then
    run_sql "$f"
  fi
done
echo "Done."
