# GitHub App setup (one app for the whole org)

1. Org settings → Developer settings → GitHub Apps → New GitHub App.
2. Webhook URL: `https://<backend>/webhooks/github`, secret = `GITHUB_WEBHOOK_SECRET`.
3. Permissions (repository): Issues **read/write**, Pull requests **read**, Checks **read**, Contents **read**, Metadata **read**. Organization: Projects **read/write**.
4. Subscribe to events: `issues`, `pull_request`, `check_suite`, `projects_v2_item`.
5. Install the app on the repos you listed in `projects.github_repos`.
6. Download the private key → `GITHUB_APP_PRIVATE_KEY_PATH`; set `GITHUB_APP_ID`.

## Why one app, not one per lead
Rate limits are per installation, not per person, and the app identity is for automation traffic only. Developers keep using their own `gh` login for `git push` and PR creation, which is low volume and stays attributed to them.

## Writing Projects v2 Status

Implemented in `packages/backend/src/sync/projects.ts`. Setting a single-select
field needs four node ids; three are per-project and stable, so they are
resolved once and cached on the project row (migration 002), and re-resolved
every six hours in case the board was renamed.

```graphql
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
}
```

`repositoryOwner` rather than `organization` so a board owned by a user works
too. The fourth id, the `ProjectV2Item`, is per-task: it arrives free on
`projects_v2_item` webhooks, and otherwise is looked up from the issue's
`projectItems` connection and cached on the task.

The mirror then batches `updateProjectV2ItemFieldValue` calls, aliased into one
document, 25 at a time:

```graphql
mutation($project:ID!, $field:ID!, $item0:ID!, $option0:String!, ...) {
  a0: updateProjectV2ItemFieldValue(input:{
        projectId:$project, itemId:$item0, fieldId:$field,
        value:{singleSelectOptionId:$option0}}) { projectV2Item { id } }
  ...
}
```

### Wiring a project to a board

```bash
curl -X PATCH localhost:8080/admin/projects/<id> -H "Authorization: Bearer $ADMIN_PASSWORD" \
  -H 'content-type: application/json' -d '{"github_owner":"acme","github_project_number":7}'
```

Then set `GITHUB_SYNC_ENABLED=true`. Changing `github_project_number` clears the
cached ids so the next cycle re-resolves them against the new board.

### Column names

A muster status maps to the first board column whose name matches one of its
aliases, case-insensitively:

| status | matches |
|---|---|
| `backlog` | Backlog, Triage, Todo, To do |
| `ready` | Todo, To do, Ready, Backlog |
| `in_progress` | In Progress, In-progress, Doing, Started |
| `review` | In Review, In-review, Review, Needs review, Reviewing |
| `done` | Done, Complete, Completed, Shipped, Closed |
| `cancelled` | Cancelled, Canceled, Won't do, Dropped, Not planned |

If your board names columns something else, map them explicitly — this wins over
the aliases, and a name the board does not have is left alone rather than
falling back to a guess:

```bash
curl -X PATCH localhost:8080/admin/projects/<id> -H "Authorization: Bearer $ADMIN_PASSWORD" \
  -H 'content-type: application/json' \
  -d '{"github_status_map":{"ready":"Up next","in_progress":"WIP","review":"Awaiting review"}}'
```

A status with no matching column is logged and skipped; nothing else on the
board is touched.

### What the mirror will not do

Issues a human has not put on the board have no item, and the mirror does not
add them. The board is the humans' plan; the mirror only writes the columns
agents own (see `docs/ARCHITECTURE.md`).

## What Muster reads off an issue

Beyond title and body, two things are read from the issue itself. Both are
re-read on every `issues.*` webhook and on every reconcile, so they stay correct
even if a delivery is missed.

### Priority

From the issue's labels. `tasks.priority` is an int where **1 is most urgent**,
and `muster_list_available_tasks` orders by it.

| Label | Priority |
|---|---|
| `P0`, `P1`, `critical`, `urgent`, `blocker` | 1 |
| `P2`, `high`, `important` | 2 |
| `P3`, `medium`, `normal` | 3 |
| `P4`, `low`, `minor` | 4 |
| `P5`, `trivial`, `nice-to-have` | 5 |

A `priority:`, `priority/`, `prio:` or `pri:` prefix is ignored, as is a
` priority` suffix, so `priority: high` and `high priority` both work. `P0` and
`P1` both mean 1, because teams number from either 0 or 1 and clamping is kinder
than guessing which scheme a repo uses. If several match, the most urgent wins.
No recognised label means the default of 3 — which is also how you clear a
priority: remove the label.

### Dependencies

From the issue body. A line containing **depends on**, **blocked by**,
**requires** or **needs** contributes every issue reference after the keyword on
that line:

```
Depends on #12 and #13
Blocked by acme/api#4
```

`claim_task()` refuses a task whose dependencies are not `done`, so this is what
makes ordering real rather than advisory.

Only references *after* the keyword *on that line* count. A body that merely
mentions `#12`, or says `Fixes #12`, creates nothing — a false positive here is
a task nobody can claim, which is worse than a missed one.

The body is the source of truth: delete the line and the dependency goes. An
edge that would close a loop is refused and reported as a
`task.dependency_refused` event, because every task in a cycle becomes
permanently unclaimable while `claim_task` reports it as ordinary waiting.
