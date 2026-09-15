/**
 * Event stream for channel plugins and the backoffice UI.
 * GET /events/stream?since=<id>   Authorization: Bearer <lead token>
 * Scoped to the lead's project. Server-Sent Events, polling the events table.
 */
import { Router } from "express";
import { createHash } from "node:crypto";
import { query } from "../db.js";

export const eventsRouter = Router();

eventsRouter.get("/events/stream", async (req, res) => {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const hash = createHash("sha256").update(token).digest("hex");
  const lead = (await query<{ project_id: string }>(
    "SELECT project_id FROM leads WHERE token_hash=$1 AND revoked_at IS NULL", [hash]))[0];
  if (!lead) return res.status(401).end();

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  let since = Number(req.query.since ?? 0);
  const tick = async () => {
    const rows = await query<any>(
      "SELECT * FROM events WHERE project_id=$1 AND id > $2 ORDER BY id LIMIT 100", [lead.project_id, since]);
    for (const e of rows) {
      since = e.id;
      res.write(`id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
    }
  };
  await tick();
  const timer = setInterval(() => tick().catch(() => {}), 2000);
  req.on("close", () => clearInterval(timer));
});
