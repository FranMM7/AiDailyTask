/**
 * Composition root: wire config -> repo + bus + watcher + services, build the
 * Fastify app, register CORS/multipart/routes/SSE/static, start the watcher and
 * listen on 127.0.0.1:PORT.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { watch } from "chokidar";
import { loadEnv } from "./env";
import { buildCore } from "./composition";
import { EventBus, SseHub } from "./infrastructure/eventBus";
import { BoardWatcher } from "./infrastructure/watcher";
import { registerRoutes } from "./interface/http/routes";
import { registerSse } from "./interface/http/sse";
import { registerStatic } from "./interface/http/static";
import { registerMcpHttp, mcpHttpUrl } from "./interface/mcp/http";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB per file

async function main(): Promise<void> {
  const env = loadEnv();

  const bus = new EventBus();
  const hub = new SseHub(bus);
  const { config, recentWrites, repo, services } = await buildCore(env, bus);
  const watcher = new BoardWatcher(env, repo, bus, recentWrites);

  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 20 },
  });

  registerRoutes(app, services);
  registerSse(app, hub);
  registerMcpHttp(app, services, env);
  await registerStatic(app, env);

  watcher.start();

  // Watch the two root config files so a hand-edit (or the model editing projects.json)
  // pushes a `config.updated` to the browser. board.config.json also triggers a reload so
  // vocabulary/color changes take effect without a restart.
  const configWatcher = watch([env.configPath, env.projectsPath], {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 80 },
    ignored: (p: string) => /\.tmp-/.test(p),
  });
  const onConfigChange = (changed: string): void => {
    if (changed === env.configPath) {
      try {
        config.reload();
      } catch (err) {
        app.log.error({ err }, "board.config.json reload failed — keeping previous config");
      }
    }
    bus.publish({ type: "config.updated" });
  };
  configWatcher.on("add", onConfigChange).on("change", onConfigChange).on("unlink", onConfigChange);

  // Auto-archive sweep: once at startup, then every 6 hours. Completed tasks whose `completed`
  // date is older than the configured window get archived (hidden from Board/Table/Graph, kept
  // in the Archive view). Runs through repo.setArchived, so each write pushes an SSE update.
  const archiveDays = config.autoArchiveDays;
  const runArchiveSweep = async (): Promise<void> => {
    try {
      const n = await services.tasks.archiveStale(archiveDays);
      if (n > 0) app.log.info(`Auto-archived ${n} task(s) completed more than ${archiveDays} days ago`);
    } catch (err) {
      app.log.error({ err }, "Auto-archive sweep failed");
    }
  };
  void runArchiveSweep();
  const archiveTimer = setInterval(() => void runArchiveSweep(), 6 * 60 * 60 * 1000);
  archiveTimer.unref();

  const shutdown = async (): Promise<void> => {
    app.log.info("Shutting down…");
    clearInterval(archiveTimer);
    await configWatcher.close();
    await watcher.stop();
    hub.close();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  try {
    await app.listen({ port: env.port, host: env.host });
    app.log.info(`AiDailyTasks server on http://${env.host}:${env.port}  (root: ${env.root})`);
    app.log.info(`MCP (Streamable HTTP) ready at ${mcpHttpUrl(env)}  ·  stdio: npm run mcp`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
