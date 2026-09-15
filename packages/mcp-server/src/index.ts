/**
 * Muster MCP server: stateless Streamable HTTP. Each request is authenticated
 * with a per-lead bearer token issued by the backoffice; tools are scoped to
 * that lead's project. Claude Code leads add it with:
 *   claude mcp add --transport http muster https://muster.example.com/mcp \
 *     --header "Authorization: Bearer <lead-token>"
 */
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticate } from "./auth.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerFindingTools } from "./tools/findings.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => res.send("ok"));

app.post("/mcp", async (req, res) => {
  const lead = await authenticate(req.headers.authorization);
  if (!lead) return res.status(401).json({ error: "invalid or revoked lead token" });

  const server = new McpServer({ name: "muster-mcp-server", version: "0.1.0" });
  registerTaskTools(server, lead);
  registerFindingTools(server, lead);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Stateless mode: no server-initiated streams, no sessions to resume.
app.get("/mcp", (_req, res) => res.status(405).end());
app.delete("/mcp", (_req, res) => res.status(405).end());

const port = Number(process.env.MCP_PORT ?? 8090);
app.listen(port, () => console.log(`muster-mcp-server listening on :${port}`));
