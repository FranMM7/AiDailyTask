/**
 * Mounts the MCP server on the Fastify router over the Streamable-HTTP transport at
 * /mcp — the "give the agent access on the router" option. Any MCP client that speaks
 * Streamable HTTP can point at http://127.0.0.1:<port>/mcp.
 *
 * Stateful sessions (the pattern every Streamable-HTTP client supports): an `initialize`
 * POST opens a session (server mints an `mcp-session-id`); the client echoes that header on
 * later POSTs (JSON-RPC calls), GET (server→client SSE stream) and DELETE (teardown). Each
 * session gets its own McpServer + transport, kept in `transports` until closed.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpInfo } from "@AiDailyTaks/shared";
import { buildMcpServer, MCP_TOOL_SUMMARY } from "./server";
import type { Services } from "../http/routes";
import type { Env } from "../../env";

/** The URL local agents use to reach the Streamable-HTTP transport. */
export function mcpHttpUrl(env: Env): string {
  return `http://${env.host}:${env.port}/mcp`;
}

export function registerMcpHttp(app: FastifyInstance, services: Services, env: Env): void {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Connection details for the in-app Connect page (copy-paste configs).
  app.get("/api/mcp-info", async (_req, reply) => {
    const info: McpInfo = {
      serverName: "AiDailyTaks",
      http: { url: mcpHttpUrl(env) },
      stdio: { command: "npm", args: ["run", "mcp"], cwd: env.root },
      tools: MCP_TOOL_SUMMARY,
    };
    reply.send(info);
  });

  const sendJsonError = (reply: FastifyReply, code: number, httpStatus: number, message: string): void => {
    reply.raw.writeHead(httpStatus, { "content-type": "application/json" });
    reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
  };

  app.post("/mcp", async (req: FastifyRequest, reply: FastifyReply) => {
    reply.hijack(); // the transport owns the raw response
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        if (sessionId || !isInitializeRequest(req.body)) {
          sendJsonError(reply, -32000, 400, "No valid session — send an initialize request first.");
          return;
        }
        // New session: mint an id, register on init, clean up on close.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport as StreamableHTTPServerTransport);
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) transports.delete(transport.sessionId);
        };
        const server = buildMcpServer(services);
        await server.connect(transport);
      }
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      app.log.error({ err }, "MCP POST failed");
      if (!reply.raw.headersSent) sendJsonError(reply, -32603, 500, "Internal MCP error");
    }
  });

  // GET = server→client SSE stream; DELETE = end session. Both require an existing session.
  const handleSession = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.hijack();
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      sendJsonError(reply, -32000, 400, "Invalid or missing mcp-session-id.");
      return;
    }
    await transport.handleRequest(req.raw, reply.raw);
  };
  app.get("/mcp", handleSession);
  app.delete("/mcp", handleSession);
}
