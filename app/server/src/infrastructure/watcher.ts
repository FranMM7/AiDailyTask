/**
 * Watches board/ for direct file edits (Claude editing task.md, or files/ changes)
 * and broadcasts SSE events. Self-writes are suppressed via RecentWrites so the
 * server never reacts to its own writes (no loops). The watcher NEVER writes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { normalizeId } from "@AiDailyTaks/shared";
import type { Env } from "../env";
import type { FsTaskRepository } from "./taskRepository";
import type { EventBus } from "./eventBus";
import type { RecentWrites } from "./recentWrites";

const ID_DIR_RE = /^C\d+$/;

/** Given an absolute path under board/, classify it. */
function classify(env: Env, filePath: string): { id: string; kind: "task" | "attachment" } | null {
  const rel = path.relative(env.boardDir, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]/);
  const dir = parts[0];
  if (!dir || !ID_DIR_RE.test(dir)) return null;
  const id = normalizeId(dir);
  if (parts.length === 2 && parts[1] === "task.md") return { id, kind: "task" };
  if (parts.length >= 3 && parts[1] === "files") return { id, kind: "attachment" };
  return null;
}

export class BoardWatcher {
  private watcher: FSWatcher | null = null;
  private debounce = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly env: Env,
    private readonly repo: FsTaskRepository,
    private readonly bus: EventBus,
    private readonly recentWrites: RecentWrites,
  ) {}

  start(): void {
    if (this.watcher) return;
    this.watcher = watch(this.env.boardDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
      ignored: (p: string) => /task\.md\.tmp-/.test(p),
    });
    this.watcher
      .on("add", (p) => this.onTaskChange(p))
      .on("change", (p) => this.onTaskChange(p))
      .on("unlink", (p) => this.onUnlink(p))
      .on("addDir", (p) => this.maybeAttachment(p))
      .on("unlinkDir", (p) => this.maybeAttachment(p));
  }

  private schedule(key: string, fn: () => void, ms = 120): void {
    const existing = this.debounce.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.debounce.delete(key);
      void fn();
    }, ms);
    t.unref();
    this.debounce.set(key, t);
  }

  private maybeAttachment(p: string): void {
    const info = classify(this.env, p);
    if (info?.kind === "attachment") {
      this.schedule(`att:${info.id}`, () => this.bus.publish({ type: "attachments.changed", id: info.id }));
    }
  }

  private onTaskChange(p: string): void {
    const info = classify(this.env, p);
    if (!info) return;
    if (info.kind === "attachment") {
      this.maybeAttachment(p);
      return;
    }
    this.schedule(`task:${info.id}`, async () => {
      // Suppress self-writes: if this exact (path, mtime) was written by us, skip.
      try {
        const st = await fs.stat(p);
        if (this.recentWrites.has(p, st.mtimeMs)) return;
      } catch {
        return; // file vanished; an unlink event will handle it
      }
      try {
        const detail = await this.repo.read(info.id);
        if (detail.valid) {
          const summary = await this.summaryFor(info.id);
          if (summary) this.bus.publish({ type: "task.updated", id: info.id, task: summary, rev: detail.rev });
        } else {
          this.bus.publish({ type: "task.invalid", id: info.id, parseError: detail.parseError });
        }
      } catch {
        /* transient read error; ignore */
      }
    });
  }

  private async summaryFor(id: string) {
    const summaries = await this.repo.listSummaries();
    const found = summaries.find((s) => s.id === id && s.valid);
    return found && found.valid ? found : null;
  }

  private onUnlink(p: string): void {
    const info = classify(this.env, p);
    if (!info) return;
    if (info.kind === "task") {
      this.schedule(`task:${info.id}`, () => this.bus.publish({ type: "task.deleted", id: info.id }));
    } else {
      this.maybeAttachment(p);
    }
  }

  async stop(): Promise<void> {
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
