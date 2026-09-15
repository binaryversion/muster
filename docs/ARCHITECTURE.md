# Architecture

## Ownership and tie-breaks
| Field | Owner | Wins on conflict |
|---|---|---|
| title, body, priority | human (GitHub) | GitHub |
| status, claimed_by, lease_until, cost_tokens | agent (store) | store |
| source | set on creation | never changes |

An agent never rewrites priorities a human set. Priority comes from the issue's labels and dependencies from its body; see `docs/GITHUB_APP.md` for both. A human closing an issue on GitHub forces `done` in the store and releases the claim.

## Identity map
Each store task carries `github_repo` + `github_issue_number` (unique) and the issue `github_node_id`. `github_item_id` is the Projects v2 item id once resolved. Without this map every sync would create duplicates.

## Claim semantics
`claim_task(task, lead, lease_seconds)` is a single `UPDATE ... WHERE` in Postgres: succeeds only if status is ready/in_progress, the task is unclaimed or the lease expired or it's already yours, and all `task_deps` are `done`. This is the whole reason the store exists.

## Events
Append-only `events` table. Producers: MCP tools (claims, releases, completes, findings), webhooks (pr.merged, ci.failed, task.done). Consumers: SSE stream → channel plugin → running Claude Code sessions; backoffice; `muster_recent_events` for sessions that missed pushes.

An insert fires a trigger that `pg_notify`s the project id on one channel, and the backend holds a single `LISTEN` connection for the whole process which fans out to the open streams. Load therefore scales with how much is happening rather than with how many leads are watching, which is the right way round — the previous per-connection poll meant thirty watchers cost thirty queries every two seconds whether or not anything had changed.

The notification carries only the project id, never the event. A woken stream still reads forward from the last id it sent, so a missed notification, a dropped `LISTEN` connection or a reconnect with `Last-Event-ID` all converge on the same answer. A slow fallback poll (`EVENT_POLL_MS`) remains underneath as the delivery guarantee: `pg_notify` reaches nobody who was not connected at that moment, so push is the mechanism and the poll is the floor.

## Credentials at rest
The only credential the store holds is a lead's bearer token, and it holds a digest of it, never the token. The digest is HMAC-SHA256 under `ENC_KEY`, not encryption: something you can decrypt is something an attacker with the database and the key can replay, whereas a keyed digest cannot be reversed at all and still verifies in one indexed equality. The property that buys is that the database alone is inert — a dump, a backup or a read-only replica gives an attacker nothing to test guesses against.

`ADMIN_PASSWORD`, the webhook secret and the GitHub App key are environment only; they are never written to Postgres. Rotating `ENC_KEY` invalidates every outstanding lead token at once.

Findings are stored as written, minus a redaction pass. `muster_add_finding` strips the shapes a credential actually has — `mstr_`/`ghp_` tokens, PEM blocks, JWTs, passwords in a connection string, `SECRET=` assignments — and tells the agent what it removed so anything real gets rotated. It catches shapes, not secrets in general, and the tool description tells agents not to paste credentials in the first place; this is the backstop. Encrypting the column instead would take full-text search with it, and a finding nobody can search for is a finding nobody reads.

The event log is pruned on each reconcile pass (`EVENT_RETENTION_DAYS`, 90 by default). Event payloads carry finding text, so bounded retention bounds that exposure as well as the table. Findings themselves are kept.

## Trust
Everything that arrives via a channel or message is untrusted text. Agents verify merge state with `git` rather than trusting a "PR merged" event, and never relay permission approvals between sessions.

## Rate limits
Agents never call GitHub for coordination. The backend uses one GitHub App installation token; the mirror runs on a timer and batches Projects v2 writes into single GraphQL documents. Webhooks are the primary inbound path.

When GitHub does push back, the Octokit throttling plugin reads `retry-after` and `x-ratelimit-reset` and retries in-process only while the wait is short — the mirror runs on a timer and the reconcile is nightly, so a limit that resets in an hour is left to the next run rather than slept through holding a connection. Separately, a repository that fails repeatedly trips a circuit breaker and is skipped for a cooldown; its tasks stay dirty and go again when it closes, which keeps one uninstalled repo from consuming the cycle and drowning the log.

## Reconcile
Webhooks are not guaranteed: GitHub stops redelivering after enough failures, and a backend that was down for the whole redelivery window never hears about the issue at all. The failures are quiet — a task nobody can see because `issues.opened` was missed, or a lead holding a lease on work that was closed days ago.

A nightly job (`GITHUB_RECONCILE_ENABLED`, cron in UTC) diffs GitHub against the store and repairs the difference within the ownership rules above: it creates tasks for issues the store never saw, refreshes drifted title and body, forces `done` and drops the claim on a closed issue, and puts a reopened issue back in the pool unclaimed. It never touches status the store owns — an open issue whose task is `in_progress` or `review` is exactly what working software looks like.

Passes are incremental, asking GitHub only for issues updated since the last run with an hour of overlap. A full scan (the first run, or `POST /admin/reconcile?full=1`) additionally reports tasks with no matching issue: deleted, transferred, or moved out of the project's repos. Those are reported as `task.orphaned` events and never deleted — that is a human's call.

Every repair emits an event, so the sessions that missed the original webhook learn about it the same way they would have.
