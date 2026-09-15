import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { query, emit } from "../db.js";
import type { Lead } from "../auth.js";

/**
 * Full text first, substring second.
 *
 * `websearch_to_tsquery` handles the way a lead actually asks — quoted phrases,
 * `or`, a leading `-` to exclude — and stems, so "failing tests" finds "the
 * test suite fails". It is useless for the other half of what agents search
 * for, though: `ENOSPC`, `--no-sandbox`, a port number. Those get tokenised
 * away or stemmed into nothing, so when full text returns too little we also
 * run the old substring match, which a trigram index now serves.
 *
 * Both are unioned rather than chained so one good full-text hit never hides a
 * literal match, and rank orders the result.
 */
async function searchFindings(projectId: string, q: string, limit: number) {
  return query(
    `WITH fts AS (
       SELECT f.id, ts_rank(f.search, websearch_to_tsquery('english', $2)) AS rank
       FROM findings f
       WHERE f.project_id = $1 AND f.search @@ websearch_to_tsquery('english', $2)
     ),
     literal AS (
       SELECT f.id, 0.0::real AS rank
       FROM findings f
       WHERE f.project_id = $1
         AND (f.content ILIKE '%' || $2 || '%' OR lower($2) = ANY(SELECT lower(t) FROM unnest(f.tags) t))
     ),
     hits AS (
       SELECT id, max(rank) AS rank FROM (SELECT * FROM fts UNION ALL SELECT * FROM literal) u
       GROUP BY id
     )
     SELECT f.id, f.tags, f.content, f.created_at, l.name AS lead
     FROM hits h
     JOIN findings f ON f.id = h.id
     LEFT JOIN leads l ON l.id = f.lead_id
     ORDER BY h.rank DESC, f.created_at DESC
     LIMIT $3`,
    [projectId, q, limit]);
}

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
      description: "Full-text search over findings shared by all leads in this project. Check here before debugging environment or tooling problems. Supports quoted phrases, OR, and a leading - to exclude; exact strings like an error code or a flag also match literally.",
      inputSchema: { q: z.string().min(2).max(200), limit: z.number().int().min(1).max(50).default(10) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ q, limit }) => {
      const rows = await searchFindings(lead.project_id, q, limit);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], structuredContent: { findings: rows } };
    }
  );
}
