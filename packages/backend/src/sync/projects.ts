/**
 * GitHub Projects v2 write-back.
 *
 * Setting the board's "Status" single-select needs four node ids: the project,
 * the item, the field and the option. Three are per-project and stable, so they
 * are resolved once and cached on the project row (migration 002); only the
 * item id is per-task, and it is resolved lazily and cached on the task.
 *
 * See docs/GITHUB_APP.md for the App permissions this needs.
 */
import { query } from "../db.js";

export interface ProjectRow {
  id: string;
  github_owner: string | null;
  github_project_number: number | null;
  github_project_id: string | null;
  github_status_field_id: string | null;
  github_status_options: Record<string, string>;   // option name -> option id
  github_status_map: Record<string, string> | null; // task_status -> option name
  github_fields_synced_at: string | null;
}

/** Any object with a graphql() method; keeps this module free of octokit types. */
type Graphql = { graphql: <T = any>(q: string, vars?: Record<string, unknown>) => Promise<T> };

const FIELD_TTL_MS = 6 * 60 * 60 * 1000;   // boards gain and rename columns
const ITEM_QUERY_CHUNK = 50;               // node ids per lookup
const MUTATION_CHUNK = 25;                 // aliased mutations per document

/**
 * Boards name their columns whatever they like, so a muster status maps to the
 * first option whose name matches one of these, case-insensitively. Projects
 * that do not fit set github_status_map explicitly.
 */
const STATUS_ALIASES: Record<string, string[]> = {
  backlog:     ["backlog", "triage", "todo", "to do"],
  ready:       ["todo", "to do", "ready", "backlog"],
  in_progress: ["in progress", "in-progress", "doing", "started"],
  review:      ["in review", "in-review", "review", "needs review", "reviewing"],
  done:        ["done", "complete", "completed", "shipped", "closed"],
  cancelled:   ["cancelled", "canceled", "won't do", "wont do", "dropped", "not planned"]
};

/** Resolve a muster task status to an option id on this project's board. */
export function optionIdFor(project: ProjectRow, status: string): string | undefined {
  const options = project.github_status_options ?? {};
  const byLowerName = new Map(Object.entries(options).map(([name, id]) => [name.toLowerCase(), id]));

  const explicit = project.github_status_map?.[status];
  if (explicit) return byLowerName.get(explicit.toLowerCase());

  for (const candidate of STATUS_ALIASES[status] ?? []) {
    const id = byLowerName.get(candidate);
    if (id) return id;
  }
  return undefined;
}

const BOARD_QUERY = `
  query($owner:String!, $number:Int!) {
    repositoryOwner(login:$owner) {
      ... on Organization { projectV2(number:$number) { ...Board } }
      ... on User         { projectV2(number:$number) { ...Board } }
    }
  }
  fragment Board on ProjectV2 {
    id
    field(name:"Status") {
      ... on ProjectV2SingleSelectField { id options { id name } }
    }
  }`;

/**
 * Refresh the cached project/field/option ids when they are missing or stale.
 * Returns the project row as it should now be used, or null if this project is
 * not wired to a Projects v2 board (or has no Status field).
 */
export async function ensureBoardMetadata(octokit: Graphql, project: ProjectRow): Promise<ProjectRow | null> {
  if (!project.github_owner || !project.github_project_number) return null;

  const fresh = project.github_fields_synced_at &&
    Date.now() - new Date(project.github_fields_synced_at).getTime() < FIELD_TTL_MS;
  if (fresh && project.github_project_id && project.github_status_field_id) return project;

  const data = await octokit.graphql<any>(BOARD_QUERY, {
    owner: project.github_owner, number: project.github_project_number
  });
  const board = data?.repositoryOwner?.projectV2;
  if (!board?.id) {
    console.error(`sync: no ProjectV2 #${project.github_project_number} for ${project.github_owner}`);
    return null;
  }
  if (!board.field?.id) {
    console.error(`sync: project #${project.github_project_number} has no single-select "Status" field`);
    return null;
  }

  const options: Record<string, string> = {};
  for (const o of board.field.options ?? []) options[o.name] = o.id;

  await query(
    `UPDATE projects SET github_project_id=$2, github_status_field_id=$3,
            github_status_options=$4, github_fields_synced_at=now()
     WHERE id=$1`,
    [project.id, board.id, board.field.id, JSON.stringify(options)]);

  return { ...project, github_project_id: board.id, github_status_field_id: board.field.id,
           github_status_options: options, github_fields_synced_at: new Date().toISOString() };
}

const ITEM_QUERY = `
  query($ids:[ID!]!) {
    nodes(ids:$ids) {
      ... on Issue { id projectItems(first:20) { nodes { id project { id } } } }
    }
  }`;

/**
 * Find each issue's item on this board. Issues that a human has not added to
 * the board simply have no item; we do not add them, because the board is the
 * humans' plan and adding rows to it is not the mirror's job.
 * Returns issue node id -> ProjectV2Item node id.
 */
export async function resolveItemIds(
  octokit: Graphql, projectNodeId: string, issueNodeIds: string[]
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let i = 0; i < issueNodeIds.length; i += ITEM_QUERY_CHUNK) {
    const ids = issueNodeIds.slice(i, i + ITEM_QUERY_CHUNK);
    const data = await octokit.graphql<any>(ITEM_QUERY, { ids });
    for (const node of data?.nodes ?? []) {
      if (!node?.id) continue;
      const item = (node.projectItems?.nodes ?? []).find((n: any) => n?.project?.id === projectNodeId);
      if (item?.id) found.set(node.id, item.id);
    }
  }
  return found;
}

export interface StatusUpdate { taskId: string; itemId: string; optionId: string }

/**
 * Set Status on a batch of items. Mutations are aliased into one document so a
 * cycle costs a couple of calls rather than one per task. GitHub runs them in
 * order and reports per-alias errors, so a single bad item does not sink the
 * rest. Returns the task ids that were actually written.
 */
export async function pushStatuses(
  octokit: Graphql, project: ProjectRow, updates: StatusUpdate[]
): Promise<string[]> {
  if (!project.github_project_id || !project.github_status_field_id || !updates.length) return [];
  const written: string[] = [];

  for (let i = 0; i < updates.length; i += MUTATION_CHUNK) {
    const chunk = updates.slice(i, i + MUTATION_CHUNK);
    const args = ["$project:ID!", "$field:ID!"];
    const body: string[] = [];
    const vars: Record<string, unknown> = {
      project: project.github_project_id, field: project.github_status_field_id
    };
    chunk.forEach((u, n) => {
      args.push(`$item${n}:ID!`, `$option${n}:String!`);
      vars[`item${n}`] = u.itemId;
      vars[`option${n}`] = u.optionId;
      body.push(
        `  a${n}: updateProjectV2ItemFieldValue(input:{projectId:$project, itemId:$item${n}, ` +
        `fieldId:$field, value:{singleSelectOptionId:$option${n}}}) { projectV2Item { id } }`);
    });
    const doc = `mutation(${args.join(", ")}) {\n${body.join("\n")}\n}`;

    let data: any;
    try {
      data = await octokit.graphql<any>(doc, vars);
    } catch (err: any) {
      // A partial failure still carries the aliases that succeeded, so keep
      // those rather than re-pushing the whole chunk next cycle.
      data = err?.data;
      for (const e of err?.errors ?? [{ message: err?.message }]) {
        console.error("sync: Projects v2 status update failed:", e?.message ?? e);
      }
      if (!data) continue;
    }
    chunk.forEach((u, n) => { if (data?.[`a${n}`]) written.push(u.taskId); });
  }
  return written;
}
