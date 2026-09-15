/**
 * Redacting credentials an agent pasted into a finding.
 *
 * The realistic path is not an adversary, it is an accident: an agent debugging
 * an auth failure records the request that finally worked, token included. That
 * finding is then pushed into every other lead's session by the channel and
 * sits in the event log indefinitely.
 *
 * So this catches shapes, not secrets in general. It will miss a password that
 * looks like a word, and that is fine — the tool description tells the agent
 * not to paste credentials, and this is the backstop for when it does anyway.
 * Encrypting the column instead would take full-text search with it, and a
 * finding nobody can search for is a finding nobody reads.
 */

export const REDACTED = "[redacted]";

interface Pattern { name: string; re: RegExp }

/**
 * Ordered most specific first. Each must be anchored on something structural —
 * a known prefix, a PEM header, a URL's credential slot — because a rule broad
 * enough to catch "any long random-looking string" would eat commit SHAs, base64
 * test fixtures and stack traces, and a finding mangled into uselessness is
 * worse than one with a token in it.
 */
const PATTERNS: Pattern[] = [
  { name: "muster lead token", re: /\bmstr_[A-Za-z0-9_-]{16,}/g },
  { name: "github token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: "slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "aws access key id", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "openai key", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: "google api key", re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // Credentials in a URL: postgres://user:secret@host, https://x:token@host.
  { name: "url password", re: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+):[^\s/@]+@/g },
  // Authorization headers, however they were quoted.
  { name: "authorization header", re: /\b(authorization\s*[:=]\s*["']?\s*(?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi },
  // key=value / "key": "value" for names that only ever hold a secret.
  // No \b: the interesting case is ADMIN_PASSWORD, and "_" is a word character,
  // so a boundary never appears between the prefix and the keyword.
  { name: "secret assignment", re: /((?:api[_-]?key|secret|password|passwd|token|access[_-]?token|enc[_-]?key)["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi }
];

export interface RedactResult {
  text: string;
  /** Which patterns fired, for telling the agent what happened. */
  kinds: string[];
}

export function redactSecrets(input: string): RedactResult {
  let text = input;
  const kinds: string[] = [];

  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    kinds.push(name);
    // Patterns with a capture group keep the part that names the secret, so the
    // finding still reads as a sentence rather than losing its context.
    text = text.replace(re, (...args: unknown[]) => {
      // args is [match, ...captures, offset, wholeString]; no named groups are
      // used, so the captures are everything between.
      const captured = args.slice(1, -2).filter((g): g is string => typeof g === "string");
      if (name === "url password") return `${captured[0]}:${REDACTED}@`;
      if (captured.length) return `${captured[0]}${REDACTED}`;
      return REDACTED;
    });
  }
  return { text, kinds };
}
