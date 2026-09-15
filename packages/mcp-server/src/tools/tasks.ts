import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { query, emit } from "../db.js";
import type { Lead } from "../auth.js";

const LEASE = Number(process.env.CLAIM_LEASE_SECONDS ?? 1800);

export function registerTaskTools(server: McpServer, lead: Lead) {
  server.registerTool(
    "muster_list_available_tasks",
    {
      title: "List available tasks",
      description:
        "List tasks in this project that are ready, unclaimed (or whose lease expired), and have no unfinished dependencies. Call this before starting new work so you never duplicate a task another lead already claimed.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ limit }) => {
      const rows = await query(
        `SELECT t.id, t.title, t.priority, t.github_repo, t.github_issue_number
         FROM tasks t
         WHERE t.project_id = $1 AND t.status = 'ready'
           AND (t.claimed_by IS NULL OR t.lease_until < now())
           AND NOT EXISTS (SELECT 1 FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on
                           WHERE d.task_id = t.id AND dt.status <> 'done')
         ORDER BY t.priority, t.created_at LIMIT $2`,
        [lead.project_id, limit]
      );
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], structuredContent: { tasks: rows } };
    }
  );

  server.registerTool(
    "muster_claim_task",
    {
      title: "Claim a task",
      description:
        `Atomically claim a task for this lead. Fails if another lead holds an active lease or a dependency is unfinished. Lease defaults to ${LEASE}s; call muster_heartbeat to extend it while working. Always claim before editing files for a task.`,
      inputSchema: { task_id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ task_id }) => {
      const rows = await query("SELECT * FROM claim_task($1,$2,$3) WHERE id IS NOT NULL", [task_id, lead.id, LEASE]);
      if (!rows[0]) {
        const holder = await query(
          `SELECT l.name, t.lease_until, t.status FROM tasks t LEFT JOIN leads l ON l.id = t.claimed_by WHERE t.id = $1`,
          [task_id]);
        const h = holder[0];
        const reason = !h ? "task not found"
          : h.status !== "ready" && h.status !== "in_progress" ? `task status is ${h.status}`
          : h.name ? `claimed by ${h.name} until ${h.lease_until}`
          : "blocked by unfinished dependencies";
        return { content: [{ type: "text", text: `Claim failed: ${reason}. Call muster_list_available_tasks for alternatives.` }], isError: true };
      }
      await emit(lead.project_id, "task.claimed", lead.name, { task_id, title: rows[0].title, lease_until: rows[0].lease_until });
      return { content: [{ type: "text", text: JSON.stringify(rows[0], null, 2) }], structuredContent: rows[0] };
    }
  );

  server.registerTool(
    "muster_heartbeat",
    {
      title: "Extend task lease",
      description: "Extend the lease on a task you hold. Call every few minutes during long work so the task is not reclaimed by another lead.",
      inputSchema: { task_id: z.string().uuid(), cost_tokens: z.number().int().min(0).optional().describe("Tokens spent since last heartbeat, for cost tracking") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ task_id, cost_tokens }) => {
      const rows = await query(
        `UPDATE tasks SET lease_until = now() + make_interval(secs => $3), cost_tokens = cost_tokens + $4
         WHERE id = $1 AND claimed_by = $2 RETURNING lease_until`,
        [task_id, lead.id, LEASE, cost_tokens ?? 0]);
      if (!rows[0]) return { content: [{ type: "text", text: "You do not hold this task." }], isError: true };
      return { content: [{ type: "text", text: `Lease extended to ${rows[0].lease_until}` }] };
    }
  );

  server.registerTool(
    "muster_release_task",
    {
      title: "Release a task",
      description: "Give a claimed task back to the pool without completing it (e.g. blocked or out of scope). Add a note explaining why.",
      inputSchema: { task_id: z.string().uuid(), note: z.string().max(2000) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ task_id, note }) => {
      const rows = await query(
        `UPDATE tasks SET claimed_by = NULL, lease_until = NULL, status = 'ready'
         WHERE id = $1 AND claimed_by = $2 RETURNING title`, [task_id, lead.id]);
      if (!rows[0]) return { content: [{ type: "text", text: "You do not hold this task." }], isError: true };
      await emit(lead.project_id, "task.released", lead.name, { task_id, note });
      return { content: [{ type: "text", text: `Released "${rows[0].title}".` }] };
    }
  );

  server.registerTool(
    "muster_complete_task",
    {
      title: "Complete a task",
      description: "Mark a task you hold as in review (when a PR is opened) or done. Include the PR URL when available; dependent tasks unblock when status becomes done.",
      inputSchema: {
        task_id: z.string().uuid(),
        status: z.enum(["review", "done"]).default("review"),
        pr_url: z.string().url().optional(),
        summary: z.string().max(4000).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ task_id, status, pr_url, summary }) => {
      const rows = await query(
        `UPDATE tasks SET status = $3::task_status, lease_until = NULL
         WHERE id = $1 AND claimed_by = $2 RETURNING title`, [task_id, lead.id, status]);
      if (!rows[0]) return { content: [{ type: "text", text: "You do not hold this task." }], isError: true };
      await emit(lead.project_id, `task.${status}`, lead.name, { task_id, pr_url, summary });
      return { content: [{ type: "text", text: `"${rows[0].title}" -> ${status}.` }] };
    }
  );

  server.registerTool(
    "muster_recent_events",
    {
      title: "Recent project events",
      description: "Read recent coordination events (claims, merges, CI failures, findings) since an event id. Use at the start of a turn if you are not receiving channel pushes.",
      inputSchema: { since_id: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ since_id, limit }) => {
      const rows = await query(
        "SELECT id, kind, actor, payload, created_at FROM events WHERE project_id = $1 AND id > $2 ORDER BY id LIMIT $3",
        [lead.project_id, since_id, limit]);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], structuredContent: { events: rows } };
    }
  );
}
