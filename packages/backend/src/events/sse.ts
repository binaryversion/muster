/**
 * Event stream for channel plugins and the backoffice UI.
 * GET /events/stream?since=<id|latest>   Authorization: Bearer <lead token>
 * Scoped to the lead's project. Server-Sent Events, polling the events table.
 */
import { Router } from "express";
import { createHash } from "node:crypto";
import { query } from "../db.js";

export const eventsRouter = Router();

const POLL_MS = 2000;
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
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const hash = createHash("sha256").update(token).digest("hex");
  const lead = (await query<{ project_id: string }>(
    `SELECT project_id FROM leads
     WHERE token_hash = $1 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())`, [hash]))[0];
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
  const poll = setInterval(() => tick().catch(err => console.error("sse poll error", err)), POLL_MS);
  // Comment frames keep idle proxies from tearing the connection down.
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
  const stop = () => { clearInterval(poll); clearInterval(keepalive); };
  req.on("close", stop);
  res.on("close", stop);
});
