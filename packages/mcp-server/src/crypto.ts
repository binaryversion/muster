/**
 * Credential material at rest.
 *
 * KEEP IN SYNC: this file is byte-identical in packages/backend/src/crypto.ts
 * and packages/mcp-server/src/crypto.ts. Both have to agree on how a lead token
 * is digested or leads stop authenticating. CI diffs the two.
 *
 * A lead token is never stored, in any recoverable form. What is stored is a
 * keyed digest: HMAC-SHA256 of the token under ENC_KEY. That is deliberately
 * not encryption — encryption is reversible, and a credential you can decrypt
 * is a credential an attacker with the database and the key can replay. A
 * keyed digest gives the property that matters:
 *
 *   - the database alone is useless: without ENC_KEY you cannot test a guess,
 *     so a dump, a backup or a read-only replica leaks nothing
 *   - the plaintext cannot be recovered even with the key
 *   - verification is still one indexed equality, not a table scan
 *
 * Rotating ENC_KEY invalidates every outstanding lead token at once. That is a
 * kill switch, not a bug, but it does mean reissuing them.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type DigestAlg = "hmac-sha256" | "sha256";

let cached: Buffer | null | undefined;
let warned = false;

/**
 * ENC_KEY as bytes, or null if it is not configured. Accepts base64 or hex and
 * insists on at least 32 bytes, because a short key here is the whole of the
 * security of every token in the table.
 */
export function encKey(): Buffer | null {
  if (cached !== undefined) return cached;
  const raw = process.env.ENC_KEY?.trim();
  if (!raw) return (cached = null);

  let bytes: Buffer;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) bytes = Buffer.from(raw, "hex");
  else bytes = Buffer.from(raw, "base64");

  if (bytes.length < 32) {
    throw new Error(
      `ENC_KEY decodes to ${bytes.length} bytes; at least 32 are required. ` +
      "Generate one with: openssl rand -base64 32"
    );
  }
  return (cached = bytes);
}

/** Only for tests, which set ENC_KEY after this module is first imported. */
export function resetKeyCache() { cached = undefined; warned = false; }

/** True when tokens are being keyed rather than plainly hashed. */
export function tokensAreKeyed(): boolean {
  return encKey() !== null;
}

function legacyDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The digest to store for a newly issued token. Falls back to a bare SHA-256
 * when ENC_KEY is unset so a local checkout still runs, with one warning rather
 * than silence — an operator who has not set a key should know it.
 */
export function digestForStorage(token: string): { hash: string; alg: DigestAlg } {
  const key = encKey();
  if (!key) {
    if (!warned) {
      warned = true;
      console.warn(
        "ENC_KEY is not set: lead tokens are stored as unkeyed SHA-256 digests. " +
        "Set ENC_KEY so a stolen database cannot be used to test token guesses."
      );
    }
    return { hash: legacyDigest(token), alg: "sha256" };
  }
  return { hash: createHmac("sha256", key).update(token).digest("hex"), alg: "hmac-sha256" };
}

/**
 * Every digest a presented token could match. Both are returned so an existing
 * database keeps working after ENC_KEY is introduced: rows still on the legacy
 * algorithm authenticate, and the caller upgrades them in place, because a
 * lookup is the one moment the plaintext is in hand.
 */
export function candidateDigests(token: string): { keyed: string | null; legacy: string } {
  const key = encKey();
  return {
    keyed: key ? createHmac("sha256", key).update(token).digest("hex") : null,
    legacy: legacyDigest(token)
  };
}

/** Constant-time compare of two hex digests of the same length. */
export function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
