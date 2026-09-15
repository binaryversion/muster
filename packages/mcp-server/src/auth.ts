import { query } from "./db.js";
import { candidateDigests } from "./crypto.js";

export interface Lead { id: string; name: string; project_id: string }

/**
 * Resolve a per-lead bearer token to a Lead. Tokens are issued by the
 * backoffice and stored only as a keyed digest (see crypto.ts).
 */
export async function authenticate(authHeader?: string): Promise<Lead | null> {
  const token = authHeader?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const { keyed, legacy } = candidateDigests(token);
  const rows = await query<Lead & { token_alg: string }>(
    `UPDATE leads SET last_seen_at = now()
     WHERE ((token_hash = $1 AND token_alg = 'hmac-sha256') OR (token_hash = $2 AND token_alg = 'sha256'))
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
     RETURNING id, name, project_id, token_alg`,
    [keyed ?? "", legacy]
  );
  const lead = rows[0];
  if (!lead) return null;

  // A successful lookup is the only moment the plaintext is in hand, so it is
  // the only chance to re-digest a row left on the legacy algorithm.
  if (lead.token_alg === "sha256" && keyed) {
    await query("UPDATE leads SET token_hash = $2, token_alg = 'hmac-sha256' WHERE id = $1",
      [lead.id, keyed]);
  }
  return { id: lead.id, name: lead.name, project_id: lead.project_id };
}
