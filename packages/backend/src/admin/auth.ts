/**
 * Backoffice authentication.
 *
 * One secret, ADMIN_PASSWORD, reached two ways:
 *   - `Authorization: Bearer <password>` for curl, scripts and CI
 *   - a session cookie for the browser, so an operator types a password once
 *     instead of pasting the secret into a field on every tab
 *
 * Sessions are rows, not signed cookies. A signed cookie cannot be revoked —
 * signing out would only drop the browser's copy while the value stayed valid
 * until it expired. Rows also mean a second backend replica works, and that the
 * login throttle counts a client's attempts once rather than once per process.
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { query } from "../db.js";

export const COOKIE = "muster_admin";
const SESSION_HOURS = Number(process.env.ADMIN_SESSION_HOURS ?? 12);
const LOCKOUT_AFTER = Number(process.env.ADMIN_LOGIN_ATTEMPTS ?? 8);
const LOCKOUT_MIN = 5;
const SLOW_DOWN_SEC = 30;

/** ADMIN_TOKEN is the old name; still honoured so existing scripts keep working. */
export function adminSecret(): string | undefined {
  return process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN || undefined;
}

/** Constant-time compare that does not leak length through an early return. */
export function sameSecret(a: string, b: string): boolean {
  const ha = createHmac("sha256", "compare").update(a).digest();
  const hb = createHmac("sha256", "compare").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/**
 * Behind Coolify, Traefik or any other reverse proxy the connection into the
 * container is plain http, so trust the forwarded scheme to decide whether the
 * cookie can be marked Secure.
 */
function isHttps(req: Request): boolean {
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  return forwarded ? forwarded === "https" : req.protocol === "https";
}

export async function setSessionCookie(req: Request, res: Response): Promise<void> {
  const id = randomBytes(32).toString("base64url");
  await query(
    `INSERT INTO admin_sessions (id, expires_at) VALUES ($1, now() + make_interval(hours => $2))`,
    [id, SESSION_HOURS]);
  res.cookie(COOKIE, id, {
    httpOnly: true, sameSite: "strict", secure: isHttps(req),
    maxAge: SESSION_HOURS * 3600_000, path: "/"
  });
  // Cheap to piggyback, and keeps the table from growing on a scanned instance.
  await query("DELETE FROM admin_sessions WHERE expires_at < now()").catch(() => {});
}

export async function clearSessionCookie(req: Request, res: Response): Promise<void> {
  const id = readCookie(req, COOKIE);
  if (id) await query("DELETE FROM admin_sessions WHERE id = $1", [id]);
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: "strict", secure: isHttps(req), path: "/" });
}

async function validSession(id: string | undefined): Promise<boolean> {
  if (!id) return false;
  const rows = await query(
    `UPDATE admin_sessions SET last_seen_at = now()
     WHERE id = $1 AND expires_at > now() RETURNING id`, [id]);
  return rows.length > 0;
}

/** Client identity for throttling: the real IP, through any proxy. */
function clientKey(req: Request): string {
  return String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.ip || "unknown";
}

export async function lockedOut(req: Request): Promise<boolean> {
  const rows = await query<{ locked: boolean }>(
    `SELECT (failures >= $2 AND locked_until > now()) AS locked
     FROM admin_login_attempts WHERE client = $1`, [clientKey(req), LOCKOUT_AFTER]);
  return rows[0]?.locked === true;
}

export async function loginThrottle(req: Request): Promise<number> {
  const rows = await query<{ secs: number }>(
    `SELECT ceil(extract(epoch FROM locked_until - now()))::int AS secs
     FROM admin_login_attempts
     WHERE client = $1 AND failures >= $2 AND locked_until > now()`, [clientKey(req), LOCKOUT_AFTER]);
  return rows[0]?.secs ?? 0;
}

/**
 * Brute force is the realistic attack on a password typed into a form on the
 * public internet.
 *
 * `locked_until` does double duty: after a single failure it is just the window
 * in which further failures still count towards the same total, and only once
 * `failures` crosses the threshold does it become an actual lockout. One typo
 * must not cost thirty seconds.
 */
export async function noteLoginFailure(req: Request): Promise<void> {
  await query(
    `INSERT INTO admin_login_attempts (client, failures, locked_until, updated_at)
     VALUES ($1, 1, now() + make_interval(secs => $3), now())
     ON CONFLICT (client) DO UPDATE SET
       -- A lapsed lockout starts the count again rather than accumulating
       -- forever across unrelated sessions.
       failures = CASE WHEN admin_login_attempts.locked_until > now()
                       THEN admin_login_attempts.failures + 1 ELSE 1 END,
       locked_until = now() + CASE
         WHEN (CASE WHEN admin_login_attempts.locked_until > now()
                    THEN admin_login_attempts.failures + 1 ELSE 1 END) >= $2
         THEN make_interval(mins => $4) ELSE make_interval(secs => $3) END,
       updated_at = now()`,
    [clientKey(req), LOCKOUT_AFTER, SLOW_DOWN_SEC, LOCKOUT_MIN]);
  await query("DELETE FROM admin_login_attempts WHERE updated_at < now() - interval '1 day'").catch(() => {});
}

export async function noteLoginSuccess(req: Request): Promise<void> {
  await query("DELETE FROM admin_login_attempts WHERE client = $1", [clientKey(req)]);
}

/** Gate for everything under /admin. */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const secret = adminSecret();
  if (!secret) {
    // Refusing beats defaulting to open: an unset password on a published
    // instance would otherwise hand the backoffice to whoever finds the URL.
    return res.status(503).json({ error: "ADMIN_PASSWORD is not set on the backend" });
  }
  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer && sameSecret(bearer, secret)) return next();

  validSession(readCookie(req, COOKIE))
    .then(ok => ok ? next() : res.status(401).json({ error: "authentication required" }))
    .catch(err => {
      console.error("admin session lookup failed", err);
      res.status(503).json({ error: "session store unavailable" });
    });
}
