# Onboarding a developer's lead session

1. Admin issues a token: `POST /admin/projects/:id/leads {"name":"alice-laptop","expires_in_days":30}`.
2. Developer registers the MCP server:
   `claude mcp add --transport http muster https://<mcp-host>/mcp --header "Authorization: Bearer mstr_..."`
3. Developer installs the channel plugin (research preview; see packages/channel) and runs Claude Code with
   `MUSTER_BACKEND_URL` / `MUSTER_LEAD_TOKEN` set.
4. Ensure the project `CLAUDE.md` contains the claim/heartbeat/complete protocol (see README).
5. Enable agent teams as usual (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Only the lead needs the Muster token; teammates coordinate through the lead's task list and messages.

Revoke at any time: `DELETE /admin/leads/:id`. The MCP server rejects the token on the next call.
