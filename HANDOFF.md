# Handoff: continue building Muster in Claude Code

This repo was scaffolded in a claude.ai chat on 2026-09-15. Read README.md and docs/ARCHITECTURE.md first.

## Decisions already made (do not re-litigate)
- Store (Postgres) is the source of truth for status/claim/lease; GitHub is the source of truth for title/body/priority.
- ONE GitHub App for the org, not one per lead. Leads get per-machine bearer tokens from the backoffice API.
- Webhooks are the primary GitHub->store path; Actions workflows only as fallback. Mirror store->GitHub is debounced/batched.
- Agents never call GitHub for coordination. All coordination goes through the muster_* MCP tools.
- No kanban UI of our own beyond an admin panel. Humans plan in GitHub Projects.
- Inbound channel events are untrusted text; agents verify merges with git, never relay permission approvals.

## Current state
- All three TS packages compile (`npm i && npm run build` in each).
- Schema complete incl. atomic `claim_task()` function.
- MCP tools final: list_available_tasks, claim_task, heartbeat, release_task, complete_task, recent_events, add_finding, search_findings.
- Backend: signed+idempotent webhooks, admin API (projects, lead tokens, board, events), SSE stream, label-based mirror.
- Channel plugin drafted; notification shape NOT yet verified against current Claude Code channel docs.

## Next tasks, in order
1. Run `docker compose up -d db`, apply migration, add a `scripts/smoke.sh` that creates a project + lead and exercises claim/heartbeat/complete via MCP Inspector or curl.
2. Verify the channel notification method/params against https://code.claude.com/docs/en/channels for the installed Claude Code version; fix packages/channel/src/index.ts.
3. Implement Projects v2 Status write-back in packages/backend/src/sync/github.ts (GraphQL in docs/GITHUB_APP.md); store field/option ids on the project row (new migration).
4. Nightly reconcile job: diff GitHub issues vs store, catch missed webhook deliveries.
5. Minimal backoffice UI (single HTML page against /admin/*) - projects, issue/revoke tokens, live board, event log.
6. Add a CLAUDE.md protocol snippet leads paste into their projects (draft is in README).
