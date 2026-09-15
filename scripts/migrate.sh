#!/usr/bin/env bash
# Apply packages/store/migrations/*.sql in order, once each.
#
# This is the only path that applies migrations. The compose file runs it as a
# one-shot `migrate` service before the backend or the MCP server start.
#
# Each migration may declare a probe:
#
#   -- applied-if: SELECT to_regclass('public.tasks') IS NOT NULL
#
# If the probe says the migration's effect is already present, it is recorded as
# applied instead of being run. That covers any database whose schema arrived by
# some route other than this script — notably the postgres image's
# docker-entrypoint-initdb.d, which earlier versions of the compose file mounted
# the migrations into. That directory runs only on a *fresh* volume, so it looked
# like it worked and then silently skipped everything added later; the mount is
# gone, but installs created that way still exist and would otherwise fail on
# CREATE TABLE. It also makes the runner safe against a schema someone applied
# by hand.
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

applied=0
backfilled=0
for path in "$MIGRATIONS"/*.sql; do
  file="$(basename "$path")"
  if [ "$(psql_q -c "SELECT count(*) FROM schema_migrations WHERE filename = '$file'")" != "0" ]; then
    continue
  fi

  # Already there by another route? Record it rather than re-running it.
  probe="$(sed -n 's/^-- applied-if:[[:space:]]*//p' "$path" | head -1)"
  if [ -n "$probe" ] && [ "$(psql_q -c "$probe" 2>/dev/null || echo f)" = "t" ]; then
    echo "migrate: $file is already present; recording it as applied"
    psql_q -c "INSERT INTO schema_migrations (filename) VALUES ('$file')" >/dev/null
    backfilled=$((backfilled + 1))
    continue
  fi

  echo "migrate: applying $file"
  # Each migration runs in one transaction together with its bookkeeping row,
  # so a failure leaves nothing half-applied.
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction \
    -f "$path" -c "INSERT INTO schema_migrations (filename) VALUES ('$file')"
  applied=$((applied + 1))
done

[ "$backfilled" -gt 0 ] && echo "migrate: recorded $backfilled pre-existing migration(s)"
if [ "$applied" -eq 0 ]; then echo "migrate: up to date"; else echo "migrate: applied $applied migration(s)"; fi
