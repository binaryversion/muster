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

export function makeApp(): App {
  const appId = process.env.GITHUB_APP_ID;
  if (!appId) throw new Error("GITHUB_APP_ID is not set");
  return new App({ appId, privateKey: githubPrivateKey() });
}

/** True when there is enough configuration to talk to GitHub at all. */
export function githubConfigured(): boolean {
  return !!process.env.GITHUB_APP_ID &&
    !!(process.env.GITHUB_APP_PRIVATE_KEY?.trim() || process.env.GITHUB_APP_PRIVATE_KEY_PATH);
}
