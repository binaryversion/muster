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
- Backoffice sign-in with `ADMIN_PASSWORD`; lead-token digests keyed by `ENC_KEY`.
- Deployed with `docker compose`, every setting read from `.env`.

## Not done

Tracked as GitHub issues; [#1](https://github.com/binaryversion/muster/issues/1)
is the index. In rough order of how much they matter:

| # | What |
|---|---|
| [#19](https://github.com/binaryversion/muster/issues/19) | The container build has never been run end to end |
| [#13](https://github.com/binaryversion/muster/issues/13) | Nothing writes task `priority` |
| [#14](https://github.com/binaryversion/muster/issues/14) | No rate-limit backoff on GitHub calls |
| [#15](https://github.com/binaryversion/muster/issues/15) | `muster_search_findings` is `ILIKE`, not full text |
| [#16](https://github.com/binaryversion/muster/issues/16) | Nothing populates `task_deps` |
| [#17](https://github.com/binaryversion/muster/issues/17) | `POST /admin/reconcile` runs synchronously |
| [#18](https://github.com/binaryversion/muster/issues/18) | The SSE stream polls Postgres once per connected lead |
| [#20](https://github.com/binaryversion/muster/issues/20) | Backoffice sessions are in-memory |
| [#21](https://github.com/binaryversion/muster/issues/21) | `crypto.ts` is duplicated across two packages |
| [#22](https://github.com/binaryversion/muster/issues/22) | Remove the `docker-entrypoint-initdb.d` migrations mount |
| [#23](https://github.com/binaryversion/muster/issues/23) | Findings and event payloads are stored as written |
