# Deploying Muster

Everything is read from the environment. There is no config file to template and
nothing to bake into an image: `docker compose` loads `.env`, and any platform
that injects environment variables overrides it.

## What you are deploying

| Service | Port | Needs to be reachable by |
|---|---|---|
| `backend` | 8080 | GitHub (webhooks), you (backoffice at `/ui/`), lead sessions (event stream) |
| `mcp-server` | 8090 | lead sessions only |
| `db` | 5432 | nothing outside the compose network |
| `migrate` | — | one-shot; runs the migrations and exits |

`migrate` must be allowed to run to completion: `backend` and `mcp-server` both
wait on `service_completed_successfully`, so a deploy that adds a migration
applies it before any code that depends on it starts.

## Required settings

```bash
POSTGRES_PASSWORD=$(openssl rand -base64 24)
ADMIN_PASSWORD=$(openssl rand -base64 24)
```

Compose refuses to start without either. `ADMIN_PASSWORD` is both the backoffice
sign-in and the admin API bearer token; if it is unset the admin API answers 503
rather than opening up, because an unauthenticated backoffice on a public URL is
worse than a broken one.

Everything else has a working default. See [`.env.example`](../.env.example).

## On a plain Docker host

```bash
git clone https://github.com/binaryversion/muster && cd muster
cp .env.example .env && $EDITOR .env
docker compose up -d --build
```

`backend` and `mcp-server` publish their ports; `db` binds to `127.0.0.1` so it
is reachable from the host for `psql` and `scripts/smoke.sh` but not from
anywhere else. Put TLS in front of the backend before pointing GitHub at it —
webhook signatures authenticate the payload, not the transport, and lead tokens
travel in an `Authorization` header.

## Behind a reverse proxy (Coolify, Dokploy, Traefik, Caddy, nginx)

Add the override so nothing publishes a port on the host at all. The proxy
reaches the services over the compose network:

```bash
docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d --build
```

Then route two hostnames:

| Hostname | to | TLS |
|---|---|---|
| `muster.example.com` | `backend:8080` | yes |
| `mcp.example.com` | `mcp-server:8090` | yes |

Both can be the same hostname on different paths if your proxy does that; the
backend serves `/webhooks/github`, `/admin/*`, `/ui/` and `/events/stream`, and
the MCP server serves `/mcp`.

Leave `TRUST_PROXY=true` (the default). It is what lets the backend see the real
client IP for login throttling and mark the session cookie `Secure` when the
forwarded scheme is https.

### Notes for a PaaS that builds from a git repo

Platforms like Coolify and Dokploy deploy a compose file straight from the
repository and supply environment variables from their own UI rather than from a
committed `.env`. That is exactly how this compose file expects to be driven —
set `POSTGRES_PASSWORD` and `ADMIN_PASSWORD` there and leave `.env` out of the
repo (it is gitignored).

Two things to check on your platform:

- **Bind mounts.** The `migrate` service mounts `./packages/store/migrations`
  and `./scripts/migrate.sh` from the checkout. Platforms that clone the repo
  onto the host handle this fine; if yours builds in a sandbox that does not
  expose the checkout to the daemon, run the migrations as a release command
  instead — `DATABASE_URL=... ./scripts/migrate.sh` does the same thing.
- **Domains and TLS.** Assign these in the platform's UI. Some versions of
  Coolify also accept magic `SERVICE_FQDN_*` environment variables in the
  compose file; this file does not use them, so set the domain on the service in
  the UI. Check your version's documentation — it was not reachable from the
  environment this was written in, so treat the exact variable names there as
  unverified.

## After the first deploy

1. Open `https://muster.example.com/ui/` and sign in with `ADMIN_PASSWORD`.
2. Create a project and list its repos.
3. Issue a lead token per developer machine. It is shown once.
4. Set up the GitHub App if you want the GitHub bridge —
   [`docs/GITHUB_APP.md`](GITHUB_APP.md) — and point its webhook at
   `https://muster.example.com/webhooks/github`.
5. Turn on the mirror and the nightly reconcile once the App is installed:
   `GITHUB_SYNC_ENABLED=true`, `GITHUB_RECONCILE_ENABLED=true`. Both refuse to
   start without App credentials and say so once in the log rather than failing
   on every tick.

## Upgrading

```bash
git pull
docker compose up -d --build
```

`migrate` runs again on every deploy and is a no-op when there is nothing new.
Migrations are tracked in a `schema_migrations` table, so an existing database
is picked up rather than re-initialised.

## Backups

Everything that matters is in Postgres: claims, leases, findings and the event
log. The `pgdata` volume is the whole of it.

```bash
docker compose exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > muster-$(date +%F).sql.gz
```

Tasks can be rebuilt from GitHub by a full reconcile
(`POST /admin/reconcile?full=1`), but findings, the event log and token spend
exist nowhere else.

## Security checklist

- [ ] `ADMIN_PASSWORD` is long and random, not a word you chose.
- [ ] TLS in front of the backend and the MCP server.
- [ ] `db` is not published — the default binds it to loopback, and the proxy
      override removes the port entirely.
- [ ] `GITHUB_WEBHOOK_SECRET` matches the App; unsigned deliveries are rejected.
- [ ] Lead tokens have an expiry (`expires_in_days`), and you revoke them when a
      machine is retired. Revocation takes effect on the next call.
- [ ] You know that findings and channel events are untrusted text written by
      other agents. Muster never relays permission approvals between sessions,
      and neither should anything you build on it.
