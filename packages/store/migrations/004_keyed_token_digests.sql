-- Key the lead token digests.
--
-- token_hash was a bare SHA-256 of the token. Tokens are 24 random bytes so
-- that was not brute-forceable, but it meant a stolen database was enough to
-- test a guess offline. Digests are now HMAC-SHA256 under ENC_KEY, so the
-- database on its own tells an attacker nothing.
--
-- Existing rows are left alone rather than invalidated: they keep their
-- 'sha256' algorithm and still authenticate, and each is upgraded in place the
-- next time its token is presented, which is the one moment the plaintext is
-- available to re-digest.
ALTER TABLE leads ADD COLUMN token_alg text NOT NULL DEFAULT 'sha256';

COMMENT ON COLUMN leads.token_hash IS
  'Digest of the bearer token. Never the token itself, in any recoverable form.';
COMMENT ON COLUMN leads.token_alg IS
  'How token_hash was computed: hmac-sha256 (keyed by ENC_KEY) or sha256 (legacy, upgraded on next use).';
