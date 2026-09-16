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

/**
 * How long a delivery may sit claimed before another attempt may take it. Only
 * reached after a crash: nothing else holds a claim without finishing it.
 */
const CLAIM_TIMEOUT_SEC = Number(process.env.WEBHOOK_CLAIM_TIMEOUT_SEC ?? 120);

/**
 * How late a replayed delivery may be. A restart seconds after a crash should
 * finish the work; resurrecting a three-hour-old "PR merged, rebase now" into a
 * live session is worse than never sending it.
 */
const REPLAY_WINDOW_MIN = Number(process.env.WEBHOOK_REPLAY_WINDOW_MIN ?? 30);

/**
 * Take a delivery, or report that someone already has.
 *
 * One statement, so two requests for the same id cannot both win it. A brand
 * new id inserts; an id whose previous attempt never finished and whose claim
 * has gone stale is taken back; anything already processed returns nothing.
 */
async function claimDelivery(id: string, event: string, raw: string): Promise<boolean> {
  const rows = await query(
    `INSERT INTO webhook_deliveries (delivery_id, event, payload, claimed_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (delivery_id) DO UPDATE
       SET event = EXCLUDED.event, payload = EXCLUDED.payload, claimed_at = now()
       WHERE webhook_deliveries.processed_at IS NULL
         AND (webhook_deliveries.claimed_at IS NULL
              OR webhook_deliveries.claimed_at < now() - make_interval(secs => $4))
     RETURNING delivery_id`,
    [id, event, raw, CLAIM_TIMEOUT_SEC]);
  return rows.length > 0;
}

/** Done with it. The body is dropped: it was only kept in case of a replay. */
async function completeDelivery(id: string): Promise<void> {
  await query(
    "UPDATE webhook_deliveries SET processed_at = now(), payload = NULL WHERE delivery_id = $1", [id]);
}

async function handle(id: string, event: string, raw: string): Promise<void> {
  await webhooks.receive({ id, name: event as any, payload: JSON.parse(raw) });
  await completeDelivery(id);
}

/**
 * Finish what a previous process started.
 *
 * Anything still unprocessed at startup was orphaned — on a single server there
 * is nobody else who could be holding it. Recent ones are replayed; older ones
 * are reported and dropped, because a stale coordination event is not worth
 * pushing into a session that has long since moved on.
 *
 * An abandoned delivery is recognisable afterwards: processed_at null with the
 * payload cleared. That also stops it being reconsidered on every boot.
 */
export async function replayUnfinishedDeliveries(): Promise<{ replayed: number; abandoned: number }> {
  const rows = await query<{ delivery_id: string; event: string | null; payload: string | null; age_min: number }>(
    `SELECT delivery_id, event, payload,
            ceil(extract(epoch FROM now() - received_at) / 60)::int AS age_min
     FROM webhook_deliveries
     WHERE processed_at IS NULL AND payload IS NOT NULL
     ORDER BY received_at`);
  if (!rows.length) return { replayed: 0, abandoned: 0 };

  let replayed = 0, abandoned = 0;
  for (const row of rows) {
    if (!row.event || !row.payload) continue;
    if (row.age_min > REPLAY_WINDOW_MIN) {
      console.error(
        `webhooks: abandoning ${row.event} delivery ${row.delivery_id}, ` +
        `${row.age_min}m old and never processed. Redeliver it from GitHub if it still matters.`);
      await query("UPDATE webhook_deliveries SET payload = NULL WHERE delivery_id = $1", [row.delivery_id]);
      abandoned++;
      continue;
    }
    try {
      console.log(`webhooks: replaying ${row.event} delivery ${row.delivery_id} (${row.age_min}m old)`);
      await handle(row.delivery_id, row.event, row.payload);
      replayed++;
    } catch (err: any) {
      console.error(`webhooks: replay of ${row.delivery_id} failed:`, err?.message ?? err);
    }
  }
  if (replayed || abandoned) {
    console.log(`webhooks: recovered ${replayed} delivery/deliveries, abandoned ${abandoned}`);
  }
  return { replayed, abandoned };
}

/** Bounded, or the table grows for ever. Only ids and timestamps are kept. */
export async function pruneWebhookDeliveries(): Promise<number> {
  const days = Number(process.env.WEBHOOK_RETENTION_DAYS ?? 30);
  if (!Number.isFinite(days) || days <= 0) return 0;
  const rows = await query<{ delivery_id: string }>(
    `DELETE FROM webhook_deliveries
     WHERE received_at < now() - make_interval(days => $1) AND processed_at IS NOT NULL
     RETURNING delivery_id`, [days]);
  if (rows.length) console.log(`webhooks: pruned ${rows.length} delivery records older than ${days} days`);
  return rows.length;
}

export const githubWebhookRouter = Router();
githubWebhookRouter.post("/webhooks/github", async (req, res) => {
  const id = req.header("x-github-delivery") ?? "";
  const sig = req.header("x-hub-signature-256") ?? "";
  const name = req.header("x-github-event") ?? "";
  const raw = (req as any).rawBody as string;
  if (!(await webhooks.verify(raw, sig))) return res.status(401).send("bad signature");

  // The payload is stored with the claim, so a process that dies mid-handler
  // leaves something to finish rather than a tombstone that refuses the retry.
  if (!(await claimDelivery(id, name, raw))) return res.status(200).send("duplicate");

  res.status(202).send("accepted"); // ack fast, process after
  handle(id, name, raw)
    .catch(err => console.error("webhook error", id, err));
});
