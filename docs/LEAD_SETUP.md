# Onboarding a developer's lead session

1. Admin issues a token: `POST /admin/projects/:id/leads {"name":"alice-laptop","expires_in_days":30}`.
   The plaintext `mstr_...` is returned exactly once; only its hash is stored.
2. Developer registers the MCP tools server:
   `claude mcp add --transport http muster https://<mcp-host>/mcp --header "Authorization: Bearer mstr_..."`
3. Developer installs the channel plugin so events are pushed into the session
   rather than polled for. It is a separate MCP server from step 2 and must have
   a different name — `muster` is already taken by the tools server:

   ```json
   // .mcp.json
   {
     "mcpServers": {
       "muster-channel": {
         "command": "node",
         "args": ["/abs/path/to/muster/packages/channel/dist/index.js"],
         "env": {
           "MUSTER_BACKEND_URL": "https://<backend-host>",
           "MUSTER_LEAD_TOKEN": "mstr_..."
         }
       }
     }
   }
   ```

   Channels are a research preview and custom ones are not on the approved
   allowlist, so start Claude Code with:

   ```bash
   claude --dangerously-load-development-channels server:muster-channel
   ```

   Events then arrive in context as
   `<channel source="muster-channel" kind="pr.merged" event_id="…" actor="github">`.
   See `packages/channel/README.md` for the full contract and troubleshooting.
4. Ensure the project `CLAUDE.md` contains the claim/heartbeat/complete protocol.
   Paste `docs/CLAUDE_MD_SNIPPET.md` into it.
5. Enable agent teams as usual (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Only the lead needs the Muster token; teammates coordinate through the lead's task list and messages.

Without the channel the session still works: it just has to ask. `muster_recent_events`
is the catch-up path, and the `CLAUDE.md` snippet tells the lead to call it at
the start of a turn.

Revoke at any time: `DELETE /admin/leads/:id`. The MCP server and the event
stream both reject the token on the next call.

## On Team and Enterprise plans

Channels stay off until an Owner enables them (claude.ai → Admin settings →
Claude Code → Channels, or `channelsEnabled` in managed settings). Until then the
MCP tools still work and only the pushes go missing, which is worth telling
developers so they do not debug the plugin.
