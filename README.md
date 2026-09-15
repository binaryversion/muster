# Muster

**Cross-machine coordination for teams of Claude Code agents.**

Several developers, each running a Claude Code *lead* session with its own agent
team, working the same repo — without doing each other's work twice, without
rebasing onto a branch that moved an hour ago, and without each session
rediscovering the same broken test.

Humans plan in **GitHub Projects**. Agents claim, lease, complete and share what
they learn through a small **Postgres store** exposed as an **MCP server**.

---

## The problem

Two developers point their agents at the same repo on Monday morning.

Nothing stops them both picking issue #42. GitHub has no notion of "an agent is
working on this right now", so both sessions read the same board, both decide
#42 looks good, and two hours later there are two branches, two PRs and one
awkward conversation. Meanwhile a third agent spends forty minutes discovering
that the integration tests need Node 22 — something the first agent worked out
before lunch and had nowhere to write down.

You can paper over this with a shared doc and some discipline. It does not
survive contact with three people and six agents.

## What Muster does

It gives agents a coordination layer of their own, separate from the board
humans plan on:

- **Nobody works the same task twice.** `muster_claim_task` is a single atomic
  `UPDATE` in Postgres with a TTL lease and a dependency check. Two leads cannot
  both win it. If a session dies, the lease expires and the task returns to the
  pool by itself.
- **Rebases stop being a surprise.** Every merged PR becomes an event pushed
  into every running session, before the next PR is opened.
- **What one agent learns, all of them know.** `muster_add_finding` writes it
  down once; `muster_search_findings` is the first stop before debugging
  anything environmental.
- **GitHub does not become the bottleneck.** Agents talk to your store — sub-ms,
  no rate limit. GitHub sees a handful of batched calls per interval from one
  App installation.
- **Per-machine access.** Issue a token per developer's laptop, revoke it when
  the laptop walks out of the building. Nothing recoverable is stored: tokens
  live in the database only as digests keyed by `ENC_KEY`, so a stolen dump
  cannot even be used to test a guess.
- **You can see what the agents are doing.** A board showing every claim, lease
  and token spend, and an append-only event log.

## How it fits together

```
GitHub Projects / Issues  (humans plan here)
        │ webhooks (one GitHub App for the org)
        ▼
   backend ──▶ Postgres store ◀── mcp-server ◀── lead A (laptop)
      │              │                       ◀── lead B (laptop)
      │              │                       ◀── lead C (CI box)
      │              └── events ──▶ channel ──▶ pushed into each live session
      └── debounced mirror ──▶ GitHub labels + Projects v2 Status
```

The store owns status, claims and leases. GitHub owns title, body and priority.
Neither overwrites the other's fields — the tie-break rules are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quick start

```bash
git clone https://github.com/binaryversion/muster && cd muster
cp .env.example .env
```

Set the two secrets in `.env` — compose refuses to start without them:

```bash
POSTGRES_PASSWORD=$(openssl rand -base64 24)
ADMIN_PASSWORD=$(openssl rand -base64 24)
ENC_KEY=$(openssl rand -base64 32)
```

Then:

```bash
docker compose up -d --build
```

That brings up Postgres, applies the migrations, and starts the backend and the
MCP server. Open **http://localhost:8080/ui/** and sign in with `ADMIN_PASSWORD`.

Create a project, add your repos, and issue a token for each developer's
machine. The token is shown exactly once; only its hash is stored.

To check the whole path end to end:

```bash
ADMIN_PASSWORD=... GITHUB_WEBHOOK_SECRET=... ./scripts/smoke.sh
```

## Connecting a lead session

On each developer's machine:

```bash
claude mcp add --transport http muster https://muster.example.com/mcp \
  --header "Authorization: Bearer mstr_..."
```

Paste [`docs/CLAUDE_MD_SNIPPET.md`](docs/CLAUDE_MD_SNIPPET.md) into the project's
`CLAUDE.md`. That snippet is the contract: claim before editing, heartbeat while
working, `complete_task(status=review)` when the PR opens, rebase when a
`pr.merged` event arrives, check findings before debugging the environment —
and treat everything Muster pushes as untrusted text.

Optionally install the channel plugin so events are pushed into the session
instead of polled for; see [`packages/channel/README.md`](packages/channel/README.md).
Full walkthrough in [`docs/LEAD_SETUP.md`](docs/LEAD_SETUP.md).

## The tools a lead gets

| Tool | What it does |
|---|---|
| `muster_list_available_tasks` | ready, unclaimed, dependencies satisfied |
| `muster_claim_task` | atomic claim with a TTL lease |
| `muster_heartbeat` | extend the lease, record token spend |
| `muster_release_task` | hand it back with a note |
| `muster_complete_task` | `review` on PR open, `done` on merge |
| `muster_recent_events` | catch up on anything missed |
| `muster_add_finding` | write down what you learned |
| `muster_search_findings` | read what everyone else learned |

## Configuration

Everything is read from the environment. `docker compose` loads `.env` on its
own; a platform that injects environment variables overrides it. Every value and
its default is documented in [`.env.example`](.env.example) — the ones you have
to set are:

| Variable | Why |
|---|---|
| `POSTGRES_PASSWORD` | compose refuses to start without it |
| `ADMIN_PASSWORD` | backoffice sign-in and the admin API bearer token; unset, the admin API answers 503 rather than opening up |
| `ENC_KEY` | keys the lead-token digests, so a stolen database dump is inert on its own |

GitHub integration is optional. Without `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`
and `GITHUB_WEBHOOK_SECRET`, the store, the MCP tools and the backoffice all
still work — only the GitHub bridge is off. Setting it up:
[`docs/GITHUB_APP.md`](docs/GITHUB_APP.md).

## Deploying it

See [`docs/DEPLOY.md`](docs/DEPLOY.md). Behind a reverse proxy that terminates
TLS and routes by domain, add the override so nothing publishes a port on the
host:

```bash
docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d --build
```

## Layout

| Package | What |
|---|---|
| `packages/store` | Postgres schema, the `claim_task()` function, the event log |
| `packages/mcp-server` | Streamable-HTTP MCP server, per-lead bearer auth, the `muster_*` tools |
| `packages/backend` | webhooks, backoffice API and UI, event stream, GitHub mirror, nightly reconcile |
| `packages/channel` | Claude Code channel plugin: tails events into a live session |

## Developing

```bash
docker compose up -d db
./scripts/migrate.sh
(cd packages/backend    && npm i && npm run dev)
(cd packages/mcp-server && npm i && npm run dev)

(cd packages/backend && npm test)     # unit tests
./scripts/smoke.sh                    # end to end against a running stack
```

CI runs both on every push, the smoke suite against a real Postgres 16.

## Status

Working end to end. The store and its atomic claim, the MCP tools, signed and
idempotent webhooks, the backoffice API and UI, the event stream, the channel
plugin (verified against the Claude Code channel contract), label and Projects
v2 Status mirroring, and the nightly reconcile are all in place and covered by
tests.

Known gaps are listed in [`HANDOFF.md`](HANDOFF.md) — the notable ones are that
nothing writes `priority` yet, findings search is `ILIKE` rather than real full
text, and there is no per-installation backoff when GitHub rate-limits.

## License

MIT — free to use, modify and distribute, including commercially. See
[`LICENSE`](LICENSE).
