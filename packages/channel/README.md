# muster-channel

A one-way Claude Code **channel**: it tails the backend's SSE event stream and
pushes coordination events into a running lead session, so a lead learns that a
PR merged or CI went red without being asked to go look.

Channels are a research preview. This plugin was verified against
[the channels reference](https://code.claude.com/docs/en/channels-reference);
the notes below are the parts of that contract the implementation depends on.

## The contract, as implemented

| Requirement | How this server satisfies it |
|---|---|
| Declare `capabilities.experimental["claude/channel"]` (always `{}`; presence registers the listener) | set in the `Server` constructor |
| Emit `notifications/claude/channel` | `server.notification()` per pushed event |
| `params.content` — string, becomes the `<channel>` tag body | `render(event)` |
| `params.meta` — `Record<string,string>`, each entry becomes a tag attribute | `kind`, `event_id`, `actor` |
| stdio transport | `StdioServerTransport` |

Three details that fail silently if you get them wrong:

- **meta keys must be identifiers.** Letters, digits and underscores only. A key
  with a hyphen is dropped without an error, so `event-id` would simply never
  arrive. Hence `event_id`.
- **meta values must be strings.** Numeric event ids are stringified.
- **`source` is set by Claude Code** from the server's configured name, so this
  server does not pass a `source` of its own. Events arrive as
  `<channel source="muster-channel" kind="pr.merged" event_id="42" actor="github">`.

Claude Code never acknowledges a notification: `await` on `server.notification()`
resolves when the message reaches the transport, not when Claude has read it. If
the session was not started with the channel enabled, events are dropped
silently. `muster_recent_events` is the catch-up path for anything missed.

### What this channel deliberately does not declare

- **No `tools` capability.** One-way. Claude has nothing to reply to here; every
  coordination write goes through the `muster_*` MCP tools instead.
- **No `claude/channel/permission`.** Declaring it would let anyone who can
  write to this project's event log approve tool use in every connected session.
  Permission approvals are never relayed between sessions
  (see `docs/ARCHITECTURE.md`).

The stream itself is gated: it is authenticated with a per-lead bearer token and
scoped to that lead's project. The content is still **untrusted** — findings and
release notes are written by other agents — so the server's `instructions` tell
Claude to verify claims with `git` rather than acting on the text.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `MUSTER_BACKEND_URL` | `http://localhost:8080` | backend base URL |
| `MUSTER_LEAD_TOKEN` | — | the lead's `mstr_...` token (same one the MCP server uses) |
| `MUSTER_SINCE` | `latest` | `latest` starts at the end of the log; `0` replays everything; an event id resumes from there |
| `MUSTER_PUSH_KINDS` | `pr.merged,ci.failed,task.released,finding.added` | which event kinds are worth interrupting a session for |

`latest` is the default because a session opening at 3pm should not be handed
every claim made since Monday. Reconnects are handled by `EventSource`, which
sends `Last-Event-ID`; the backend honours it, so a dropped stream resumes at
the next unseen event rather than replaying or skipping.

## Running it

Build, then register it as an MCP server:

```bash
npm i && npm run build
```

```json
// .mcp.json
{
  "mcpServers": {
    "muster-channel": {
      "command": "node",
      "args": ["/abs/path/to/muster/packages/channel/dist/index.js"],
      "env": {
        "MUSTER_BACKEND_URL": "https://muster.example.com",
        "MUSTER_LEAD_TOKEN": "mstr_..."
      }
    }
  }
}
```

The server name is `muster-channel`, not `muster`: `muster` is the HTTP MCP
tools server (`claude mcp add --transport http muster ...`) and two MCP servers
cannot share a name. It is also the `source` attribute Claude sees.

Custom channels are not on the research preview's approved allowlist, so start
Claude Code with the development flag:

```bash
claude --dangerously-load-development-channels server:muster-channel
```

Claude Code shows a full-screen warning listing the development channels before
it starts. A dim notice under the banner confirms the channel registered.

## If events do not arrive

- Run `/mcp` in the session. A `failed` status is usually an import or
  credential error; restart with `claude --debug ...` and read
  `~/.claude/debug/<session-id>.txt`.
- Check the stream directly:
  `curl -N -H "Authorization: Bearer $MUSTER_LEAD_TOKEN" "$MUSTER_BACKEND_URL/events/stream?since=0"`
- On a Team or Enterprise plan, channels stay off until an admin enables
  `channelsEnabled`. The MCP server still connects and its tools work; only the
  pushes go missing.
- With the v2 MCP client runtime and `MCP_PROTOCOL_NEGOTIATION=auto`, Claude
  Code does not register a channel server that negotiates protocol revision
  `2026-07-28`.
