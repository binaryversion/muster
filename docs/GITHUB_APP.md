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
