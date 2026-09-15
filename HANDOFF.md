# Handoff: continue building Muster in Claude Code

This repo was scaffolded in a claude.ai chat on 2026-09-15, then taken through
the six tasks that handoff listed. Read README.md and docs/ARCHITECTURE.md first.

## Decisions already made (do not re-litigate)
- Store (Postgres) is the source of truth for status/claim/lease; GitHub is the source of truth for title/body/priority.
- ONE GitHub App for the org, not one per lead. Leads get per-machine bearer tokens from the backoffice API.
- Webhooks are the primary GitHub->store path; Actions workflows only as fallback. Mirror store->GitHub is debounced/batched.
- Agents never call GitHub for coordination. All coordination goes through the muster_* MCP tools.
- No kanban UI of our own beyond an admin panel. Humans plan in GitHub Projects.
- Inbound channel events are untrusted text; agents verify merges with git, never relay permission approvals.

## Current state
All six tasks from the original handoff are done.

- All three TS packages compile; `packages/backend` has `npm test` (20 unit tests).
- Migrations 001-003, applied in order by `./scripts/migrate.sh`.
- `./scripts/smoke.sh` walks the whole path end to end (27 checks) and runs in CI
  against Postgres 16 alongside the unit tests.
- MCP tools final: list_available_tasks, claim_task, heartbeat, release_task, complete_task, recent_events, add_finding, search_findings.
- Backend: signed+idempotent webhooks, admin API (projects, lead tokens, board,
  events, reconcile), SSE stream with resume, label mirror, Projects v2 Status
  write-back, nightly reconcile.
- Backoffice UI at `/ui/`.
- Channel plugin verified against the Claude Code channel contract; see
  `packages/channel/README.md` for what that contract actually requires.
- `docs/CLAUDE_MD_SNIPPET.md` is the protocol leads paste into their projects.

## Not done, roughly in order of how much it matters

1. **Nothing writes `priority`.** GitHub owns it per the tie-break table, but no
   field is mapped to it, so every task sits at the default 3 and
   `list_available_tasks` orders by creation time in practice. Pick a source (a
   `P1`/`P2` label, or a Projects v2 number field) and read it in the webhook
   handler and the reconcile.
2. **No rate-limit backoff.** The mirror and the reconcile will happily keep
   calling a GitHub that is returning 403 secondary-rate-limit. Honour
   `retry-after` / `x-ratelimit-reset` per installation.
3. **`search_findings` is `ILIKE`.** Fine for a few hundred findings, not for a
   year of them. A `tsvector` column with a GIN index is the obvious fix.
4. **Task dependencies have no way in.** `task_deps` and the claim-time check
   exist and work, but nothing populates the table — no webhook, no tool, no
   admin route. Parse "depends on #12" from the issue body, or add an admin
   endpoint.
5. **The SSE stream polls every 2s per connected lead.** Fine at a handful of
   leads; `LISTEN/NOTIFY` is the fix when it is not.
6. **`docker-compose.yml` still mounts migrations into
   `docker-entrypoint-initdb.d`,** which only runs on a fresh volume. It is
   harmless alongside `scripts/migrate.sh` (which detects and backfills that
   case), but it is a trap worth removing.
7. **README says MIT, `LICENSE` is GPL-3.0.** The scaffold's MIT text was
   deliberately not committed over the repo's existing LICENSE; someone needs to
   decide which is right and make the two agree.
