/**
 * Serves the built web UI (app/web/dist) if present, with SPA fallback: any
 * non-/api GET that doesn't map to a file returns index.html. Non-GET or /api
 * misses return the JSON error envelope.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Env } from "../../env";
import type { ApiError } from "@AiDailyTasks/shared";

function notFoundEnvelope(url: string): ApiError {
  return { error: { code: "not_found", message: `No route for ${url}` } };
}

export async function registerStatic(app: FastifyInstance, env: Env): Promise<void> {
  const indexPath = path.join(env.webDistDir, "index.html");
  const hasBuild = existsSync(indexPath);

  if (hasBuild) {
    await app.register(fastifyStatic, {
      root: env.webDistDir,
      prefix: "/",
      wildcard: false, // exact-file routes only, so /api/* misses fall through to us
      index: ["index.html"],
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (hasBuild && req.method === "GET" && !req.url.startsWith("/api")) {
      // SPA fallback (reply.sendFile is provided by @fastify/static).
      reply.type("text/html");
      return (reply as unknown as { sendFile: (f: string) => unknown }).sendFile("index.html");
    }
    reply.code(404).send(notFoundEnvelope(req.url));
    return reply;
  });
}
