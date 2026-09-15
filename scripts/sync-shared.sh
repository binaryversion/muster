#!/usr/bin/env bash
# Copy packages/shared/* into each package that needs it.
#
# The packages install separately and each Dockerfile's build context is its own
# directory, so a file:../shared dependency resolves in development and fails in
# the image. Copying keeps one source of truth without touching the build.
#
# The copies are committed, not gitignored: each Dockerfile builds from its own
# package directory, so packages/shared is not in the build context and the
# image has to use what is checked in. That is also why this is a no-op when the
# source is out of reach — inside a container build there is nothing to copy
# from, and the committed copy is already correct.
#
# Runs as a prebuild step, and `--check` in CI fails if a copy has drifted.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHARED="$ROOT/packages/shared"

if [ ! -d "$SHARED" ]; then
  echo "sync-shared: packages/shared is not reachable; using the committed copies"
  exit 0
fi
TARGETS=(backend mcp-server)
FILES=(crypto.ts)

check=false
[ "${1:-}" = "--check" ] && check=true

status=0
for pkg in "${TARGETS[@]}"; do
  for file in "${FILES[@]}"; do
    src="$SHARED/$file"
    dst="$ROOT/packages/$pkg/src/$file"
    if $check; then
      if ! cmp -s "$src" "$dst"; then
        echo "sync-shared: packages/$pkg/src/$file has drifted from packages/shared/$file" >&2
        diff -u "$src" "$dst" || true
        status=1
      fi
    else
      mkdir -p "$(dirname "$dst")"
      cp "$src" "$dst"
    fi
  done
done

if $check && [ "$status" -eq 0 ]; then echo "sync-shared: copies are in sync"; fi
exit "$status"
