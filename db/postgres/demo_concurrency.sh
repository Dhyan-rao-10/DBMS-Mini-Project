#!/usr/bin/env bash
# Concurrency demo (X3): two admins press "Pay September" at the same time.
#
#   bash db/postgres/demo_concurrency.sh            # A rolls back: B waits for A's lock, then runs
#   bash db/postgres/demo_concurrency.sh --commit   # A commits:    B waits, then is refused ("already paid")
#
# Both sessions call process_payout(), which starts with
#   SELECT ... FROM royalty_periods WHERE period_id = ... FOR UPDATE
# so the second session blocks on that row lock until the first finishes.
# The default mode leaves the database unchanged. --commit really pays
# September; run setup.sh afterwards to get the demo state back.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
set -a; . "$ROOT/.env"; set +a
export MSYS_NO_PATHCONV=1

A_END="ROLLBACK"
[ "${1:-}" = "--commit" ] && A_END="COMMIT"
A_LOG="$(mktemp)"

psql_session() {
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" royalty-postgres \
    psql -h localhost -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -P pager=off -v ON_ERROR_STOP=0 "$@"
}

SETUP=$(cat <<'SQL'
SELECT set_config('app.user_id', user_id::text, false) AS admin_id FROM users WHERE email = 'admin@monsoonrecords.test' \gset
SELECT period_id AS sep FROM royalty_periods WHERE period_start = DATE '2026-09-01' \gset
SQL
)

echo "Locking September so it can be paid..."
psql_session <<SQL
$SETUP
UPDATE royalty_periods SET status = 'locked' WHERE period_id = :sep AND status = 'open';
SQL

echo "Session A: starts the payout, holds its transaction open for 5 s, then ${A_END}s."
psql_session <<SQL > "$A_LOG" 2>&1 &
$SETUP
BEGIN;
\echo [A] calling process_payout
CALL process_payout(:sep);
\echo [A] payout done inside the transaction; holding the lock for 5 s
SELECT pg_sleep(5);
$A_END;
\echo [A] $A_END
SQL
A_PID=$!

sleep 1
echo "Session B: starts 1 s later and tries to pay the same period."
psql_session <<SQL 2>&1 | sed 's/^/    /'
$SETUP
BEGIN;
SELECT clock_timestamp() AS t0 \gset
\echo [B] waiting for the period row lock...
SELECT status AS status_seen_by_b FROM royalty_periods WHERE period_id = :sep FOR UPDATE;
SELECT round(extract(epoch FROM clock_timestamp() - :'t0'::timestamptz)::numeric, 1) AS b_waited_seconds;
CALL process_payout(:sep);
ROLLBACK;
SQL

wait $A_PID
sed 's/^/    /' "$A_LOG"
rm -f "$A_LOG"

if [ "$A_END" = "ROLLBACK" ]; then
  psql_session <<SQL
$SETUP
UPDATE royalty_periods SET status = 'open' WHERE period_id = :sep AND status = 'locked';
SQL
  echo "Done. A rolled back, so B got the lock after waiting and could run; nothing was saved."
  echo "Run with --commit to see B refused with 'already paid' once A commits."
else
  echo "Done. A committed September; B was refused. Run db/postgres/setup.sh to restore the demo state."
fi
