/**
 * Backoffice API. Protected by ADMIN_TOKEN. Put a tiny UI (or curl) in front.
 *   POST   /admin/projects             {slug,name,github_owner?,github_repos[],github_project_number?}
 *   GET    /admin/projects
 *   PATCH  /admin/projects/:id         edit repos / board wiring / status map
 *   POST   /admin/projects/:id/leads   {name, expires_in_days?}  -> plaintext token, shown ONCE
 *   GET    /admin/projects/:id/leads
 *   DELETE /admin/leads/:id            revoke
 *   GET    /admin/projects/:id/board   tasks with claim/lease/cost state
 *   GET    /admin/projects/:id/events?since=0
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { query } from "../db.js";

export const adminRouter = Router();

adminRouter.use("/admin", (req, res, next) => {
  const t = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN) return res.status(401).end();
  next();
});

/**
 * Express 4 does not catch a rejected promise from an async handler, so an
 * invalid body used to hang the request instead of answering 400.
 */
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

const ProjectIn = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  github_owner: z.string().optional(),
  github_repos: z.array(z.string()).default([]),
  github_project_number: z.number().int().optional()
});

adminRouter.post("/admin/projects", wrap(async (req, res) => {
  const p = ProjectIn.parse(req.body);
  const rows = await query(
    `INSERT INTO projects (slug,name,github_owner,github_repos,github_project_number)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [p.slug, p.name, p.github_owner ?? null, p.github_repos, p.github_project_number ?? null]);
  res.status(201).json(rows[0]);
}));

adminRouter.get("/admin/projects", wrap(async (_req, res) =>
  res.json(await query("SELECT * FROM projects ORDER BY created_at"))));

const ProjectPatch = z.object({
  name: z.string().optional(),
  github_owner: z.string().nullable().optional(),
  github_repos: z.array(z.string()).optional(),
  github_project_number: z.number().int().nullable().optional(),
  // muster task_status -> the board's Status option name, for boards whose
  // columns the built-in aliases do not match. See sync/projects.ts.
  github_status_map: z.record(z.string(), z.string()).nullable().optional()
}).strict();

adminRouter.patch("/admin/projects/:id", wrap(async (req, res) => {
  const patch = ProjectPatch.parse(req.body);
  const sets: string[] = [];
  const values: unknown[] = [req.params.id];
  for (const [column, value] of Object.entries(patch)) {
    values.push(column === "github_status_map" && value !== null ? JSON.stringify(value) : value);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: "nothing to update" });

  // Pointing at a different board invalidates the cached field and option ids;
  // dropping them makes the next sync re-resolve instead of writing to the old
  // board's field.
  if ("github_project_number" in patch) {
    sets.push("github_project_id = NULL", "github_status_field_id = NULL",
              "github_status_options = '{}'::jsonb", "github_fields_synced_at = NULL");
  }
  const rows = await query(`UPDATE projects SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, values);
  if (!rows[0]) return res.status(404).json({ error: "no such project" });
  res.json(rows[0]);
}));

adminRouter.post("/admin/projects/:id/leads", wrap(async (req, res) => {
  const { name, expires_in_days } = z.object({
    name: z.string().min(1).max(64),
    expires_in_days: z.number().int().positive().optional()
  }).parse(req.body);
  const token = "mstr_" + randomBytes(24).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const rows = await query(
    `INSERT INTO leads (project_id, name, token_hash, expires_at)
     VALUES ($1,$2,$3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(days => $4) END)
     RETURNING id, name, expires_at`,
    [req.params.id, name, hash, expires_in_days ?? null]);
  // Only the hash is stored; the plaintext token is returned exactly once.
  res.status(201).json({ ...rows[0], token });
}));

adminRouter.get("/admin/projects/:id/leads", wrap(async (req, res) =>
  res.json(await query(
    "SELECT id,name,expires_at,revoked_at,last_seen_at,created_at FROM leads WHERE project_id=$1 ORDER BY name",
    [req.params.id]))));

adminRouter.delete("/admin/leads/:id", wrap(async (req, res) => {
  await query("UPDATE leads SET revoked_at = now() WHERE id = $1", [req.params.id]);
  res.status(204).end();
}));

adminRouter.get("/admin/projects/:id/board", wrap(async (req, res) =>
  res.json(await query(
    `SELECT t.id,t.title,t.status,t.priority,t.source,t.lease_until,t.cost_tokens,
            t.github_repo,t.github_issue_number,t.updated_at,t.mirrored_at,l.name AS claimed_by
     FROM tasks t LEFT JOIN leads l ON l.id=t.claimed_by
     WHERE t.project_id=$1 ORDER BY t.status,t.priority,t.created_at`, [req.params.id]))));

// Ascending, so ?since=<highest id seen> pages forward through the log rather
// than handing back the newest 200 every time. The UI reverses for display.
adminRouter.get("/admin/projects/:id/events", wrap(async (req, res) =>
  res.json(await query(
    "SELECT * FROM events WHERE project_id=$1 AND id > $2 ORDER BY id LIMIT 200",
    [req.params.id, Number(req.query.since ?? 0)]))));

// Turn a bad body into 400 rather than a 500 with a stack trace.
adminRouter.use("/admin", (err: any, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  if (err instanceof z.ZodError) return res.status(400).json({ error: "invalid body", issues: err.issues });
  if (err?.code === "23505") return res.status(409).json({ error: "already exists" });
  if (err?.code === "22P02") return res.status(400).json({ error: "malformed id" });
  console.error("admin error", err);
  res.status(500).json({ error: "internal error" });
});
