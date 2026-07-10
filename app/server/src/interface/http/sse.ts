/**
 * GET /api/events — Server-Sent Events. Hijacks the reply, writes SSE headers to
 * the raw socket, registers the stream in the SseHub, sends a hello event, and
 * cleans up on close. The hub handles heartbeats + broadcasts.
 */
import type { FastifyInstance } from "fastify";
import type { SseHub } from "../../infrastructure/eventBus";

export function registerSse(app: FastifyInstance, hub: SseHub): void {
  app.get("/api/events", (req, reply) => {
    reply.hijack();
    const raw = reply.raw;

    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Prompt the client to establish the stream promptly.
    raw.write(": connected\n\n");

    hub.addClient(raw);
    hub.send(raw, { type: "hello", ts: Date.now() });

    const cleanup = (): void => {
      hub.removeClient(raw);
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
  });
}
