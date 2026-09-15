/**
 * The one GitHub App, built from environment alone.
 *
 * The private key can arrive two ways. A path suits a local checkout with the
 * .pem next to it; the key itself as an env var suits a container platform
 * where every setting comes from the environment and there is no filesystem to
 * put a secret on. Both forms are accepted, and multi-line PEMs that have been
 * flattened on the way through a dashboard are unflattened.
 */
import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { throttling } from "@octokit/plugin-throttling";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { readFileSync } from "node:fs";

/** PEM parsers want the trailing newline, and trim()/unescaping disagree about it. */
const normalisePem = (pem: string) => pem.trim() + "\n";

export function githubPrivateKey(): string {
  const inline = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (inline) {
    // A PEM pasted into an env var usually loses its newlines to \n, and some
    // platforms base64 it to sidestep the problem. Accept all three forms.
    if (!inline.includes("BEGIN") && /^[A-Za-z0-9+/=\s]+$/.test(inline)) {
      return normalisePem(Buffer.from(inline, "base64").toString("utf8"));
    }
    return normalisePem(inline.replace(/\\n/g, "\n"));
  }
  const path = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (path) return normalisePem(readFileSync(path, "utf8"));
  throw new Error("set GITHUB_APP_PRIVATE_KEY (the PEM itself) or GITHUB_APP_PRIVATE_KEY_PATH");
}

/** How many times a throttled request is retried before we give up on it. */
const MAX_RETRIES = Number(process.env.GITHUB_THROTTLE_RETRIES ?? 3);
/** Longer than this and waiting is worse than coming back on the next cycle. */
const MAX_WAIT_SEC = Number(process.env.GITHUB_THROTTLE_MAX_WAIT_SEC ?? 120);

/**
 * Octokit with throttling. Without it the mirror and the reconcile keep calling
 * a GitHub that is returning 403 secondary-rate-limit, every interval, forever.
 *
 * The plugin reads `retry-after` and `x-ratelimit-reset` and hands us the wait;
 * we retry only while that wait is short. A rate limit that resets in an hour is
 * not something to sleep through holding a connection — the mirror runs on a
 * timer and the reconcile is nightly, so both come back on their own.
 */
const ThrottledOctokit = Octokit.plugin(throttling, paginateRest);

/** Whether a throttled request is worth retrying in-process. Pure, so it can be tested. */
export function shouldRetryAfter(retryAfter: number, retryCount: number): boolean {
  return retryCount < MAX_RETRIES && retryAfter <= MAX_WAIT_SEC;
}

function throttleOptions(kind: "primary" | "secondary") {
  return (retryAfter: number, options: any, _octokit: unknown, retryCount: number) => {
    const where = `${options.method} ${options.url}`;
    if (!shouldRetryAfter(retryAfter, retryCount)) {
      console.error(
        `github: ${kind} rate limit on ${where}; giving up after ${retryCount} ` +
        `retries (would wait ${retryAfter}s). The next scheduled run will pick it up.`);
      return false;
    }
    console.error(`github: ${kind} rate limit on ${where}; retrying in ${retryAfter}s`);
    return true;
  };
}

/**
 * Per-repository circuit breaker.
 *
 * Throttling handles "slow down". This handles "this one is broken": an
 * installation that was uninstalled, a repo that was renamed, a 404 on every
 * call. Without it the mirror retries the same failing repo every interval
 * forever, and its log drowns the repos that are fine.
 *
 * In memory on purpose — it is a rate limiter, not state. A restart clearing it
 * only means one more attempt.
 */
const BREAKER_AFTER = Number(process.env.GITHUB_BREAKER_FAILURES ?? 3);
const BREAKER_SEC = Number(process.env.GITHUB_BREAKER_COOLDOWN_SEC ?? 900);
const breaker = new Map<string, { failures: number; openUntil: number }>();

export function circuitOpen(key: string): boolean {
  const entry = breaker.get(key);
  return !!entry && entry.openUntil > Date.now();
}

export function noteGithubFailure(key: string): void {
  const entry = breaker.get(key) ?? { failures: 0, openUntil: 0 };
  entry.failures++;
  if (entry.failures >= BREAKER_AFTER) {
    entry.openUntil = Date.now() + BREAKER_SEC * 1000;
    console.error(`github: ${key} failed ${entry.failures} times; skipping it for ${BREAKER_SEC}s`);
  }
  breaker.set(key, entry);
}

export function noteGithubSuccess(key: string): void {
  breaker.delete(key);
}

/** Tests only. */
export function resetCircuits(): void { breaker.clear(); }

export function makeApp(): App {
  const appId = process.env.GITHUB_APP_ID;
  if (!appId) throw new Error("GITHUB_APP_ID is not set");
  return new App({
    appId,
    privateKey: githubPrivateKey(),
    Octokit: ThrottledOctokit.defaults({
      throttle: {
        onRateLimit: throttleOptions("primary"),
        onSecondaryRateLimit: throttleOptions("secondary")
      }
    })
  });
}

/** True when there is enough configuration to talk to GitHub at all. */
export function githubConfigured(): boolean {
  return !!process.env.GITHUB_APP_ID &&
    !!(process.env.GITHUB_APP_PRIVATE_KEY?.trim() || process.env.GITHUB_APP_PRIVATE_KEY_PATH);
}
