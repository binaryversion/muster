/**
 * Backoffice API. Protected by ADMIN_TOKEN. Put a tiny UI (or curl) in front.
 *   POST   /admin/projects             {slug,name,github_owner?,github_repos[],github_project_number?}
 *   GET    /admin/projects
 *   POST   /admin/projects/:id/leads   {name, expires_in_days?}  -> plaintext token, shown ONCE
 *   GET    /admin/projects/:id/leads
 *   DELETE /admin/leads/:id            revoke
 *   GET    /admin/projects/:id/board   tasks with claim/lease/cost state
 *   GET    /admin/projects/:id/events?since=0
 */
import { Router } from "express";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { query } from "../db.js";

export const adminRouter = Router();

adminRouter.use("/admin", (req, res, next) => {
  const t = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN) return res.status(401).end();
  next();
});

const ProjectIn = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  github_owner: z.string().optional(),
  github_repos: z.array(z.string()).default([]),
  github_project_number: z.number().int().optional()
});

adminRouter.post("/admin/projects", async (req, res) => {
  const p = ProjectIn.parse(req.body);
  const rows = await query(
    `INSERT INTO projects (slug,name,github_owner,github_repos,github_project_number)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [p.slug, p.name, p.github_owner ?? null, p.github_repos, p.github_project_number ?? null]);
  res.status(201).json(rows[0]);
});

adminRouter.get("/admin/projects", async (_req, res) =>
  res.json(await query("SELECT * FROM projects ORDER BY created_at")));

adminRouter.post("/admin/projects/:id/leads", async (req, res) => {
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
});

adminRouter.get("/admin/projects/:id/leads", async (req, res) =>
  res.json(await query(
    "SELECT id,name,expires_at,revoked_at,last_seen_at,created_at FROM leads WHERE project_id=$1 ORDER BY name",
    [req.params.id])));

adminRouter.delete("/admin/leads/:id", async (req, res) => {
  await query("UPDATE leads SET revoked_at = now() WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

adminRouter.get("/admin/projects/:id/board", async (req, res) =>
  res.json(await query(
    `SELECT t.id,t.title,t.status,t.priority,t.source,t.lease_until,t.cost_tokens,
            t.github_repo,t.github_issue_number,l.name AS claimed_by
     FROM tasks t LEFT JOIN leads l ON l.id=t.claimed_by
     WHERE t.project_id=$1 ORDER BY t.status,t.priority,t.created_at`, [req.params.id])));

adminRouter.get("/admin/projects/:id/events", async (req, res) =>
  res.json(await query(
    "SELECT * FROM events WHERE project_id=$1 AND id > $2 ORDER BY id LIMIT 200",
    [req.params.id, Number(req.query.since ?? 0)])));
