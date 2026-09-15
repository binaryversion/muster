#!/usr/bin/env bash
# End-to-end smoke test for a running Muster deployment.
#
# Walks the whole coordination path that a lead session depends on:
#   admin API  -> create a project and issue a lead token
#   webhook    -> a signed issues.opened delivery becomes a task in the store
#   MCP        -> list / claim / heartbeat / complete, plus findings and events
#   claim race -> a second lead is refused while the first lease is live
#
# Prerequisites (see README quick start):
#   docker compose up -d db && ./scripts/migrate.sh
#   (cd packages/backend && npm i && npm run dev)
#   (cd packages/mcp-server && npm i && npm run dev)
#
# Usage:
#   ADMIN_PASSWORD=... GITHUB_WEBHOOK_SECRET=... ./scripts/smoke.sh
#
# Env (all optional except the two secrets, which must match the servers'):
#   BACKEND_URL   default http://localhost:8080
#   MCP_URL       default http://localhost:8090/mcp
#   DATABASE_URL  if set, the project created by this run is deleted at the end
set -euo pipefail

BACKEND_URL="${BACKEND_URL:-http://localhost:8080}"
MCP_URL="${MCP_URL:-http://localhost:8090/mcp}"
# ADMIN_TOKEN is the old name for the same secret; still accepted.
ADMIN_PASSWORD="${ADMIN_PASSWORD:-${ADMIN_TOKEN:-}}"
GITHUB_WEBHOOK_SECRET="${GITHUB_WEBHOOK_SECRET:-}"

for bin in curl jq openssl; do
  command -v "$bin" >/dev/null || { echo "smoke: $bin is required" >&2; exit 1; }
done
[ -n "$ADMIN_PASSWORD" ] || { echo "smoke: ADMIN_PASSWORD must be set (same value as the backend's)" >&2; exit 1; }
[ -n "$GITHUB_WEBHOOK_SECRET" ] || { echo "smoke: GITHUB_WEBHOOK_SECRET must be set (same value as the backend's)" >&2; exit 1; }

RUN="$(date +%s)-$$"
SLUG="smoke-$RUN"
REPO="muster-smoke/repo-$RUN"       # not a real repo; nothing calls GitHub here
ISSUE=$(( (RANDOM % 9000) + 1000 ))
PROJECT_ID=""
FAILED=0

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die()  { printf '\033[31msmoke: %s\033[0m\n' "$1" >&2; exit 1; }

