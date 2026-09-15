/**
 * The private key can arrive as a path, as a PEM, as a PEM flattened to \n
 * escapes by a dashboard that will not take newlines, or base64'd to dodge the
 * problem. Getting this wrong means the GitHub bridge fails at the first API
 * call with an opaque crypto error, so it is worth pinning down.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubPrivateKey, githubConfigured, shouldRetryAfter, circuitOpen, noteGithubFailure, noteGithubSuccess, resetCircuits } from "./app.js";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc123\n-----END RSA PRIVATE KEY-----\n";
const KEYS = ["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_PRIVATE_KEY_PATH", "GITHUB_APP_ID"] as const;

function withEnv(vars: Partial<Record<(typeof KEYS)[number], string>>, body: () => void) {
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try { body(); } finally {
    for (const k of KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]!; }
  }
}

test("a PEM with real newlines is used as-is", () => {
  withEnv({ GITHUB_APP_PRIVATE_KEY: PEM }, () => assert.equal(githubPrivateKey(), PEM));
});

test("a PEM flattened to \\n escapes is unflattened", () => {
  // Every accepted form must come out byte-identical, trailing newline included.
  withEnv({ GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, "\\n") }, () =>
    assert.equal(githubPrivateKey(), PEM));
});

test("a base64'd PEM is decoded", () => {
  withEnv({ GITHUB_APP_PRIVATE_KEY: Buffer.from(PEM).toString("base64") }, () =>
    assert.equal(githubPrivateKey(), PEM));
});

test("a base64'd PEM split across lines is decoded", () => {
  const wrapped = (Buffer.from(PEM).toString("base64").match(/.{1,24}/g) ?? []).join("\n");
  withEnv({ GITHUB_APP_PRIVATE_KEY: wrapped }, () => assert.equal(githubPrivateKey(), PEM));
});

test("the key wins over the path, so a stale mount cannot shadow the env", () => {
  const dir = mkdtempSync(join(tmpdir(), "muster-key-"));
  const path = join(dir, "other.pem");
  writeFileSync(path, "-----BEGIN RSA PRIVATE KEY-----\nstale\n-----END RSA PRIVATE KEY-----\n");
  withEnv({ GITHUB_APP_PRIVATE_KEY: PEM, GITHUB_APP_PRIVATE_KEY_PATH: path }, () =>
    assert.equal(githubPrivateKey(), PEM));
});

test("a PEM without its trailing newline gains one", () => {
  withEnv({ GITHUB_APP_PRIVATE_KEY: PEM.trimEnd() }, () => assert.equal(githubPrivateKey(), PEM));
});

test("a path still works for a local checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "muster-key-"));
  const path = join(dir, "github-app.pem");
  writeFileSync(path, PEM);
  withEnv({ GITHUB_APP_PRIVATE_KEY_PATH: path }, () => assert.equal(githubPrivateKey(), PEM));
});

test("an empty key is treated as unset, not as a key", () => {
  // Compose passes GITHUB_APP_PRIVATE_KEY="" when the var is not in .env.
  withEnv({ GITHUB_APP_PRIVATE_KEY: "   " }, () =>
    assert.throws(() => githubPrivateKey(), /GITHUB_APP_PRIVATE_KEY/));
});

test("githubConfigured needs an app id and some form of key", () => {
  withEnv({}, () => assert.equal(githubConfigured(), false));
  withEnv({ GITHUB_APP_ID: "123" }, () => assert.equal(githubConfigured(), false));
  withEnv({ GITHUB_APP_PRIVATE_KEY: PEM }, () => assert.equal(githubConfigured(), false));
  withEnv({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: PEM }, () => assert.equal(githubConfigured(), true));
  withEnv({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: "" , GITHUB_APP_PRIVATE_KEY_PATH: "/x.pem" }, () =>
    assert.equal(githubConfigured(), true));
});

test("a short rate-limit wait is retried, a long one is not", () => {
  // The mirror runs on a timer and the reconcile is nightly, so a limit that
  // resets in an hour is not worth sleeping through holding a connection.
  assert.equal(shouldRetryAfter(5, 0), true);
  assert.equal(shouldRetryAfter(60, 1), true);
  assert.equal(shouldRetryAfter(3600, 0), false);
});

test("retries are bounded, so one bad request cannot spin forever", () => {
  assert.equal(shouldRetryAfter(5, 2), true);
  assert.equal(shouldRetryAfter(5, 3), false);
  assert.equal(shouldRetryAfter(5, 99), false);
});

test("the circuit opens after repeated failures and closes on success", () => {
  resetCircuits();
  const repo = "acme/gone";
  assert.equal(circuitOpen(repo), false);
  noteGithubFailure(repo);
  noteGithubFailure(repo);
  // Still closed: two failures could be a blip.
  assert.equal(circuitOpen(repo), false);
  noteGithubFailure(repo);
  assert.equal(circuitOpen(repo), true, "three failures should open it");

  noteGithubSuccess(repo);
  assert.equal(circuitOpen(repo), false, "a success should clear it");
  resetCircuits();
});

test("circuits are per key, so one broken repo does not stop the others", () => {
  resetCircuits();
  for (let i = 0; i < 3; i++) noteGithubFailure("acme/broken");
  assert.equal(circuitOpen("acme/broken"), true);
  assert.equal(circuitOpen("acme/fine"), false);
  resetCircuits();
});
