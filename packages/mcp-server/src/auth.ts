import { createHash } from "node:crypto";
import { query } from "./db.js";

export interface Lead { id: string; name: string; project_id: string }

/** Resolve a per-lead bearer token to a Lead. Tokens are issued by the backoffice. */
export async function authenticate(authHeader?: string): Promise<Lead | null> {
  const token = authHeader?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const hash = createHash("sha256").update(token).digest("hex");
  const rows = await query<Lead>(
    `UPDATE leads SET last_seen_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
     RETURNING id, name, project_id`,
    [hash]
  );
  return rows[0] ?? null;
}
