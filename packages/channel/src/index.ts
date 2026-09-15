#!/usr/bin/env node
/**
 * Muster channel: a stdio MCP server that tails the backend's SSE event stream
 * and pushes each event into the running Claude Code session as a
 * notifications/claude/channel notification.
 *
 * Channels are a research preview. The exact capability name and notification
 * shape are documented at https://code.claude.com/docs/en/channels — verify
 * against your Claude Code version before relying on this. Until this plugin is
 * loaded via the sanctioned path, run:
 *   claude --dangerously-load-development-channels server:muster
 *
 * Env: MUSTER_BACKEND_URL, MUSTER_LEAD_TOKEN
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EventSource } from "eventsource";

const backend = process.env.MUSTER_BACKEND_URL ?? "http://localhost:8080";
const token = process.env.MUSTER_LEAD_TOKEN ?? "";

const server = new Server(
  { name: "muster-channel", version: "0.1.0" },
  { capabilities: { experimental: { "claude/channel": {} } } }
);

// Events most worth interrupting a session for. Everything else is available
// on demand via muster_recent_events.
const PUSH_KINDS = new Set(["pr.merged", "ci.failed", "task.released", "finding.added"]);

function render(e: any): string {
  const p = e.payload ?? {};
  switch (e.kind) {
    case "pr.merged":   return `PR #${p.number} merged into ${p.base} (${p.repo}): "${p.title}". ${p.hint}`;
    case "ci.failed":   return `CI ${p.conclusion} on ${p.branch} (${p.repo}, ${String(p.sha).slice(0, 7)}). Hold new PRs until main is green.`;
    case "task.released": return `Task ${p.task_id} released back to the pool by ${e.actor}: ${p.note}`;
    case "finding.added": return `Finding from ${e.actor} [${(p.tags ?? []).join(", ")}]: ${p.content}`;
    default: return `${e.kind} by ${e.actor}: ${JSON.stringify(p)}`;
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const es = new EventSource(`${backend}/events/stream?since=0`, {
    fetch: (url: any, init: any) => fetch(url, { ...init, headers: { ...(init?.headers as any), Authorization: `Bearer ${token}` } })
  } as any);
  es.onmessage = () => {};
  for (const kind of PUSH_KINDS) {
    es.addEventListener(kind, async (ev: any) => {
      const e = JSON.parse(ev.data);
      await server.notification({
        method: "notifications/claude/channel",
        params: {
          content: render(e),
          meta: { source: "muster", kind: e.kind, event_id: String(e.id), actor: e.actor }
        }
      } as any);
    });
  }
  es.onerror = (err: any) => console.error("muster-channel stream error", err?.message ?? err);
}

main().catch(err => { console.error(err); process.exit(1); });
