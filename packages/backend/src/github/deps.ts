/**
 * Turning `Depends on #12` into rows in `task_deps`.
 *
 * The issue body is the source of truth: a dependency that is no longer
 * declared is removed, so deleting the line un-blocks the task. Nothing else
 * writes this table.
 */
import { query, emit } from "../db.js";
import { dependenciesFrom, type IssueRef } from "./issue.js";

/**
 * Add one edge, unless it would close a loop.
 *
 * A cycle is the worst outcome here: every task in it becomes permanently
 * unclaimable, and `claim_task` reports it as "blocked by unfinished
 * dependencies", which looks like ordinary waiting. Cheaper to refuse the edge
 * and say so than to let the board quietly stall.
 */
async function addEdge(taskId: string, dependsOn: string): Promise<boolean> {
  if (taskId === dependsOn) return false;
  const rows = await query<{ depends_on: string }>(
    `WITH RECURSIVE reach AS (
       SELECT depends_on FROM task_deps WHERE task_id = $2
       UNION
       SELECT d.depends_on FROM task_deps d JOIN reach r ON d.task_id = r.depends_on
     )
     INSERT INTO task_deps (task_id, depends_on)
     SELECT $1::uuid, $2::uuid
     WHERE NOT EXISTS (SELECT 1 FROM reach WHERE depends_on = $1::uuid)
     ON CONFLICT DO NOTHING
     RETURNING depends_on`,
    [taskId, dependsOn]);
  // No row means either "already there" or "would cycle"; the caller only needs
  // to know whether the edge now exists, which a conflict also satisfies.
  if (rows[0]) return true;
  const existing = await query(
    "SELECT 1 FROM task_deps WHERE task_id = $1 AND depends_on = $2", [taskId, dependsOn]);
  return existing.length > 0;
}

/** Resolve `owner/repo#n` references to task ids within one project. */
async function resolve(projectId: string, refs: IssueRef[]): Promise<Map<string, string>> {
  if (!refs.length) return new Map();
  const rows = await query<{ id: string; github_repo: string; github_issue_number: number }>(
    `SELECT t.id, t.github_repo, t.github_issue_number
     FROM tasks t
     JOIN unnest($2::text[], $3::int[]) AS r(repo, num)
       ON t.github_repo = r.repo AND t.github_issue_number = r.num
     WHERE t.project_id = $1`,
    [projectId, refs.map(r => r.repo), refs.map(r => r.number)]);
  return new Map(rows.map(r => [`${r.github_repo}#${r.github_issue_number}`, r.id]));
}

/**
 * Make `task_deps` for one task match what its body declares. References to
 * issues the store has not seen yet are skipped rather than remembered; the
 * body is re-parsed on every edit and on every reconcile, so they settle.
 */
export async function syncDependencies(
  projectId: string, taskId: string, repo: string, body: string | null | undefined
): Promise<void> {
  const refs = dependenciesFrom(body, repo);
  const resolved = await resolve(projectId, refs);

  const wanted: string[] = [];
  for (const ref of refs) {
    const id = resolved.get(`${ref.repo}#${ref.number}`);
    if (id) wanted.push(id);
  }

  // Drop anything the body no longer declares, so removing the line unblocks.
  await query(
    `DELETE FROM task_deps WHERE task_id = $1 AND NOT (depends_on = ANY($2::uuid[]))`,
    [taskId, wanted]);

  for (const dependsOn of wanted) {
    if (await addEdge(taskId, dependsOn)) continue;
    await emit(projectId, "task.dependency_refused", "github", {
      task_id: taskId, depends_on: dependsOn,
      note: "declared dependency would create a cycle; every task in the loop would be permanently unclaimable"
    });
  }
}
