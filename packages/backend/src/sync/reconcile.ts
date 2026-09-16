/**
 * Nightly reconcile: diff GitHub issues against the store.
 *
 * Webhooks are the primary inbound path, but they are not guaranteed. GitHub
 * gives up redelivering after enough failures, and a backend that was down for
 * the whole redelivery window never hears about the issue at all. The symptoms
 * are quiet and bad: a task nobody can see because issues.opened was missed, or
 * a lead holding a lease on work that was closed days ago.
 *
 * Planning is separated from applying so the diff rules are testable without
 * GitHub or a database: planReconcile() is pure.
 */
import { Cron } from "croner";
import { query, emit } from "../db.js";
import { makeApp, githubConfigured } from "../github/app.js";
import { priorityFromLabels } from "../github/issue.js";
import { syncDependencies } from "../github/deps.js";
import { pruneWebhookDeliveries } from "../webhooks/github.js";

export interface IssueSnapshot {
  repo: string;
  number: number;
  node_id: string;
  title: string;
  body: string;
  /** GitHub's view, which wins for open/closed. */
  state: "open" | "closed";
  /** Derived from the issue's labels; GitHub owns it. */
  priority: number;
}

export interface StoreTask {
  id: string;
  title: string;
  body: string | null;
  status: string;
  priority: number;
  github_repo: string;
  github_issue_number: number;
}

export type ReconcileAction =
  | { kind: "create"; issue: IssueSnapshot }
  | { kind: "update"; taskId: string; issue: IssueSnapshot }
  | { kind: "close"; taskId: string; issue: IssueSnapshot }
  | { kind: "reopen"; taskId: string; issue: IssueSnapshot }
  | { kind: "orphan"; taskId: string; repo: string; number: number };

const key = (repo: string, number: number) => `${repo}#${number}`;

/**
 * Work out what the store is missing.
 *
 * GitHub owns title, body and open/closed; the store owns status, claim and
 * lease (docs/ARCHITECTURE.md), so this only ever moves a task between done and
 * not-done, and never touches a claim except to drop one on a closed issue.
 *
 * `full` says whether `issues` is the complete set for these repos. On an
 * incremental pass an issue's absence just means it has not changed lately, so
 * orphans are only reported on a full scan.
 */
export function planReconcile(tasks: StoreTask[], issues: IssueSnapshot[], full = false): ReconcileAction[] {
  const byKey = new Map(tasks.map(t => [key(t.github_repo, t.github_issue_number), t]));
  const seen = new Set<string>();
  const actions: ReconcileAction[] = [];

  for (const issue of issues) {
    const k = key(issue.repo, issue.number);
    seen.add(k);
    const task = byKey.get(k);

    if (!task) {
      // issues.opened never landed.
      actions.push({ kind: "create", issue });
      continue;
    }
    if (issue.state === "closed" && task.status !== "done") {
      // issues.closed never landed; a lead may still be holding the lease.
      actions.push({ kind: "close", taskId: task.id, issue });
    } else if (issue.state === "open" && task.status === "done") {
      // issues.reopened never landed.
      actions.push({ kind: "reopen", taskId: task.id, issue });
    } else if (task.title !== issue.title || (task.body ?? "") !== issue.body
               || Number(task.priority) !== issue.priority) {
      // issues.edited or a label change never landed. Never reported alongside
      // a state change: close/reopen writes the text and priority too.
      actions.push({ kind: "update", taskId: task.id, issue });
    }
  }

  if (full) {
    for (const task of tasks) {
      const k = key(task.github_repo, task.github_issue_number);
      // Deleted, transferred, or moved to a repo this project no longer lists.
      if (!seen.has(k)) actions.push({ kind: "orphan", taskId: task.id, repo: task.github_repo, number: task.github_issue_number });
    }
  }
  return actions;
}

export interface ReconcileCounts {
  created: number; updated: number; closed: number; reopened: number; orphaned: number;
}

