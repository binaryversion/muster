/**
 * The reconcile diff rules. planReconcile is pure, so these run without GitHub
 * or a database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { planReconcile, fetchIssues, type IssueSnapshot, type StoreTask } from "./reconcile.js";

const task = (over: Partial<StoreTask> = {}): StoreTask => ({
  id: "t1", title: "Wire up the thing", body: "details", status: "ready",
  github_repo: "acme/web", github_issue_number: 1, ...over
});
const issue = (over: Partial<IssueSnapshot> = {}): IssueSnapshot => ({
  repo: "acme/web", number: 1, node_id: "I_1",
  title: "Wire up the thing", body: "details", state: "open", ...over
});

test("an issue the store never saw is created", () => {
  const plan = planReconcile([], [issue()]);
  assert.deepEqual(plan.map(a => a.kind), ["create"]);
});

test("a closed issue closes the task and is reported even when the text also drifted", () => {
  const plan = planReconcile([task({ status: "in_progress" })], [issue({ state: "closed", title: "Renamed" })]);
  // One action, not a close plus an update: the close writes the text too.
  assert.deepEqual(plan, [{ kind: "close", taskId: "t1", issue: issue({ state: "closed", title: "Renamed" }) }]);
});

test("a reopened issue puts a done task back in the pool", () => {
  const plan = planReconcile([task({ status: "done" })], [issue({ state: "open" })]);
  assert.deepEqual(plan.map(a => a.kind), ["reopen"]);
});

test("drifted title or body is an update", () => {
  assert.deepEqual(planReconcile([task()], [issue({ title: "New title" })]).map(a => a.kind), ["update"]);
  assert.deepEqual(planReconcile([task()], [issue({ body: "more detail" })]).map(a => a.kind), ["update"]);
  // A null body in the store and an empty one on GitHub are the same thing.
  assert.deepEqual(planReconcile([task({ body: null })], [issue({ body: "" })]), []);
});

test("agent-owned status is left alone", () => {
  // The store owns status, claim and lease; an open issue whose task is in
  // review or in progress is exactly what working software looks like.
  for (const status of ["in_progress", "review", "backlog", "cancelled"]) {
    assert.deepEqual(planReconcile([task({ status })], [issue({ state: "open" })]), [],
      `open issue + ${status} task should need no action`);
  }
});

test("a closed issue whose task is already done needs nothing", () => {
  assert.deepEqual(planReconcile([task({ status: "done" })], [issue({ state: "closed" })]), []);
});

test("orphans are only reported on a full scan", () => {
  const tasks = [task(), task({ id: "t2", github_issue_number: 2 })];
  const seen = [issue({ number: 1 })];
  // Incremental: issue 2 is simply one that has not changed lately.
  assert.deepEqual(planReconcile(tasks, seen, false), []);
  assert.deepEqual(planReconcile(tasks, seen, true),
    [{ kind: "orphan", taskId: "t2", repo: "acme/web", number: 2 }]);
});

test("issue numbers are scoped per repo", () => {
  const tasks = [task({ github_repo: "acme/web", github_issue_number: 5 })];
  // Same number, different repo: a different task, so this one is new.
  const plan = planReconcile(tasks, [issue({ repo: "acme/api", number: 5 })], true);
  assert.deepEqual(plan.map(a => a.kind), ["create", "orphan"]);
});

test("fetchIssues drops pull requests and normalises the shape", async () => {
  const octokit = {
    paginate: async (_route: string, params: Record<string, unknown>) => {
      assert.equal(params.owner, "acme");
      assert.equal(params.repo, "web");
      assert.equal(params.state, "all");
      assert.equal(params.since, "2026-09-01T00:00:00.000Z");
      return [
        { number: 1, node_id: "I_1", title: "An issue", body: "b", state: "open" },
        { number: 2, node_id: "PR_2", title: "A PR", body: "b", state: "open", pull_request: { url: "…" } },
        { number: 3, node_id: "I_3", title: "Closed one", body: null, state: "closed" }
      ];
    }
  };
  const issues = await fetchIssues(octokit, "acme/web", "2026-09-01T00:00:00.000Z");
  assert.deepEqual(issues, [
    { repo: "acme/web", number: 1, node_id: "I_1", title: "An issue", body: "b", state: "open" },
    { repo: "acme/web", number: 3, node_id: "I_3", title: "Closed one", body: "", state: "closed" }
  ]);
});

test("fetchIssues omits since on a full scan", async () => {
  const octokit = {
    paginate: async (_route: string, params: Record<string, unknown>) => {
      assert.ok(!("since" in params), "a full scan must not send since");
      return [];
    }
  };
  assert.deepEqual(await fetchIssues(octokit, "acme/web", null), []);
});