cleanup() {
  if [ -n "$PROJECT_ID" ] && [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null; then
    # Tasks, leads, findings and events all cascade from the project row.
    psql "$DATABASE_URL" -X -q -c "DELETE FROM projects WHERE id = '$PROJECT_ID'" >/dev/null 2>&1 \
      && echo "smoke: cleaned up project $SLUG" \
      || echo "smoke: could not clean up project $SLUG (delete it by hand)"
  elif [ -n "$PROJECT_ID" ]; then
    echo "smoke: leaving project $SLUG behind (set DATABASE_URL to auto-clean)"
  fi
}
trap cleanup EXIT

admin() { # admin METHOD PATH [BODY]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$BACKEND_URL$path" \
      -H "Authorization: Bearer $ADMIN_PASSWORD" -H 'content-type: application/json' -d "$body"
  else
    curl -sS -X "$method" "$BACKEND_URL$path" -H "Authorization: Bearer $ADMIN_PASSWORD"
  fi
}

# The MCP server runs in stateless Streamable HTTP mode, so each request stands
# on its own: no initialize handshake and no session id to carry. Responses come
# back as a one-shot SSE stream, hence the data: line extraction.
mcp() { # mcp TOKEN TOOL ARGS_JSON
  local token="$1" tool="$2" args="$3"
  local req
  req=$(jq -nc --arg n "$tool" --argjson a "$args" \
        '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')
  curl -sS -X POST "$MCP_URL" \
    -H "Authorization: Bearer $token" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -d "$req" \
  | sed -n 's/^data: //p' | tail -n 1
}

mcp_text()    { jq -r '.result.content[0].text // .error.message // "<no content>"'; }
mcp_iserror() { jq -r 'if .result.isError == true or (.error|type=="object") then "yes" else "no" end'; }

echo "smoke: backend=$BACKEND_URL mcp=$MCP_URL run=$RUN"

step "0. health"
[ "$(curl -sS "$BACKEND_URL/healthz")" = "ok" ] || die "backend not healthy at $BACKEND_URL"
[ "$(curl -sS "${MCP_URL%/mcp}/healthz")" = "ok" ] || die "mcp-server not healthy at $MCP_URL"
pass "backend and mcp-server are up"

step "1. admin API: project and lead tokens"
project=$(admin POST /admin/projects "$(jq -nc --arg s "$SLUG" --arg r "$REPO" \
  '{slug:$s,name:"Muster smoke test",github_owner:"muster-smoke",github_repos:[$r]}')")
PROJECT_ID=$(echo "$project" | jq -r '.id // empty')
[ -n "$PROJECT_ID" ] || die "could not create project: $project"
pass "created project $SLUG ($PROJECT_ID)"

issue_lead() { # issue_lead NAME -> plaintext token
  admin POST "/admin/projects/$PROJECT_ID/leads" "$(jq -nc --arg n "$1" '{name:$n,expires_in_days:1}')" \
    | jq -r '.token // empty'
}
TOKEN_A=$(issue_lead "smoke-lead-a"); [ -n "$TOKEN_A" ] || die "no token issued for lead A"
TOKEN_B=$(issue_lead "smoke-lead-b"); [ -n "$TOKEN_B" ] || die "no token issued for lead B"
pass "issued two lead tokens (shown once, stored hashed)"

[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BACKEND_URL/admin/projects" \
     -H 'Authorization: Bearer definitely-not-the-admin-password')" = "401" ] \
  && pass "admin API rejects a bad admin password" || fail "admin API accepted a bad admin password"

[ "$(curl -sS -o /dev/null -w '%{http_code}' "$BACKEND_URL/admin/projects")" = "401" ] \
  && pass "admin API refuses anonymous callers" || fail "admin API served an anonymous caller"

[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$MCP_URL" \
     -H 'Authorization: Bearer mstr_not-a-real-token' -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')" = "401" ] \
  && pass "MCP rejects an unknown lead token" || fail "MCP accepted an unknown lead token"

step "2. webhook: a GitHub issue becomes a task"
payload=$(jq -nc --arg repo "$REPO" --argjson num "$ISSUE" \
  '{action:"opened",
    repository:{full_name:$repo},
    issue:{number:$num,title:"Smoke: wire up the thing",body:"Created by scripts/smoke.sh",
           node_id:("I_smoke_" + ($num|tostring))}}')
sig="sha256=$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | awk '{print $NF}')"
delivery="smoke-$RUN"

post_hook() { # post_hook DELIVERY_ID -> http status
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$BACKEND_URL/webhooks/github" \
    -H 'content-type: application/json' -H 'x-github-event: issues' \
    -H "x-github-delivery: $1" -H "x-hub-signature-256: $sig" -d "$payload"
}

[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BACKEND_URL/webhooks/github" \
     -H 'content-type: application/json' -H 'x-github-event: issues' \
     -H "x-github-delivery: $delivery-unsigned" \
     -H 'x-hub-signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000' \
     -d "$payload")" = "401" ] \
  && pass "webhook rejects a bad signature" || fail "webhook accepted a bad signature"

[ "$(post_hook "$delivery")" = "202" ] || die "signed webhook was not accepted"
pass "signed webhook accepted"

# The backend acks with 202 and processes after, so poll rather than assume.
task_id=""
for _ in $(seq 1 30); do
  task_id=$(mcp "$TOKEN_A" muster_list_available_tasks '{"limit":20}' \
            | jq -r --argjson num "$ISSUE" \
              '(.result.structuredContent.tasks // []) | map(select(.github_issue_number == $num)) | .[0].id // empty')
  [ -n "$task_id" ] && break
  sleep 0.5
done
[ -n "$task_id" ] || die "issue never showed up as an available task (check the backend log)"
pass "task appeared in muster_list_available_tasks ($task_id)"

[ "$(post_hook "$delivery")" = "200" ] \
  && pass "redelivered webhook is deduped on x-github-delivery" \
  || fail "redelivery was not deduped"

step "3. MCP: claim / heartbeat / complete"
claim=$(mcp "$TOKEN_A" muster_claim_task "$(jq -nc --arg t "$task_id" '{task_id:$t}')")
[ "$(echo "$claim" | mcp_iserror)" = "no" ] || fail "lead A could not claim: $(echo "$claim" | mcp_text)"
[ "$(echo "$claim" | jq -r '.result.structuredContent.status // empty')" = "in_progress" ] \
  && pass "lead A claimed the task (status in_progress, lease held)" \
  || fail "claim did not put the task in_progress"

race=$(mcp "$TOKEN_B" muster_claim_task "$(jq -nc --arg t "$task_id" '{task_id:$t}')")
if [ "$(echo "$race" | mcp_iserror)" = "yes" ] && echo "$race" | mcp_text | grep -q 'claimed by smoke-lead-a'; then
  pass "lead B is refused while lead A's lease is live"
else
  fail "second lead was not blocked: $(echo "$race" | mcp_text)"
fi

# Re-claiming your own task is intentionally allowed, so a resumed session is
# not locked out of work it already holds.
reclaim=$(mcp "$TOKEN_A" muster_claim_task "$(jq -nc --arg t "$task_id" '{task_id:$t}')")
[ "$(echo "$reclaim" | mcp_iserror)" = "no" ] \
  && pass "lead A can re-claim its own task (idempotent)" \
  || fail "re-claiming own task failed: $(echo "$reclaim" | mcp_text)"

hb=$(mcp "$TOKEN_A" muster_heartbeat "$(jq -nc --arg t "$task_id" '{task_id:$t,cost_tokens:1234}')")
[ "$(echo "$hb" | mcp_iserror)" = "no" ] \
  && pass "heartbeat extended the lease and recorded token spend" \
  || fail "heartbeat failed: $(echo "$hb" | mcp_text)"

hb_b=$(mcp "$TOKEN_B" muster_heartbeat "$(jq -nc --arg t "$task_id" '{task_id:$t}')")
[ "$(echo "$hb_b" | mcp_iserror)" = "yes" ] \
  && pass "a lead cannot heartbeat a task it does not hold" \
  || fail "lead B heartbeat a task held by lead A"

done_=$(mcp "$TOKEN_A" muster_complete_task \
        "$(jq -nc --arg t "$task_id" --arg u "https://github.com/$REPO/pull/1" \
           '{task_id:$t,status:"review",pr_url:$u,summary:"smoke run"}')")
[ "$(echo "$done_" | mcp_iserror)" = "no" ] \
  && pass "complete_task moved the task to review" \
  || fail "complete failed: $(echo "$done_" | mcp_text)"

step "4. MCP: findings and events"
add=$(mcp "$TOKEN_A" muster_add_finding \
      "$(jq -nc --arg r "$RUN" '{content:("Smoke run " + $r + ": the smoke script exercises the full claim path."),tags:["smoke","tooling"]}')")
[ "$(echo "$add" | mcp_iserror)" = "no" ] \
  && pass "add_finding recorded a finding" || fail "add_finding failed: $(echo "$add" | mcp_text)"

found=$(mcp "$TOKEN_B" muster_search_findings '{"q":"smoke","limit":5}')
[ "$(echo "$found" | jq -r '(.result.structuredContent.findings // []) | length')" -gt 0 ] \
  && pass "lead B can read lead A's finding" || fail "search_findings returned nothing"

events=$(mcp "$TOKEN_A" muster_recent_events '{"since_id":0,"limit":50}')
kinds=$(echo "$events" | jq -r '(.result.structuredContent.events // []) | map(.kind) | unique | join(",")')
for want in task.claimed task.review finding.added; do
  echo "$kinds" | grep -q "$want" && pass "event log contains $want" || fail "event log is missing $want"
done

step "5. admin API: board and event log"
board=$(admin GET "/admin/projects/$PROJECT_ID/board")
row=$(echo "$board" | jq -c --arg t "$task_id" 'map(select(.id == $t)) | .[0] // {}')
[ "$(echo "$row" | jq -r '.status // empty')" = "review" ] \
  && pass "board shows the task in review" || fail "board status is $(echo "$row" | jq -r '.status // "?"')"
[ "$(echo "$row" | jq -r '.cost_tokens // 0')" = "1234" ] \
  && pass "board shows the heartbeat's token spend" \
  || fail "board cost_tokens is $(echo "$row" | jq -r '.cost_tokens // "?"')"

[ "$(admin GET "/admin/projects/$PROJECT_ID/events?since=0" | jq 'length')" -gt 0 ] \
  && pass "admin event log is readable" || fail "admin event log came back empty"

step "6. SSE: the channel's event stream"
# The channel plugin tails this; confirm it authenticates and replays history.
stream=$(curl -sS --max-time 4 -N "$BACKEND_URL/events/stream?since=0" \
         -H "Authorization: Bearer $TOKEN_A" 2>/dev/null || true)
echo "$stream" | grep -q '^event: task.claimed' \
  && pass "SSE stream replays events for the lead's project" \
  || fail "SSE stream did not deliver task.claimed"

[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 4 "$BACKEND_URL/events/stream?since=0" \
     -H 'Authorization: Bearer mstr_not-a-real-token')" = "401" ] \
  && pass "SSE stream rejects an unknown lead token" || fail "SSE stream accepted an unknown token"

# since=latest is what the channel plugin uses on a cold start, so a session
# opening now is not handed the whole project history.
[ "$( { curl -sS --max-time 4 -N "$BACKEND_URL/events/stream?since=latest" \
       -H "Authorization: Bearer $TOKEN_B" 2>/dev/null || true; } | grep -c '^id: ' || true)" = "0" ] \
  && pass "SSE since=latest starts at the end of the log" \
  || fail "SSE since=latest replayed history"

# A reconnecting EventSource sends Last-Event-ID; it must win over the URL's
# ?since= so a dropped stream resumes instead of replaying.
# curl exits non-zero on --max-time, which is the only way an SSE read ends;
# with set -e + pipefail that has to be swallowed explicitly.
last_id=$( { curl -sS --max-time 4 -N "$BACKEND_URL/events/stream?since=0" \
             -H "Authorization: Bearer $TOKEN_B" 2>/dev/null || true; } | sed -n 's/^id: //p' | tail -n 1)
[ -n "$last_id" ] && [ "$( { curl -sS --max-time 4 -N "$BACKEND_URL/events/stream?since=0" \
       -H "Authorization: Bearer $TOKEN_B" -H "Last-Event-ID: $last_id" 2>/dev/null || true; } \
       | grep -c '^id: ' || true)" = "0" ] \
  && pass "SSE Last-Event-ID resumes instead of replaying" \
  || fail "SSE ignored Last-Event-ID"

step "7. backoffice login"
jar="$(mktemp)"
trap 'rm -f "$jar"' RETURN 2>/dev/null || true

[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BACKEND_URL/admin/login" \
     -H 'content-type: application/json' -d '{"password":"not-the-password"}')" = "401" ] \
  && pass "login rejects a wrong password" || fail "login accepted a wrong password"

[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BACKEND_URL/admin/login" -c "$jar" \
     -H 'content-type: application/json' \
     -d "$(jq -nc --arg p "$ADMIN_PASSWORD" '{password:$p}')")" = "200" ] \
  && pass "login accepts the admin password" || fail "login rejected the admin password"

session=$(grep muster_admin "$jar" 2>/dev/null | awk '{print $7}')
[ -n "$session" ] && pass "login sets a session cookie" || fail "login set no session cookie"
grep -q '^#HttpOnly_' "$jar" 2>/dev/null \
  && pass "session cookie is HttpOnly" || fail "session cookie is readable from JS"

[ "$(curl -sS -o /dev/null -w '%{http_code}' "$BACKEND_URL/admin/session" -b "$jar")" = "200" ] \
  && pass "the session cookie authenticates" || fail "the session cookie did not authenticate"

[ "$(curl -sS -o /dev/null -w '%{http_code}' "$BACKEND_URL/admin/session" \
     -H 'Cookie: muster_admin=made-up-session-id')" = "401" ] \
  && pass "a made-up session id is rejected" || fail "a made-up session id was accepted"

curl -sS -o /dev/null -X POST "$BACKEND_URL/admin/logout" -H "Cookie: muster_admin=$session"
[ "$(curl -sS -o /dev/null -w '%{http_code}' "$BACKEND_URL/admin/session" \
     -H "Cookie: muster_admin=$session")" = "401" ] \
  && pass "signing out revokes the session server-side" || fail "the session survived sign out"

[ "$(curl -sS -o /dev/null -w '%{http_code}' "$BACKEND_URL/ui/")" = "200" ] \
  && pass "the backoffice page is served" || fail "the backoffice page is missing"

step "8. revocation"
lead_a_id=$(admin GET "/admin/projects/$PROJECT_ID/leads" | jq -r '.[] | select(.name == "smoke-lead-a") | .id')
admin DELETE "/admin/leads/$lead_a_id" >/dev/null
[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$MCP_URL" \
     -H "Authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')" = "401" ] \
  && pass "a revoked token is rejected on the next MCP call" \
  || fail "revoked token still works"

if [ "$FAILED" -eq 0 ]; then
  printf '\n\033[32msmoke: all checks passed\033[0m\n'
else
  printf '\n\033[31msmoke: there were failures\033[0m\n'
fi
exit "$FAILED"