/** Apply a plan. Orphans are reported, never deleted: that is a human's call. */
export async function applyPlan(projectId: string, actions: ReconcileAction[]): Promise<ReconcileCounts> {
  const counts: ReconcileCounts = { created: 0, updated: 0, closed: 0, reopened: 0, orphaned: 0 };

  for (const action of actions) {
    switch (action.kind) {
      case "create": {
        const i = action.issue;
        const rows = await query<{ id: string }>(
          `INSERT INTO tasks (project_id, title, body, source, github_repo, github_issue_number, github_node_id, status, priority)
           VALUES ($1,$2,$3,'human',$4,$5,$6,$7::task_status,$8)
           ON CONFLICT (github_repo, github_issue_number) DO NOTHING
           RETURNING id`,
          [projectId, i.title, i.body, i.repo, i.number, i.node_id,
           i.state === "closed" ? "done" : "ready", i.priority]);
        if (!rows[0]) break;   // a webhook beat us to it between plan and apply
        await syncDependencies(projectId, rows[0].id, i.repo, i.body);
        counts.created++;
        await emit(projectId, "task.recovered", "reconcile",
          { task_id: rows[0].id, repo: i.repo, issue: i.number, title: i.title,
            note: "issue was missing from the store; the issues webhook was probably never delivered" });
        break;
      }
      case "update":
        await query("UPDATE tasks SET title=$2, body=$3, priority=$4 WHERE id=$1",
          [action.taskId, action.issue.title, action.issue.body, action.issue.priority]);
        // The body changed, so what it declares may have changed with it.
        await syncDependencies(projectId, action.taskId, action.issue.repo, action.issue.body);
        counts.updated++;
        break;
      case "close":
        // Same effect as the issues.closed webhook: done, and the lease goes.
        await query(
          `UPDATE tasks SET status='done', claimed_by=NULL, lease_until=NULL, title=$2, body=$3, priority=$4
           WHERE id=$1`, [action.taskId, action.issue.title, action.issue.body, action.issue.priority]);
        counts.closed++;
        await emit(projectId, "task.done", "reconcile",
          { task_id: action.taskId, repo: action.issue.repo, issue: action.issue.number,
            note: "issue is closed on GitHub; any claim on it has been released" });
        break;
      case "reopen":
        // Back into the pool, unclaimed. It is not in progress until someone claims it.
        await query(
          `UPDATE tasks SET status='ready', claimed_by=NULL, lease_until=NULL, title=$2, body=$3, priority=$4
           WHERE id=$1`, [action.taskId, action.issue.title, action.issue.body, action.issue.priority]);
        counts.reopened++;
        await emit(projectId, "task.released", "reconcile",
          { task_id: action.taskId, note: `issue ${action.issue.repo}#${action.issue.number} was reopened on GitHub` });
        break;
      case "orphan":
        counts.orphaned++;
        await emit(projectId, "task.orphaned", "reconcile",
          { task_id: action.taskId, repo: action.repo, issue: action.number,
            note: "no matching issue on GitHub; it may have been deleted, transferred, or moved out of this project's repos" });
        break;
    }
  }
  return counts;
}

type Paginating = {
  paginate: (route: string, params: Record<string, unknown>) => Promise<any[]>;
};

/** Issues touched since `since` (everything, on the first pass). PRs are issues on this endpoint; skip them. */
export async function fetchIssues(octokit: Paginating, repo: string, since: string | null): Promise<IssueSnapshot[]> {
  const [owner, name] = repo.split("/");
  const raw = await octokit.paginate("GET /repos/{owner}/{repo}/issues", {
    owner, repo: name, state: "all", per_page: 100, ...(since ? { since } : {})
  });
  return raw
    .filter((i: any) => !i.pull_request)
    .map((i: any): IssueSnapshot => ({
      repo, number: i.number, node_id: i.node_id,
      title: i.title, body: i.body ?? "",
      state: i.state === "closed" ? "closed" : "open",
      priority: priorityFromLabels(i.labels)
    }));
}

/**
 * Is a pass running right now? The scheduled run is guarded by croner's
 * `protect`, but the admin route is a button on a web page — two clicks would
 * otherwise interleave two full scans, doubling the API spend and racing on
 * `reconciled_at`.
 */
let running = false;
export const reconcileRunning = () => running;

/** Start a pass unless one is already going. Returns false if it was refused. */
export function startReconcile(opts: { full?: boolean } = {}): boolean {
  if (running) return false;
  running = true;
  reconcileOnce(opts)
    .catch(err => console.error("reconcile error", err))
    .finally(() => { running = false; });
  return true;
}

