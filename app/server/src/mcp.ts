/**
 * stdio MCP entrypoint — `npm run mcp` (from the repo root or app/server).
 *
 * A local agent (Claude Desktop / Claude Code / any MCP client) spawns this process
 * and talks MCP over stdin/stdout, managing the same board/ files as the web app —
 * no HTTP server required. Example client config:
 *
 *   { "command": "npm", "args": ["run", "mcp"], "cwd": "C:/Code/AiDailyTaks" }
 *
 * IMPORTANT: stdout is the MCP channel — never write logs there. Diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnv } from "./env";
import { EventBus } from "./infrastructure/eventBus";
import { buildCore } from "./composition";
import { buildMcpServer } from "./interface/mcp/server";

async function main(): Promise<void> {
  const env = loadEnv();
  const bus = new EventBus(); // no HTTP/SSE subscribers in stdio mode; publishes are harmless no-ops
  const { services } = await buildCore(env, bus);
  const server = buildMcpServer(services);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`AiDailyTaks MCP (stdio) ready — board: ${env.boardDir}\n`);
}

main().catch((err) => {
  process.stderr.write(`AiDailyTaks MCP failed to start: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
