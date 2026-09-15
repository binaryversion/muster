/**
 * Token digests. Getting these wrong either locks every lead out or, worse,
 * quietly stores something an attacker with the database could use.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  encKey, resetKeyCache, tokensAreKeyed, digestForStorage, candidateDigests, digestsEqual
} from "./crypto.js";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
const TOKEN = "mstr_dtGAowXnp9udbekf1iuVnNRt2BeMnJak";

function withKey(value: string | undefined, body: () => void) {
  const saved = process.env.ENC_KEY;
  if (value === undefined) delete process.env.ENC_KEY; else process.env.ENC_KEY = value;
  resetKeyCache();
  try { body(); } finally {
    if (saved === undefined) delete process.env.ENC_KEY; else process.env.ENC_KEY = saved;
    resetKeyCache();
  }
}

test("ENC_KEY is accepted as base64 or hex", () => {
  withKey(KEY_A, () => assert.equal(encKey()!.length, 32));
  withKey(Buffer.alloc(32, 7).toString("hex"), () => assert.equal(encKey()!.length, 32));
  withKey(undefined, () => assert.equal(encKey(), null));
});

test("a short ENC_KEY is refused rather than silently weakening every token", () => {
  withKey(Buffer.alloc(16, 1).toString("base64"), () =>
    assert.throws(() => encKey(), /at least 32/));
});

test("a stored digest is keyed, and never the token", () => {
  withKey(KEY_A, () => {
    const { hash, alg } = digestForStorage(TOKEN);
    assert.equal(alg, "hmac-sha256");
    assert.equal(hash.length, 64);
    assert.ok(!hash.includes(TOKEN));
    // The whole point: the same token under a different key is a different
    // digest, so a dump without ENC_KEY cannot be used to test a guess.
    withKey(KEY_B, () => assert.notEqual(digestForStorage(TOKEN).hash, hash));
  });
});

test("the digest is stable for the same token and key", () => {
  withKey(KEY_A, () => assert.equal(digestForStorage(TOKEN).hash, digestForStorage(TOKEN).hash));
});

test("without ENC_KEY it falls back to sha256 and says which it used", () => {
  withKey(undefined, () => {
    const { alg } = digestForStorage(TOKEN);
    assert.equal(alg, "sha256");
    assert.equal(tokensAreKeyed(), false);
  });
  withKey(KEY_A, () => assert.equal(tokensAreKeyed(), true));
});

test("candidateDigests offers both, so a pre-ENC_KEY database keeps working", () => {
  withKey(undefined, () => {
    const legacyOnly = candidateDigests(TOKEN);
    assert.equal(legacyOnly.keyed, null);

    withKey(KEY_A, () => {
      const both = candidateDigests(TOKEN);
      // The legacy digest is unchanged by introducing a key, which is what lets
      // an existing row authenticate and then be upgraded in place.
      assert.equal(both.legacy, legacyOnly.legacy);
      assert.equal(both.keyed, digestForStorage(TOKEN).hash);
      assert.notEqual(both.keyed, both.legacy);
    });
  });
});

test("digestsEqual is length-safe and does not match near misses", () => {
  const a = "a".repeat(64), b = "a".repeat(62) + "bb";
  assert.equal(digestsEqual(a, a), true);
  assert.equal(digestsEqual(a, b), false);
  assert.equal(digestsEqual(a, "a".repeat(32)), false);   // would throw if unguarded
});

test("the two copies of crypto.ts are byte-identical", () => {
  // They are separate npm packages with separate installs, so the module is
  // duplicated. If they drift, leads authenticate against one service and not
  // the other. CI checks this too; this makes it fail locally first.
  // npm test runs from the package root; the compiled test lives under dist/,
  // so resolve the sources from cwd rather than from import.meta.url.
  const root = process.cwd();
  const backend = readFileSync(join(root, "src/crypto.ts"), "utf8");
  const mcp = readFileSync(join(root, "../mcp-server/src/crypto.ts"), "utf8");
  assert.equal(mcp, backend, "packages/mcp-server/src/crypto.ts has drifted from the backend copy");
});
