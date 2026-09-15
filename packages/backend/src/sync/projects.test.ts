/**
 * Unit tests for the Projects v2 write-back helpers. These are the pure parts:
 * status -> option mapping, and the GraphQL documents we build. They take a
 * stub graphql() so they run without GitHub or a database.
 *
 *   npm test        (builds, then node --test dist/)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { optionIdFor, pushStatuses, resolveItemIds, type ProjectRow } from "./projects.js";

const board: ProjectRow = {
  id: "p1",
  github_owner: "acme",
  github_project_number: 7,
  github_project_id: "PVT_board",
  github_status_field_id: "PVTSSF_status",
  github_status_options: { "Todo": "opt_todo", "In Progress": "opt_doing", "In review": "opt_review", "Done": "opt_done" },
  github_status_map: null,
  github_fields_synced_at: new Date().toISOString()
};

function stubGraphql(handler: (q: string, v: Record<string, unknown>) => any) {
  const calls: { query: string; vars: Record<string, unknown> }[] = [];
  return {
    calls,
    graphql: async <T = any>(query: string, vars: Record<string, unknown> = {}) => {
      calls.push({ query, vars });
      return handler(query, vars) as T;
    }
  };
}

test("optionIdFor matches board option names case-insensitively", () => {
  assert.equal(optionIdFor(board, "ready"), "opt_todo");
  assert.equal(optionIdFor(board, "in_progress"), "opt_doing");
  // "In review" on the board, "In Review" in the alias list.
  assert.equal(optionIdFor(board, "review"), "opt_review");
  assert.equal(optionIdFor(board, "done"), "opt_done");
});

test("optionIdFor falls through aliases in order", () => {
  // No "Ready" column, so ready lands on Todo; with neither it gives up rather
  // than guessing.
  assert.equal(optionIdFor({ ...board, github_status_options: { Ready: "opt_ready", Todo: "opt_todo" } }, "ready"), "opt_todo");
  assert.equal(optionIdFor({ ...board, github_status_options: { Shipped: "opt_shipped" } }, "ready"), undefined);
});

test("optionIdFor prefers an explicit github_status_map", () => {
  const mapped = { ...board, github_status_map: { review: "Todo", ready: "Done" } };
  assert.equal(optionIdFor(mapped, "review"), "opt_todo");
  assert.equal(optionIdFor(mapped, "ready"), "opt_done");
  // A mapping that names a column the board does not have must not silently
  // fall back to an alias and write the wrong column.
  assert.equal(optionIdFor({ ...board, github_status_map: { done: "Archived" } }, "done"), undefined);
});

test("optionIdFor returns nothing for a status with no sensible column", () => {
  assert.equal(optionIdFor(board, "cancelled"), undefined);
  assert.equal(optionIdFor(board, "nonsense"), undefined);
});

test("resolveItemIds picks the item on this board and ignores others", async () => {
  const api = stubGraphql(() => ({
    nodes: [
      { id: "I_a", projectItems: { nodes: [{ id: "PVTI_a", project: { id: "PVT_board" } }] } },
      // Same issue on two boards: only ours counts.
      { id: "I_b", projectItems: { nodes: [
        { id: "PVTI_other", project: { id: "PVT_elsewhere" } },
        { id: "PVTI_b", project: { id: "PVT_board" } }] } },
      // On no board at all.
      { id: "I_c", projectItems: { nodes: [] } },
      null
    ]
  }));
  const found = await resolveItemIds(api, "PVT_board", ["I_a", "I_b", "I_c"]);
  assert.deepEqual([...found.entries()], [["I_a", "PVTI_a"], ["I_b", "PVTI_b"]]);
});

test("resolveItemIds chunks large lookups", async () => {
  const api = stubGraphql((_q, v) => ({
    nodes: (v.ids as string[]).map(id => ({ id, projectItems: { nodes: [{ id: "PVTI_" + id, project: { id: "PVT_board" } }] } }))
  }));
  const ids = Array.from({ length: 120 }, (_, i) => "I_" + i);
  const found = await resolveItemIds(api, "PVT_board", ids);
  assert.equal(found.size, 120);
  assert.equal(api.calls.length, 3);                       // 50 + 50 + 20
  assert.ok((api.calls[0].vars.ids as string[]).length === 50);
});

test("pushStatuses batches aliased mutations into one document", async () => {
  const api = stubGraphql((_q, v) => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v)) {
      const m = /^item(\d+)$/.exec(key);
      if (m) out["a" + m[1]] = { projectV2Item: { id: v[key] } };
    }
    return out;
  });
  const updates = Array.from({ length: 3 }, (_, i) => ({ taskId: "t" + i, itemId: "PVTI_" + i, optionId: "opt_doing" }));

  const written = await pushStatuses(api, board, updates);
  assert.deepEqual(written, ["t0", "t1", "t2"]);
  assert.equal(api.calls.length, 1, "three updates should cost one request");

  const { query, vars } = api.calls[0];
  assert.match(query, /^mutation\(\$project:ID!, \$field:ID!, \$item0:ID!, \$option0:String!/);
  assert.match(query, /a2: updateProjectV2ItemFieldValue\(input:\{projectId:\$project, itemId:\$item2, fieldId:\$field, value:\{singleSelectOptionId:\$option2\}\}\)/);
  assert.equal(vars.project, "PVT_board");
  assert.equal(vars.field, "PVTSSF_status");
  assert.equal(vars.item1, "PVTI_1");
  assert.equal(vars.option1, "opt_doing");
});

test("pushStatuses splits past the mutation chunk size", async () => {
  const api = stubGraphql((_q, v) => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v)) {
      const m = /^item(\d+)$/.exec(key);
      if (m) out["a" + m[1]] = { projectV2Item: { id: v[key] } };
    }
    return out;
  });
  const updates = Array.from({ length: 60 }, (_, i) => ({ taskId: "t" + i, itemId: "PVTI_" + i, optionId: "opt_done" }));
  const written = await pushStatuses(api, board, updates);
  assert.equal(written.length, 60);
  assert.equal(api.calls.length, 3);                       // 25 + 25 + 10
});

test("pushStatuses keeps the aliases that succeeded when GitHub reports partial errors", async () => {
  const api = stubGraphql(() => {
    // Shape octokit throws on a partial GraphQL failure.
    const err: any = new Error("Some requested items could not be updated");
    err.data = { a0: { projectV2Item: { id: "PVTI_0" } }, a1: null, a2: { projectV2Item: { id: "PVTI_2" } } };
    err.errors = [{ message: "Could not resolve to a node with the global id of 'PVTI_1'" }];
    throw err;
  });
  const updates = ["0", "1", "2"].map(i => ({ taskId: "t" + i, itemId: "PVTI_" + i, optionId: "opt_done" }));
  const written = await pushStatuses(api, board, updates);
  // t1 stays dirty and is retried next cycle; the other two are not re-pushed.
  assert.deepEqual(written, ["t0", "t2"]);
});

test("pushStatuses is a no-op when the board ids are not resolved yet", async () => {
  const api = stubGraphql(() => ({}));
  const written = await pushStatuses(api, { ...board, github_status_field_id: null },
    [{ taskId: "t0", itemId: "PVTI_0", optionId: "opt_done" }]);
  assert.deepEqual(written, []);
  assert.equal(api.calls.length, 0);
});
