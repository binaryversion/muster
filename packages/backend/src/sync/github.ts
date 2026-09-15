/**
 * Store -> GitHub mirror, debounced. Pushes agent-owned state (status, claimer)
 * back so humans see it on the board. Runs every GITHUB_SYNC_INTERVAL_SEC and
 * batches, keeping API usage a handful of calls per interval.
 *
 * Scaffold applies labels on the issue (works with any board grouped by label).
 * Setting the Projects v2 "Status" single-select needs the field/option ids of
 * your board; see docs/GITHUB_APP.md for the GraphQL to fetch and store them.
 */
import { App } from "@octokit/app";
import { readFileSync } from "node:fs";
import { query } from "../db.js";

const STATUS_LABELS: Record<string, string> = {
  ready: "todo", in_progress: "in-progress", review: "in-review", done: "done"
};

function makeApp() {
  return new App({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH!, "utf8")
  });
}

export async function syncOnce() {
  const interval = Number(process.env.GITHUB_SYNC_INTERVAL_SEC ?? 180);
  const dirty = await query<any>(
    `SELECT t.*, l.name AS claimer
     FROM tasks t LEFT JOIN leads l ON l.id = t.claimed_by
     WHERE t.github_issue_number IS NOT NULL
       AND t.updated_at > now() - make_interval(secs => $1 * 2)`, [interval]);
  if (!dirty.length) return;

  const app = makeApp();
  const installations = new Map<string, any>();
  for (const t of dirty) {
    const [owner, repo] = String(t.github_repo).split("/");
    let octokit = installations.get(t.github_repo);
    if (!octokit) {
      const { data: inst } = await app.octokit.request("GET /repos/{owner}/{repo}/installation", { owner, repo });
      octokit = await app.getInstallationOctokit(inst.id);
      installations.set(t.github_repo, octokit);
    }
    const labels = [`muster:${STATUS_LABELS[t.status] ?? t.status}`];
    if (t.claimer) labels.push(`lead:${t.claimer}`);
    // Replace only muster-managed labels; keep the human ones.
    const { data: current } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/labels",
      { owner, repo, issue_number: t.github_issue_number });
    const keep = current.map((l: any) => l.name).filter((n: string) => !n.startsWith("muster:") && !n.startsWith("lead:"));
    await octokit.request("PUT /repos/{owner}/{repo}/issues/{issue_number}/labels",
      { owner, repo, issue_number: t.github_issue_number, labels: [...keep, ...labels] });
  }
}

export function startSyncLoop() {
  if (process.env.GITHUB_SYNC_ENABLED !== "true") return;
  const every = Number(process.env.GITHUB_SYNC_INTERVAL_SEC ?? 180) * 1000;
  setInterval(() => syncOnce().catch(e => console.error("sync error", e)), every);
}
