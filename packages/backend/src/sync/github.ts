/**
 * Store -> GitHub mirror, debounced. Pushes agent-owned state (status, claimer)
 * back so humans see it on the board, and keeps API usage to a handful of calls
 * per interval by batching.
 *
 * Two mirrors, either of which can be off:
 *   - labels on the issue (muster:in-progress, lead:alice-laptop), which work
 *     with any board grouped by label. GITHUB_SYNC_LABELS=false to skip.
 *   - the Projects v2 "Status" single-select, for projects that have
 *     github_project_number set. See sync/projects.ts.
 *
 * A task is mirrored when its mirrored_at is behind its updated_at, and
 * mirrored_at is then set to the updated_at we read rather than to now(), so a
 * change made while the cycle was running is picked up next time instead of
 * being lost.
 */
import { query } from "../db.js";
import { makeApp, githubConfigured, circuitOpen, noteGithubFailure, noteGithubSuccess } from "../github/app.js";
import { ensureBoardMetadata, optionIdFor, pushStatuses, resolveItemIds,
         type ProjectRow, type StatusUpdate } from "./projects.js";

const STATUS_LABELS: Record<string, string> = {
  ready: "todo", in_progress: "in-progress", review: "in-review", done: "done"
};
const BATCH = Number(process.env.GITHUB_SYNC_BATCH ?? 200);

interface DirtyTask {
  id: string;
  project_id: string;
  status: string;
  updated_at: string;
  claimer: string | null;
  github_repo: string;
  github_issue_number: number;
  github_node_id: string | null;
  github_item_id: string | null;
}

/** One installation octokit per repo, reused across the cycle. */
function installationCache(app: ReturnType<typeof makeApp>) {
  const cache = new Map<string, Promise<any>>();
  return (fullName: string) => {
    let octokit = cache.get(fullName);
    if (!octokit) {
      const [owner, repo] = fullName.split("/");
      octokit = app.octokit
        .request("GET /repos/{owner}/{repo}/installation", { owner, repo })
        .then(({ data }) => app.getInstallationOctokit(data.id));
      cache.set(fullName, octokit);
    }
    return octokit;
  };
}

async function mirrorLabels(octokit: any, task: DirtyTask) {
  const [owner, repo] = task.github_repo.split("/");
  const labels = [`muster:${STATUS_LABELS[task.status] ?? task.status}`];
  if (task.claimer) labels.push(`lead:${task.claimer}`);
  // Replace only muster-managed labels; keep the human ones.
  const { data: current } = await octokit.request(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/labels",
    { owner, repo, issue_number: task.github_issue_number });
  const keep = current
    .map((l: any) => l.name)
    .filter((n: string) => !n.startsWith("muster:") && !n.startsWith("lead:"));
  await octokit.request("PUT /repos/{owner}/{repo}/issues/{issue_number}/labels",
    { owner, repo, issue_number: task.github_issue_number, labels: [...keep, ...labels] });
}

/**
 * Status write-back for one project: make sure the board ids are cached, fill
 * in any missing item ids, then push every status we can map in one batch.
 * Returns the task ids whose Status was written.
 */
async function mirrorProjectStatus(octokit: any, project: ProjectRow, tasks: DirtyTask[]): Promise<string[]> {
  const board = await ensureBoardMetadata(octokit, project);
  if (!board) return [];

  const unresolved = tasks.filter(t => !t.github_item_id && t.github_node_id);
  if (unresolved.length) {
    const items = await resolveItemIds(octokit, board.github_project_id!,
      unresolved.map(t => t.github_node_id!));
    for (const t of unresolved) {
      const itemId = items.get(t.github_node_id!);
      if (!itemId) continue;
      t.github_item_id = itemId;
      // Cached so later cycles skip the lookup; the updated_at trigger ignores
      // this column, so it does not re-dirty the task.
      await query("UPDATE tasks SET github_item_id=$2 WHERE id=$1", [t.id, itemId]);
    }
  }

  const updates: StatusUpdate[] = [];
  for (const t of tasks) {
    if (!t.github_item_id) continue;   // not on the board; humans own what is
    const optionId = optionIdFor(board, t.status);
    if (!optionId) {
      console.error(`sync: no "Status" option matches ${t.status} on project ${board.id}; ` +
                    `set github_status_map to map it explicitly`);
      continue;
    }
    updates.push({ taskId: t.id, itemId: t.github_item_id, optionId });
  }
  return pushStatuses(octokit, board, updates);
}

export async function syncOnce() {
  const dirty = await query<DirtyTask>(
    `SELECT t.id, t.project_id, t.status::text AS status, t.updated_at,
            t.github_repo, t.github_issue_number, t.github_node_id, t.github_item_id,
            l.name AS claimer
     FROM tasks t LEFT JOIN leads l ON l.id = t.claimed_by
     WHERE t.github_issue_number IS NOT NULL
       AND (t.mirrored_at IS NULL OR t.mirrored_at < t.updated_at)
     ORDER BY t.updated_at
     LIMIT $1`, [BATCH]);
  if (!dirty.length) return;

  const app = makeApp();
  const octokitFor = installationCache(app);
  const mirrored = new Set<string>();

  if (process.env.GITHUB_SYNC_LABELS !== "false") {
    for (const task of dirty) {
      // A repo that has failed repeatedly is skipped rather than retried on
      // every tick; its tasks stay dirty and go again once the breaker closes.
      if (circuitOpen(task.github_repo)) continue;
      try {
        await mirrorLabels(await octokitFor(task.github_repo), task);
        noteGithubSuccess(task.github_repo);
        mirrored.add(task.id);
      } catch (err: any) {
        noteGithubFailure(task.github_repo);
        console.error(`sync: labels failed for ${task.github_repo}#${task.github_issue_number}:`,
                      err?.message ?? err);
      }
    }
  }

  const projects = await query<ProjectRow>(
    `SELECT id, github_owner, github_project_number, github_project_id,
            github_status_field_id, github_status_options, github_status_map,
            github_fields_synced_at
     FROM projects WHERE id = ANY($1) AND github_project_number IS NOT NULL`,
    [[...new Set(dirty.map(t => t.project_id))]]);

  for (const project of projects) {
    const tasks = dirty.filter(t => t.project_id === project.id);
    if (!tasks.length || circuitOpen("project:" + project.id)) continue;
    // Any repo in the project reaches the same installation, so borrow one.
    try {
      const written = await mirrorProjectStatus(await octokitFor(tasks[0].github_repo), project, tasks);
      noteGithubSuccess("project:" + project.id);
      for (const id of written) mirrored.add(id);
    } catch (err: any) {
      noteGithubFailure("project:" + project.id);
      console.error(`sync: Projects v2 write-back failed for project ${project.id}:`, err?.message ?? err);
    }
  }

  // Stamp mirrored_at with the updated_at we read, not now(): a task edited
  // mid-cycle stays dirty and gets picked up on the next pass.
  for (const task of dirty) {
    if (!mirrored.has(task.id)) continue;
    await query("UPDATE tasks SET mirrored_at = $2 WHERE id = $1", [task.id, task.updated_at]);
  }
}

export function startSyncLoop() {
  if (process.env.GITHUB_SYNC_ENABLED !== "true") return;
  if (!githubConfigured()) {
    // Better to say so once at boot than to throw on every tick.
    console.error("sync: GITHUB_SYNC_ENABLED is true but the GitHub App is not configured; mirror disabled");
    return;
  }
  const every = Number(process.env.GITHUB_SYNC_INTERVAL_SEC ?? 180) * 1000;
  setInterval(() => syncOnce().catch(e => console.error("sync error", e)), every);
}
