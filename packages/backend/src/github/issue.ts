/**
 * Reading the human-owned fields off a GitHub issue.
 *
 * `docs/ARCHITECTURE.md` says GitHub owns title, body and priority, and that
 * dependencies gate a claim. Both of those were true of the schema and false of
 * the code: nothing ever wrote `priority`, and nothing ever wrote `task_deps`.
 * This module is where an issue turns into both.
 *
 * Everything here is pure, so the rules can be tested without GitHub.
 */

/** `tasks.priority` is an int where 1 is most urgent; the column defaults to 3. */
export const DEFAULT_PRIORITY = 3;
const MIN_PRIORITY = 1;
const MAX_PRIORITY = 5;

/**
 * Word labels, most urgent first. A repo can use any of these spellings, with
 * or without a `priority:` / `priority/` / `prio:` prefix and with or without
 * spaces, because no two teams label the same way.
 */
const WORD_PRIORITY: [RegExp, number][] = [
  [/^(critical|urgent|blocker|now)$/, 1],
  [/^(high|important)$/, 2],
  [/^(medium|normal|default)$/, 3],
  [/^(low|minor)$/, 4],
  [/^(trivial|lowest|someday|nice[- ]?to[- ]?have)$/, 5]
];

function priorityFromLabel(name: string): number | null {
  const bare = name.trim().toLowerCase()
    .replace(/^(priority|prio|pri)\s*[:/\-]\s*/, "")
    .replace(/\s+priority$/, "")
    .trim();

  // P0/P1/P2… The number is the priority. P0 and P1 both mean "most urgent"
  // because teams number from either 0 or 1, and clamping is kinder than
  // guessing which scheme this repo uses.
  const numbered = /^p\s*(\d{1,2})$/.exec(bare);
  if (numbered) return Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, Number(numbered[1])));

  for (const [pattern, value] of WORD_PRIORITY) if (pattern.test(bare)) return value;
  return null;
}

/**
 * The priority a set of labels implies. Most urgent wins when several match, so
 * adding `critical` to something already labelled `low` does what you meant.
 * No recognised label means the default — removing the label has to move the
 * task back, or priority could never be un-set from GitHub.
 */
export function priorityFromLabels(labels: readonly { name?: string }[] | undefined): number {
  let best: number | null = null;
  for (const label of labels ?? []) {
    const value = label?.name ? priorityFromLabel(label.name) : null;
    if (value !== null && (best === null || value < best)) best = value;
  }
  return best ?? DEFAULT_PRIORITY;
}

export interface IssueRef { repo: string; number: number }

const DEPENDENCY_LINE = /\b(depends?\s+on|blocked\s+by|requires?|needs)\b\s*:?/i;
const REF = /(?:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+))?#(\d+)/g;

/**
 * Dependencies declared in an issue body: `Depends on #12`,
 * `Blocked by acme/api#4`, `Requires #7 and #9`.
 *
 * Matching is per line and only after the keyword, so a body that merely
 * mentions `#12` in passing does not become a dependency — the cost of a false
 * positive is a task nobody can claim, which is worse than missing one.
 */
export function dependenciesFrom(body: string | null | undefined, defaultRepo: string): IssueRef[] {
  const found: IssueRef[] = [];
  const seen = new Set<string>();

  for (const line of String(body ?? "").split(/\r?\n/)) {
    const keyword = DEPENDENCY_LINE.exec(line);
    if (!keyword) continue;
    const rest = line.slice(keyword.index + keyword[0].length);

    REF.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REF.exec(rest))) {
      const repo = match[1] ?? defaultRepo;
      const number = Number(match[2]);
      const key = `${repo}#${number}`;
      if (!seen.has(key)) { seen.add(key); found.push({ repo, number }); }
    }
  }
  return found;
}
