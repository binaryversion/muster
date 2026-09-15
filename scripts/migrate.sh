#!/usr/bin/env bash
# Apply packages/store/migrations/*.sql in order, once each.
#
# docker-compose mounts the migrations directory into the postgres image's
# docker-entrypoint-initdb.d, which only runs on a *fresh* volume. That is fine
# for a first `docker compose up -d db`, but it never applies migrations added
# later. This script is the path that always works; it detects the initdb case
# and backfills 001 rather than trying to re-run it.
#
#   DATABASE_URL=postgres://muster:muster@localhost:5432/muster ./scripts/migrate.sh
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://muster:muster@localhost:5432/muster}"
# Overridable so the script can run from a container that mounts the migrations
# somewhere other than next to the repo.
MIGRATIONS="${MIGRATIONS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/packages/store/migrations}"

command -v psql >/dev/null || { echo "migrate: psql not found (apt install postgresql-client)" >&2; exit 1; }

export PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c client_min_messages=warning"

psql_q() { psql "$DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }

psql_q -c "CREATE TABLE IF NOT EXISTS schema_migrations (
             filename   text PRIMARY KEY,
             applied_at timestamptz NOT NULL DEFAULT now())" >/dev/null

# Fresh docker volume: the entrypoint already ran 001 before we ever connected.
# Record it as applied so we do not fail on CREATE TABLE.
if [ "$(psql_q -c "SELECT count(*) FROM schema_migrations")" = "0" ] &&
   [ "$(psql_q -c "SELECT to_regclass('public.tasks') IS NOT NULL")" = "t" ]; then
  echo "migrate: existing schema found, recording 001_init.sql as already applied"
  psql_q -c "INSERT INTO schema_migrations (filename) VALUES ('001_init.sql')" >/dev/null
fi

applied=0
for path in "$MIGRATIONS"/*.sql; do
  file="$(basename "$path")"
  if [ "$(psql_q -c "SELECT count(*) FROM schema_migrations WHERE filename = '$file'")" != "0" ]; then
    continue
  fi
  echo "migrate: applying $file"
  # Each migration runs in one transaction together with its bookkeeping row,
  # so a failure leaves nothing half-applied.
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction \
    -f "$path" -c "INSERT INTO schema_migrations (filename) VALUES ('$file')"
  applied=$((applied + 1))
done

if [ "$applied" -eq 0 ]; then echo "migrate: up to date"; else echo "migrate: applied $applied migration(s)"; fi
