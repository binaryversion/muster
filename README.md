# Muster

**Cross-machine coordination for Claude Code agent teams.**
Multiple developers, each running a Claude Code *lead* session (with its own agent team), working on the same project without duplicating work or burning tokens.

Humans plan in **GitHub Projects**. Agents claim, lease, complete and share findings in a small **Postgres store** exposed through an **MCP server**. GitHub webhooks feed the store; the store mirrors status back. A **channel** pushes "PR merged, rebase now" and "CI is red, hold PRs" straight into every running session.

```
GitHub Projects / Issues  (humans plan)
        │ webhooks (one GitHub App)
        ▼
   backend ──▶ Postgres store ◀── mcp-server ◀── lead A (laptop)
      │              │                      ◀── lead B (laptop)
      │              │                      ◀── lead C (CI box)
      │              └── events ──▶ channel ──▶ pushed into each session
      └── debounced mirror ──▶ GitHub labels / Project status
```

## Why
- **No duplicated work**: `muster_claim_task` is an atomic Postgres claim with a TTL lease and dependency check. Two leads cannot evaluate the same task.
- **Safe rebases**: every merged PR becomes an event pushed into all sessions before they open the next PR.
- **No provider rate limits**: agents talk to your store (sub-ms, unlimited). GitHub sees a handful of batched calls per interval.
- **Shared findings**: one agent learns a gotcha, every agent gets it.
- **Cost visibility**: per-task token spend via heartbeats.
- **Per-lead tokens**: issue and revoke access per developer machine from the backoffice API.

## Packages
| Package | What |
|---|---|
| `packages/store` | Postgres schema, `claim_task()` function, event log |
| `packages/mcp-server` | Streamable-HTTP MCP server; per-lead bearer auth; tools `muster_*` |
| `packages/backend` | GitHub webhook receiver (signed, idempotent), backoffice/admin API, SSE event stream, debounced store→GitHub mirror |
| `packages/channel` | Claude Code channel plugin: tails events and pushes them into the session |

## Quick start
```bash
cp .env.example .env            # edit secrets
docker compose up -d db
(cd packages/backend && npm i && npm run dev)
(cd packages/mcp-server && npm i && npm run dev)

# create a project and a lead token (backoffice API)
curl -s -XPOST localhost:8080/admin/projects -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"slug":"web","name":"Web app","github_owner":"acme","github_repos":["acme/web"]}'
curl -s -XPOST localhost:8080/admin/projects/<project-id>/leads -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"name":"alice-laptop","expires_in_days":30}'
# -> { "token": "mstr_..." }  shown once
```

Each developer then, on their machine:
```bash
claude mcp add --transport http muster https://muster.example.com/mcp \
  --header "Authorization: Bearer mstr_..."
```
and adds to the project `CLAUDE.md`:
```
Before starting any task: call muster_list_available_tasks and muster_claim_task.
Call muster_heartbeat every few minutes while working. On PR open: muster_complete_task(status=review).
When you receive a "pr.merged" event, rebase onto the base branch before pushing.
Check muster_search_findings before debugging environment or tooling issues.
```

See `docs/` for the GitHub App setup, lead onboarding and the architecture/tie-break rules.

## Status
Scaffold. Builds, schema is complete, tool semantics are final. Not yet done: Projects v2 Status field write-back (labels are mirrored today), reconcile job, backoffice UI. Contributions welcome.

## License
MIT
