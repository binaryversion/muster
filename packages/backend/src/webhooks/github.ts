/**
 * GitHub -> store. One webhook endpoint for the single GitHub App.
 * Verifies the signature, dedupes on X-GitHub-Delivery, then upserts tasks
 * (from issues) and emits coordination events (pr.merged, ci.failed, ...).
 */
import { Router } from "express";
import { Webhooks } from "@octokit/webhooks";
import { query, emit } from "../db.js";
import { priorityFromLabels } from "../github/issue.js";
import { syncDependencies } from "../github/deps.js";

const webhooks = new Webhooks({ secret: process.env.GITHUB_WEBHOOK_SECRET ?? "unset" });

async function projectForRepo(fullName: string) {
  const rows = await query<{ id: string }>(
    "SELECT id FROM projects WHERE $1 = ANY(github_repos) LIMIT 1", [fullName]);
  return rows[0]?.id;
}

// `issues.labeled`/`unlabeled` carry the full label set too, and they are how a
// human changes priority without touching the issue body.
webhooks.on(["issues.opened", "issues.edited", "issues.reopened", "issues.labeled", "issues.unlabeled"],
  async ({ payload }) => {
    const repo = payload.repository.full_name;
    const pid = await projectForRepo(repo); if (!pid) return;
    const i = payload.issue;
    const rows = await query<{ id: string }>(
      `INSERT INTO tasks (project_id, title, body, priority, source, github_repo, github_issue_number, github_node_id, status)
       VALUES ($1,$2,$3,$4,'human',$5,$6,$7,'ready')
       ON CONFLICT (github_repo, github_issue_number) DO UPDATE
         SET title = EXCLUDED.title, body = EXCLUDED.body,   -- GitHub wins on human fields
             priority = EXCLUDED.priority,
             status = CASE WHEN tasks.status = 'cancelled' THEN 'ready'::task_status ELSE tasks.status END
       RETURNING id`,
      [pid, i.title, i.body ?? "", priorityFromLabels(i.labels as any), repo, i.number, i.node_id]);
    if (rows[0]) await syncDependencies(pid, rows[0].id, repo, i.body);
  });

webhooks.on("issues.closed", async ({ payload }) => {
  const repo = payload.repository.full_name;
  const pid = await projectForRepo(repo); if (!pid) return;
  await query(
    `UPDATE tasks SET status = 'done', claimed_by = NULL, lease_until = NULL
     WHERE github_repo = $1 AND github_issue_number = $2`, [repo, payload.issue.number]);
  await emit(pid, "task.done", "github", { repo, issue: payload.issue.number });
});

webhooks.on("pull_request.closed", async ({ payload }) => {
  if (!payload.pull_request.merged) return;
  const repo = payload.repository.full_name;
  const pid = await projectForRepo(repo); if (!pid) return;
  await emit(pid, "pr.merged", "github", {
    repo, number: payload.pull_request.number, base: payload.pull_request.base.ref,
    sha: payload.pull_request.merge_commit_sha, title: payload.pull_request.title,
    hint: `Rebase your branch onto ${payload.pull_request.base.ref} before opening or updating a PR.`
  });
});

webhooks.on("check_suite.completed", async ({ payload }) => {
  if (payload.check_suite.conclusion === "success") return;
  const repo = payload.repository.full_name;
  const pid = await projectForRepo(repo); if (!pid) return;
  await emit(pid, "ci.failed", "github", {
    repo, branch: payload.check_suite.head_branch, sha: payload.check_suite.head_sha,
    conclusion: payload.check_suite.conclusion
  });
});

// Projects v2 item edited by a human (e.g. moved between columns). The field
// value needs a GraphQL lookup; we record the event and let reconcile pull it.
// The item id itself is right here though, and it is what status write-back
// needs, so cache it rather than paying for a lookup later.
webhooks.on(["projects_v2_item.edited", "projects_v2_item.created"] as any, async ({ payload }: any) => {
  const contentId = payload.projects_v2_item?.content_node_id;
  const itemId = payload.projects_v2_item?.node_id;
  if (!contentId) return;
  const rows = await query<{ project_id: string; id: string }>(
    `UPDATE tasks SET github_item_id = COALESCE($2, github_item_id)
     WHERE github_node_id = $1 RETURNING project_id, id`, [contentId, itemId ?? null]);
  if (rows[0]) await emit(rows[0].project_id, "github.item.edited", "github",
    { task_id: rows[0].id, item_id: itemId });
});

export const githubWebhookRouter = Router();
githubWebhookRouter.post("/webhooks/github", async (req, res) => {
  const id = req.header("x-github-delivery") ?? "";
  const sig = req.header("x-hub-signature-256") ?? "";
  const name = req.header("x-github-event") ?? "";
  const raw = (req as any).rawBody as string;
  if (!(await webhooks.verify(raw, sig))) return res.status(401).send("bad signature");

  // Idempotency: GitHub may redeliver the same delivery id.
  const inserted = await query(
    "INSERT INTO webhook_deliveries (delivery_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING delivery_id", [id]);
  if (!inserted[0]) return res.status(200).send("duplicate");

  res.status(202).send("accepted"); // ack fast, process after
  webhooks.receive({ id, name: name as any, payload: JSON.parse(raw) })
    .catch(err => console.error("webhook error", id, err));
});
