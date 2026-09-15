/**
 * Backoffice authentication.
 *
 * One secret, ADMIN_PASSWORD, reached two ways:
 *   - `Authorization: Bearer <password>` for curl, scripts and CI
 *   - a session cookie for the browser, so an operator types a password once
 *     instead of pasting the secret into a field on every tab
 *
 * Sessions are held in memory rather than signed into the cookie, so signing out
 * actually revokes the session instead of only dropping the browser's copy of a
 * value that stays valid until it expires. The cost is that a backend restart
 * signs the operator out and that two replicas do not share sessions — both fine
 * for a single-operator backoffice, and scripts use the bearer token anyway.
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export const COOKIE = "muster_admin";
const SESSION_MS = Number(process.env.ADMIN_SESSION_HOURS ?? 12) * 3600_000;

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

/** session id -> expiry. Pruned lazily; one small entry per sign-in. */
const sessions = new Map<string, number>();

function issueSession(): { value: string; maxAge: number } {
  const id = randomBytes(32).toString("base64url");
  sessions.set(id, Date.now() + SESSION_MS);
  if (sessions.size > 1000) for (const [k, exp] of sessions) if (exp < Date.now()) sessions.delete(k);
  return { value: id, maxAge: Math.floor(SESSION_MS / 1000) };
}

function validSession(id: string | undefined): boolean {
  if (!id) return false;
  const expiresAt = sessions.get(id);
  if (expiresAt === undefined) return false;
  if (expiresAt < Date.now()) { sessions.delete(id); return false; }
  return true;
}

export function revokeSession(id: string | undefined) {
  if (id) sessions.delete(id);
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

export function setSessionCookie(req: Request, res: Response) {
  const { value, maxAge } = issueSession();
  res.cookie(COOKIE, value, {
    httpOnly: true, sameSite: "strict", secure: isHttps(req), maxAge: maxAge * 1000, path: "/"
  });
}

export function clearSessionCookie(req: Request, res: Response) {
  revokeSession(readCookie(req, COOKIE));
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: "strict", secure: isHttps(req), path: "/" });
}

/**
 * Brute force is the realistic attack on a password that is typed into a form
 * on the public internet. Failures are counted per client and the delay grows;
 * the window is short enough that a locked-out operator waits rather than files
 * a bug.
 */
const failures = new Map<string, { count: number; until: number }>();
const LOCKOUT_AFTER = Number(process.env.ADMIN_LOGIN_ATTEMPTS ?? 8);
const LOCKOUT_MS = 5 * 60_000;

function clientKey(req: Request): string {
  return String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.ip || "unknown";
}

export function loginThrottle(req: Request): number {
  const entry = failures.get(clientKey(req));
  if (!entry || entry.until < Date.now()) return 0;
  return Math.ceil((entry.until - Date.now()) / 1000);
}

export function noteLoginFailure(req: Request) {
  const key = clientKey(req);
  const entry = failures.get(key);
  const count = (entry && entry.until > Date.now() ? entry.count : 0) + 1;
  failures.set(key, { count, until: Date.now() + (count >= LOCKOUT_AFTER ? LOCKOUT_MS : 30_000) });
  // Stop the map growing without bound on a scanned instance.
  if (failures.size > 5000) for (const [k, v] of failures) if (v.until < Date.now()) failures.delete(k);
}

export function noteLoginSuccess(req: Request) {
  failures.delete(clientKey(req));
}

export function lockedOut(req: Request): boolean {
  const entry = failures.get(clientKey(req));
  return !!entry && entry.count >= LOCKOUT_AFTER && entry.until > Date.now();
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
  if (validSession(readCookie(req, COOKIE))) return next();
  res.status(401).json({ error: "authentication required" });
}

/** Unguessable value for a first run where the operator did not set one. */
export const suggestPassword = () => randomBytes(18).toString("base64url");
