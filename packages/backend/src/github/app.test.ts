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
import { githubPrivateKey, githubConfigured } from "./app.js";

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
