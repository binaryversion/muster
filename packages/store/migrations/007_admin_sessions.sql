-- applied-if: SELECT to_regclass('public.admin_sessions') IS NOT NULL
-- Backoffice sessions and login throttling, shared across backend replicas.
--
-- Both lived in a module-level Map. That made sign-out genuinely revoke, which
-- a signed cookie could not, but it tied them to one process: scale the backend
-- past a single instance and sign-in works or fails depending on which
-- container the proxy picked, while N replicas give an attacker N times the
-- login attempts.

CREATE TABLE IF NOT EXISTS admin_sessions (
  id           text PRIMARY KEY,          -- random, never derived from the password
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions (expires_at);

-- One row per client, not per attempt: the count is what matters and an
-- unbounded attempt log is its own denial of service.
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  client      text PRIMARY KEY,
  failures    int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_login_attempts_updated_idx ON admin_login_attempts (updated_at);