/**
 * One pass over every project. `full` forces a complete scan, which is the only
 * way orphans are noticed; the scheduled run is incremental after the first.
 */
/**
 * Nothing ever pruned `events`, so the table and everything in it grew without
 * bound. That matters beyond disk: event payloads carry finding text, and a
 * finding is the one place an agent can paste a credential by accident. Bounded
 * retention bounds that exposure too.
 *
 * Findings themselves are kept — they are the point of the tool. Only the log of
 * them ages out, and `muster_recent_events` is a catch-up path measured in
 * minutes, not months.
 */
export async function pruneEvents(): Promise<number> {
  const days = Number(process.env.EVENT_RETENTION_DAYS ?? 90);
  if (!Number.isFinite(days) || days <= 0) return 0;   // 0 disables it
  const rows = await query<{ id: string }>(
    "DELETE FROM events WHERE created_at < now() - make_interval(days => $1) RETURNING id", [days]);
  if (rows.length) console.log(`reconcile: pruned ${rows.length} events older than ${days} days`);
  return rows.length;
}

export async function reconcileOnce(opts: { full?: boolean } = {}) {
  await pruneEvents().catch(err => console.error("reconcile: prune failed", err?.message ?? err));
  await pruneWebhookDeliveries().catch(err => console.error("reconcile: webhook prune failed", err?.message ?? err));

  const projects = await query<{ id: string; slug: string; github_repos: string[]; reconciled_at: string | null }>(
    "SELECT id, slug, github_repos, reconciled_at FROM projects WHERE cardinality(github_repos) > 0");
  if (!projects.length) return;

  const app = makeApp();
  for (const project of projects) {
    // A full scan on the first pass, since there is no watermark to trust yet.
    const full = opts.full || !project.reconciled_at;
    // Overlap the window by an hour: GitHub's `since` is on updated_at, and an
    // issue edited during the previous pass could otherwise fall between runs.
    const since = full ? null
      : new Date(new Date(project.reconciled_at!).getTime() - 60 * 60 * 1000).toISOString();
    const startedAt = new Date().toISOString();

    try {
      const issues: IssueSnapshot[] = [];
      for (const repo of project.github_repos) {
        const [owner, name] = repo.split("/");
        const { data: inst } = await app.octokit.request(
          "GET /repos/{owner}/{repo}/installation", { owner, repo: name });
        const octokit = await app.getInstallationOctokit(inst.id);
        issues.push(...await fetchIssues(octokit as unknown as Paginating, repo, since));
      }

      const tasks = await query<StoreTask>(
        `SELECT id, title, body, status::text AS status, priority, github_repo, github_issue_number
         FROM tasks WHERE project_id = $1 AND github_issue_number IS NOT NULL`, [project.id]);

      const counts = await applyPlan(project.id, planReconcile(tasks, issues, full));
      await query("UPDATE projects SET reconciled_at = $2 WHERE id = $1", [project.id, startedAt]);

      const changed = counts.created + counts.updated + counts.closed + counts.reopened + counts.orphaned;
      if (changed) {
        console.log(`reconcile: ${project.slug}`, counts);
        await emit(project.id, "reconcile.completed", "reconcile", { ...counts, full, issues: issues.length });
      }
    } catch (err: any) {
      // Leave reconciled_at alone so the next run covers this window again.
      console.error(`reconcile: ${project.slug} failed:`, err?.message ?? err);
    }
  }
}

export function startReconcileLoop() {
  if (process.env.GITHUB_RECONCILE_ENABLED !== "true") return;
  if (!githubConfigured()) {
    console.error("reconcile: GITHUB_RECONCILE_ENABLED is true but the GitHub App is not configured; reconcile disabled");
    return;
  }
  const expression = process.env.GITHUB_RECONCILE_CRON ?? "17 3 * * *";
  // Off-the-hour by default: every cron in the world fires at :00.
  // protect: true skips a firing while the previous one is still running, so a
  // slow full scan cannot stack up behind itself.
  new Cron(expression, { timezone: "UTC", protect: true }, () => {
    // Shares the lock with the admin route, so a scheduled pass and a button
    // press cannot overlap either.
    if (!startReconcile()) console.error("reconcile: skipped, a pass is already running");
  });
  console.log(`reconcile scheduled: ${expression} UTC`);
}
