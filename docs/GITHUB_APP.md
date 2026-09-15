# GitHub App setup (one app for the whole org)

1. Org settings → Developer settings → GitHub Apps → New GitHub App.
2. Webhook URL: `https://<backend>/webhooks/github`, secret = `GITHUB_WEBHOOK_SECRET`.
3. Permissions (repository): Issues **read/write**, Pull requests **read**, Checks **read**, Contents **read**, Metadata **read**. Organization: Projects **read/write**.
4. Subscribe to events: `issues`, `pull_request`, `check_suite`, `projects_v2_item`.
5. Install the app on the repos you listed in `projects.github_repos`.
6. Download the private key → `GITHUB_APP_PRIVATE_KEY_PATH`; set `GITHUB_APP_ID`.

## Why one app, not one per lead
Rate limits are per installation, not per person, and the app identity is for automation traffic only. Developers keep using their own `gh` login for `git push` and PR creation, which is low volume and stays attributed to them.

## Writing Projects v2 Status (TODO in sync)
Fetch the Status field and option ids once and store them on the project row:
```graphql
query($owner:String!,$number:Int!){ organization(login:$owner){ projectV2(number:$number){ id
  field(name:"Status"){ ... on ProjectV2SingleSelectField { id options { id name } } } } } }
```
Then `updateProjectV2ItemFieldValue(projectId, itemId, fieldId, value:{singleSelectOptionId})` in the sync loop.
