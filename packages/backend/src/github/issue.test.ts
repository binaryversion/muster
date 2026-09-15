import test from "node:test";
import assert from "node:assert/strict";
import { priorityFromLabels, dependenciesFrom, DEFAULT_PRIORITY } from "./issue.js";

const labels = (...names: string[]) => names.map(name => ({ name }));

test("P-numbers map to the priority column", () => {
  assert.equal(priorityFromLabels(labels("P1")), 1);
  assert.equal(priorityFromLabels(labels("P2")), 2);
  assert.equal(priorityFromLabels(labels("p3")), 3);
  // Teams number from 0 or from 1; both mean "most urgent" rather than one of
  // them silently meaning "more urgent than most urgent".
  assert.equal(priorityFromLabels(labels("P0")), 1);
  // Out of range clamps rather than writing a priority nothing sorts by.
  assert.equal(priorityFromLabels(labels("P9")), 5);
});

test("word labels are recognised with or without a prefix", () => {
  assert.equal(priorityFromLabels(labels("critical")), 1);
  assert.equal(priorityFromLabels(labels("priority: high")), 2);
  assert.equal(priorityFromLabels(labels("priority/low")), 4);
  assert.equal(priorityFromLabels(labels("prio:medium")), 3);
  assert.equal(priorityFromLabels(labels("high priority")), 2);
  assert.equal(priorityFromLabels(labels("nice-to-have")), 5);
});

test("the most urgent label wins", () => {
  assert.equal(priorityFromLabels(labels("low", "critical", "P3")), 1);
  assert.equal(priorityFromLabels(labels("bug", "P2", "documentation")), 2);
});

test("unrecognised labels leave the default, so removing one moves the task back", () => {
  assert.equal(priorityFromLabels(labels("bug", "good first issue")), DEFAULT_PRIORITY);
  assert.equal(priorityFromLabels([]), DEFAULT_PRIORITY);
  assert.equal(priorityFromLabels(undefined), DEFAULT_PRIORITY);
  // "P" alone, or a word that merely contains one, is not a priority.
  assert.equal(priorityFromLabels(labels("performance", "P")), DEFAULT_PRIORITY);
});

test("dependencies are read from the declaring line only", () => {
  assert.deepEqual(dependenciesFrom("Depends on #12", "acme/web"),
    [{ repo: "acme/web", number: 12 }]);
  assert.deepEqual(dependenciesFrom("Blocked by acme/api#4", "acme/web"),
    [{ repo: "acme/api", number: 4 }]);
  assert.deepEqual(dependenciesFrom("Requires #7 and #9", "acme/web"),
    [{ repo: "acme/web", number: 7 }, { repo: "acme/web", number: 9 }]);
});

test("a passing mention is not a dependency", () => {
  // A false positive is a task nobody can claim, so this has to be strict.
  assert.deepEqual(dependenciesFrom("Same root cause as #12, see the thread", "acme/web"), []);
  assert.deepEqual(dependenciesFrom("Fixes #12", "acme/web"), []);
  assert.deepEqual(dependenciesFrom("", "acme/web"), []);
  assert.deepEqual(dependenciesFrom(null, "acme/web"), []);
});

test("only refs after the keyword on that line count", () => {
  const body = [
    "Context: #99 has the background.",
    "Depends on #12, #13",
    "Unrelated: #77"
  ].join("\n");
  assert.deepEqual(dependenciesFrom(body, "acme/web"),
    [{ repo: "acme/web", number: 12 }, { repo: "acme/web", number: 13 }]);
});

test("duplicates collapse and casing does not matter", () => {
  const body = "DEPENDS ON #5\nBlocked by #5\nrequires acme/web#5";
  assert.deepEqual(dependenciesFrom(body, "acme/web"), [{ repo: "acme/web", number: 5 }]);
});
