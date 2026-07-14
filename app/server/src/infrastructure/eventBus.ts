/**
 * A tiny typed event bus for SseEvent, plus an SseHub that fans events out to
 * connected raw HTTP streams (SSE) with a periodic heartbeat.
 */
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import type { SseEvent } from "@AiDailyTasks/shared";

export class EventBus {
  private emitter = new EventEmitter();

  publish(event: SseEvent): void {
    this.emitter.emit("event", event);
  }

  onEvent(listener: (event: SseEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}

const HEARTBEAT_MS = 20_000;

export class SseHub {
  private clients = new Set<ServerResponse>();
  private heartbeat: NodeJS.Timeout;

  constructor(bus: EventBus) {
    bus.onEvent((event) => this.broadcast(event));
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) this.safeWrite(res, ": ping\n\n");
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  addClient(res: ServerResponse): void {
    this.clients.add(res);
  }

  removeClient(res: ServerResponse): void {
    this.clients.delete(res);
  }

  size(): number {
    return this.clients.size;
  }

  send(res: ServerResponse, event: SseEvent): void {
    this.safeWrite(res, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  broadcast(event: SseEvent): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) this.safeWrite(res, payload);
  }

  private safeWrite(res: ServerResponse, chunk: string): void {
    try {
      if (!res.writableEnded) res.write(chunk);
    } catch {
      this.clients.delete(res);
    }
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
