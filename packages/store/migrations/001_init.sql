-- applied-if: SELECT to_regclass('public.tasks') IS NOT NULL
-- Muster store: coordination state for Claude Code lead sessions across machines.
-- Humans plan in GitHub Projects; agents claim/complete here. This is the source
-- of truth for claim, lease, status and findings. GitHub is the source of truth
-- for title, body and priority (see docs/ARCHITECTURE.md for the tie-break rules).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text UNIQUE NOT NULL,
  name          text NOT NULL,
  github_owner  text,                    -- org or user
  github_repos  text[] NOT NULL DEFAULT '{}',
  github_project_number int,            -- GitHub Projects v2 number (optional mirror)
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- A "lead" is one Claude Code lead session identity (usually one developer's
-- orchestrator). Tokens are hashed; the plaintext is shown once at issuance.
CREATE TABLE IF NOT EXISTS leads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          text NOT NULL,           -- e.g. "alice-laptop"
  token_hash    text UNIQUE NOT NULL,    -- sha256 of bearer token
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

-- CREATE TYPE has no IF NOT EXISTS, and this file has to survive being re-run
-- against a schema that arrived some other way.
DO $$ BEGIN
  CREATE TYPE task_status AS ENUM ('backlog','ready','in_progress','review','done','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE task_source AS ENUM ('human','agent');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         text NOT NULL,
  body          text,
  priority      int NOT NULL DEFAULT 3,  -- 1 = highest
  status        task_status NOT NULL DEFAULT 'ready',
  source        task_source NOT NULL DEFAULT 'human',
  -- agent-owned fields
  claimed_by    uuid REFERENCES leads(id),
  lease_until   timestamptz,
  cost_tokens   bigint NOT NULL DEFAULT 0,
  -- identity map to GitHub (issue and/or project item)
  github_repo         text,
  github_issue_number int,
  github_node_id      text,              -- issue node id
  github_item_id      text,              -- ProjectV2Item node id
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (github_repo, github_issue_number)
);
CREATE INDEX IF NOT EXISTS tasks_available_idx ON tasks (project_id, priority, created_at)
  WHERE status = 'ready' AND claimed_by IS NULL;

CREATE TABLE IF NOT EXISTS task_deps (
  task_id       uuid REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on    uuid REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on)
);

-- Shared discoveries so every agent does not rediscover the same gotcha.
CREATE TABLE IF NOT EXISTS findings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id       uuid REFERENCES tasks(id) ON DELETE SET NULL,
  lead_id       uuid REFERENCES leads(id),
  tags          text[] NOT NULL DEFAULT '{}',
  content       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Append-only event log. The channel server tails this to push events into
-- running Claude Code sessions; the backoffice reads it for audit.
CREATE TABLE IF NOT EXISTS events (
  id            bigserial PRIMARY KEY,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          text NOT NULL,           -- task.claimed, task.released, task.completed,
                                         -- pr.merged, ci.failed, finding.added, ...
  actor         text NOT NULL,           -- lead name, "github", "admin"
  payload       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_project_id_idx ON events (project_id, id);

-- Idempotency for GitHub webhook redelivery.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id   text PRIMARY KEY,
  received_at   timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tasks_touch ON tasks;
CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Atomic claim: succeeds only if the task is ready, unclaimed (or lease expired),
-- and all dependencies are done. Returns the row or nothing.
CREATE OR REPLACE FUNCTION claim_task(p_task uuid, p_lead uuid, p_lease_seconds int)
RETURNS tasks AS $$
DECLARE r tasks;
BEGIN
  UPDATE tasks t SET
      claimed_by = p_lead,
      lease_until = now() + make_interval(secs => p_lease_seconds),
      status = 'in_progress'
  WHERE t.id = p_task
    AND t.status IN ('ready','in_progress')
    AND (t.claimed_by IS NULL OR t.lease_until < now() OR t.claimed_by = p_lead)
    AND NOT EXISTS (
      SELECT 1 FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on
      WHERE d.task_id = t.id AND dt.status <> 'done')
  RETURNING * INTO r;
  RETURN r;
END $$ LANGUAGE plpgsql;
