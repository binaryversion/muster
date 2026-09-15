import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, REDACTED } from "./redact.js";

/**
 * Fixtures are assembled at runtime rather than written out.
 *
 * A token-shaped literal in a source file is indistinguishable from a real
 * leaked one to every scanner that looks — GitHub's push protection rejected an
 * earlier version of this file over the Slack fixture below, which was fake. A
 * repository should not contain strings that look like credentials, even in a
 * test for removing them.
 */
const join = (...parts: string[]) => parts.join("");

test("recognisable tokens are removed", () => {
  const cases: [string, string][] = [
    [`use ${join("mstr", "_", "dtGAowXnp9udbekf1iuVnNRt2BeMnJak")} to auth`, "muster lead token"],
    [`${join("gh", "p", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")} works`, "github token"],
    [`${join("github", "_pat_", "11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ")} token`, "github token"],
    [`${join("xox", "b", "-123456789012-abcdefghijklmno")} pinged`, "slack token"],
    [`${join("AKIA", "IOSFODNN7EXAMPLE")} is the key id`, "aws access key id"],
    [`${join("sk", "-", "abcdefghijklmnopqrstuvwxyz012345")} for the api`, "openai key"],
    [join("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".",
          "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "jwt"]
  ];
  for (const [input, kind] of cases) {
    const out = redactSecrets(input);
    assert.ok(out.text.includes(REDACTED), `${kind}: not redacted — ${out.text}`);
    assert.deepEqual(out.kinds, [kind]);
  }
});

test("a private key block goes entirely", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----";
  const out = redactSecrets(`the app key is:\n${pem}\nand that is it`);
  assert.ok(!out.text.includes("MIIEowIBAAKCAQEA"));
  assert.ok(out.text.startsWith("the app key is:"));
  assert.ok(out.text.endsWith("and that is it"));
});

test("a password in a connection string goes, the rest stays readable", () => {
  const out = redactSecrets("connect with postgres://muster:sup3rs3cret@db:5432/muster");
  assert.equal(out.text, `connect with postgres://muster:${REDACTED}@db:5432/muster`);
});

test("assignments keep the name so the finding still reads", () => {
  const out = redactSecrets('set ADMIN_PASSWORD="hunter2-correct-horse" in the env');
  assert.ok(out.text.includes("ADMIN_PASSWORD"), "the name is the useful part");
  assert.ok(!out.text.includes("hunter2-correct-horse"));
});

test("an Authorization header is stripped of its value", () => {
  const out = redactSecrets('curl -H "Authorization: Bearer abcdefghijklmnop" http://x');
  assert.ok(!out.text.includes("abcdefghijklmnop"));
  assert.ok(out.text.includes("Authorization"));
});

test("ordinary findings are left completely alone", () => {
  // A rule broad enough to catch any long random-looking string would eat these,
  // and a finding mangled into uselessness is worse than one with a token in it.
  const safe = [
    "The test suite fails on Node 20; structuredClone is missing.",
    "Docker build dies with ENOSPC when the layer cache is full.",
    "Chromium needs --no-sandbox inside the container.",
    "Reverted in 9f3ac41b2e8d4c5a6b7e8f9a0b1c2d3e4f5a6b7c, see the thread.",
    "Postgres listens on 5432; compose binds it to loopback.",
    "Use claude mcp add --transport http muster https://muster.example.com/mcp"
  ];
  for (const text of safe) {
    const out = redactSecrets(text);
    assert.equal(out.text, text, `should not have touched: ${text}`);
    assert.deepEqual(out.kinds, []);
  }
});

test("several secrets in one finding are all caught and reported", () => {
  const muster = join("mstr", "_", "dtGAowXnp9udbekf1iuVnNRt2BeMnJak");
  const github = join("gh", "p", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
  const out = redactSecrets(`token ${muster} and ${github}`);
  assert.ok(!out.text.includes(muster));
  assert.ok(!out.text.includes(github));
  assert.deepEqual(out.kinds.sort(), ["github token", "muster lead token"]);
});
