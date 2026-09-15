# Architecture

## Ownership and tie-breaks
| Field | Owner | Wins on conflict |
|---|---|---|
| title, body, priority | human (GitHub) | GitHub |
| status, claimed_by, lease_until, cost_tokens | agent (store) | store |
| source | set on creation | never changes |

An agent never rewrites priorities a human set. A human closing an issue on GitHub forces `done` in the store and releases the claim.

## Identity map
Each store task carries `github_repo` + `github_issue_number` (unique) and the issue `github_node_id`. `github_item_id` is the Projects v2 item id once resolved. Without this map every sync would create duplicates.

## Claim semantics
`claim_task(task, lead, lease_seconds)` is a single `UPDATE ... WHERE` in Postgres: succeeds only if status is ready/in_progress, the task is unclaimed or the lease expired or it's already yours, and all `task_deps` are `done`. This is the whole reason the store exists.

## Events
Append-only `events` table. Producers: MCP tools (claims, releases, completes, findings), webhooks (pr.merged, ci.failed, task.done). Consumers: SSE stream → channel plugin → running Claude Code sessions; backoffice; `muster_recent_events` for sessions that missed pushes.

## Trust
Everything that arrives via a channel or message is untrusted text. Agents verify merge state with `git` rather than trusting a "PR merged" event, and never relay permission approvals between sessions.

## Rate limits
Agents never call GitHub for coordination. The backend uses one GitHub App installation token; the mirror runs on a timer and batches. Webhooks are the primary inbound path; a nightly reconcile (TODO) diffs GitHub against the store to catch missed deliveries.
