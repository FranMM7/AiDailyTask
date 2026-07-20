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
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpInfo } from "@AiDailyTasks/shared";
import { buildMcpServer, MCP_TOOL_SUMMARY } from "./server";
import { mcpSessionFailure } from "./sessionLookup";
import type { Services } from "../http/routes";
import type { Env } from "../../env";

/** The URL local agents use to reach the Streamable-HTTP transport. */
export function mcpHttpUrl(env: Env): string {
  return `http://${env.host}:${env.port}/mcp`;
}

export function registerMcpHttp(app: FastifyInstance, services: Services, env: Env): void {
  interface SessionEntry {
    transport: StreamableHTTPServerTransport;
    lastActivity: number;
    openStreams: number;
  }
  const transports = new Map<string, SessionEntry>();
  const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
  const MAX_SESSIONS = 100;

  const closeSession = async (id: string, entry: SessionEntry): Promise<void> => {
    transports.delete(id);
    await entry.transport.close().catch(() => {});
  };
  const reapSessions = (): void => {
    const now = Date.now();
    const idle = [...transports.entries()]
      .filter(([, entry]) => entry.openStreams === 0 && now - entry.lastActivity > SESSION_IDLE_MS)
      .sort((a, b) => a[1].lastActivity - b[1].lastActivity);
    for (const [id, entry] of idle) void closeSession(id, entry);
  };
  const sessionReaper = setInterval(reapSessions, 60_000);
  sessionReaper.unref();

  // Connection details for the in-app Connect page (copy-paste configs).
  app.get("/api/mcp-info", async (_req, reply) => {
    const info: McpInfo = {
      serverName: "AiDailyTasks",
      http: { url: mcpHttpUrl(env) },
      stdio: {
        command: path.join(env.root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx"),
        args: ["src/mcp.ts"],
        cwd: path.join(env.root, "app", "server"),
      },
      tools: MCP_TOOL_SUMMARY,
    };
    reply.send(info);
  });

  app.get("/api/mcp-health", async (_req, reply) => {
    reply.send({
      status: "ok",
      transport: "streamable-http",
      endpoint: mcpHttpUrl(env),
      activeSessions: transports.size,
      sessionLimit: MAX_SESSIONS,
      sessionIdleTimeoutSeconds: SESSION_IDLE_MS / 1000,
      toolCount: MCP_TOOL_SUMMARY.length,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  const sendJsonError = (reply: FastifyReply, code: number, httpStatus: number, message: string): void => {
    reply.raw.writeHead(httpStatus, { "content-type": "application/json" });
    reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
  };

  app.post("/mcp", async (req: FastifyRequest, reply: FastifyReply) => {
    reply.hijack(); // the transport owns the raw response
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let entry = sessionId ? transports.get(sessionId) : undefined;
      let transport = entry?.transport;
      const sessionFailure = mcpSessionFailure(
        sessionId,
        Boolean(transport),
        isInitializeRequest(req.body),
      );
      if (sessionFailure) {
        sendJsonError(reply, sessionFailure.code, sessionFailure.httpStatus, sessionFailure.message);
        return;
      }

      if (!transport) {
        reapSessions();
        if (transports.size >= MAX_SESSIONS) {
          sendJsonError(reply, -32000, 503, "MCP session limit reached — retry after closing an existing session.");
          return;
        }
        // New session: mint an id, register on init, clean up on close.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            entry = { transport: transport as StreamableHTTPServerTransport, lastActivity: Date.now(), openStreams: 0 };
            transports.set(sid, entry);
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) transports.delete(transport.sessionId);
        };
        const server = buildMcpServer(services);
        await server.connect(transport);
      }
      if (entry) entry.lastActivity = Date.now();
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
    const entry = sessionId ? transports.get(sessionId) : undefined;
    const sessionFailure = mcpSessionFailure(sessionId, Boolean(entry), false);
    if (sessionFailure) {
      sendJsonError(reply, sessionFailure.code, sessionFailure.httpStatus, sessionFailure.message);
      return;
    }
    // The classifier guarantees an entry when no failure is returned.
    if (!entry || !sessionId) return;
    entry.lastActivity = Date.now();
    if (req.method === "GET") entry.openStreams += 1;
    try {
      await entry.transport.handleRequest(req.raw, reply.raw);
      if (req.method === "DELETE" && sessionId) transports.delete(sessionId);
    } finally {
      if (req.method === "GET") {
        entry.openStreams = Math.max(0, entry.openStreams - 1);
        entry.lastActivity = Date.now();
      }
    }
  };
  app.get("/mcp", handleSession);
  app.delete("/mcp", handleSession);
}
