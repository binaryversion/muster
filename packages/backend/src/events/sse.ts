/**
 * Event stream for channel plugins and the backoffice UI.
 * GET /events/stream?since=<id|latest>   Authorization: Bearer <lead token>
 * Scoped to the lead's project. Server-Sent Events, polling the events table.
 */
import { Router } from "express";
import { query } from "../db.js";
import { candidateDigests } from "../crypto.js";
import { subscribe, FALLBACK_POLL_MS } from "./bus.js";

export const eventsRouter = Router();

const KEEPALIVE_MS = 25_000;

async function resolveSince(projectId: string, req: { header(n: string): string | undefined; query: any }) {
  // A reconnecting EventSource sends back the last id it saw. Honouring it
  // means a dropped stream resumes exactly where it left off, rather than
  // replaying from the ?since= in the original URL.
  const lastEventId = req.header("last-event-id");
  if (lastEventId && /^\d+$/.test(lastEventId)) return Number(lastEventId);

  const since = String(req.query.since ?? "0");
  if (since === "latest") {
    // Start at the current end of the log: a session opening now should not be
    // handed every event since the project began.
    const rows = await query<{ max: string | null }>(
      "SELECT max(id)::text AS max FROM events WHERE project_id = $1", [projectId]);
    return Number(rows[0]?.max ?? 0);
  }
  return /^\d+$/.test(since) ? Number(since) : 0;
}

eventsRouter.get("/events/stream", async (req, res) => {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const { keyed, legacy } = candidateDigests(token);
  const lead = (await query<{ project_id: string }>(
    `SELECT project_id FROM leads
     WHERE ((token_hash = $1 AND token_alg = 'hmac-sha256') OR (token_hash = $2 AND token_alg = 'sha256'))
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())`, [keyed ?? "", legacy]))[0];
  if (!lead) return res.status(401).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"   // nginx buffers text/event-stream by default
  });

  let since = await resolveSince(lead.project_id, req);
  let sending = false;

  const tick = async () => {
    // A slow write must not overlap the next poll, or the same rows go twice.
    if (sending) return;
    sending = true;
    try {
      const rows = await query<any>(
        "SELECT * FROM events WHERE project_id=$1 AND id > $2 ORDER BY id LIMIT 100",
        [lead.project_id, since]);
      for (const e of rows) {
        since = e.id;
        res.write(`id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
      }
    } finally {
      sending = false;
    }
  };

  await tick();

  // Pushed: one LISTEN connection for the process wakes this stream when an
  // event lands for its project.
  const unsubscribe = subscribe(lead.project_id,
    () => { tick().catch(err => console.error("sse push error", err)); });

  // And still polled, slowly. A notification can be missed — the LISTEN
  // connection can drop, and pg_notify is not delivered to a client that is not
  // connected at that moment — so this is the floor that guarantees delivery
  // rather than the mechanism that provides it.
  const poll = setInterval(() => tick().catch(err => console.error("sse poll error", err)), FALLBACK_POLL_MS);
  // Comment frames keep idle proxies from tearing the connection down.
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
  const stop = () => { unsubscribe(); clearInterval(poll); clearInterval(keepalive); };
  req.on("close", stop);
  res.on("close", stop);
});
