import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { query, emit } from "../db.js";
import type { Lead } from "../auth.js";

export function registerFindingTools(server: McpServer, lead: Lead) {
  server.registerTool(
    "muster_add_finding",
    {
      title: "Share a finding",
      description: "Record a discovery useful to other leads (env quirks, flaky tests, gotchas, decisions). Keep it short and factual. Other leads see it via muster_search_findings and channel pushes.",
      inputSchema: { content: z.string().min(10).max(4000), tags: z.array(z.string()).max(10).default([]), task_id: z.string().uuid().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ content, tags, task_id }) => {
      const rows = await query(
        "INSERT INTO findings (project_id, task_id, lead_id, tags, content) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [lead.project_id, task_id ?? null, lead.id, tags, content]);
      await emit(lead.project_id, "finding.added", lead.name, { finding_id: rows[0].id, tags, content });
      return { content: [{ type: "text", text: `Finding recorded (${rows[0].id}).` }] };
    }
  );

  server.registerTool(
    "muster_search_findings",
    {
      title: "Search findings",
      description: "Full-text search over findings shared by all leads in this project. Check here before debugging environment or tooling problems.",
      inputSchema: { q: z.string().min(2).max(200), limit: z.number().int().min(1).max(50).default(10) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ q, limit }) => {
      const rows = await query(
        `SELECT f.id, f.tags, f.content, f.created_at, l.name AS lead
         FROM findings f LEFT JOIN leads l ON l.id = f.lead_id
         WHERE f.project_id = $1 AND (f.content ILIKE '%' || $2 || '%' OR $2 = ANY(f.tags))
         ORDER BY f.created_at DESC LIMIT $3`, [lead.project_id, q, limit]);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], structuredContent: { findings: rows } };
    }
  );
}
