/**
 * Watches board/ for direct file edits (an agent editing a task file, or files/
 * changes) and broadcasts SSE events. Both storage formats are watched: task.md
 * for legacy tasks, task.json + observations.jsonl for structured ones.
 * Self-writes are suppressed via RecentWrites so the server never reacts to its
 * own writes (no loops). The watcher NEVER writes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { normalizeId } from "@AiDailyTasks/shared";
import { OBSERVATIONS_FILE, TASK_JSON_FILE, TASK_MARKDOWN_FILE } from "../domain/structuredTask";
import type { Env } from "../env";
import type { FsTaskRepository } from "./taskRepository";
import type { EventBus } from "./eventBus";
import type { RecentWrites } from "./recentWrites";

const ID_DIR_RE = /^C\d+$/;
/** Any of these changing means the task changed, whichever format backs it. */
const TASK_FILES: readonly string[] = [TASK_MARKDOWN_FILE, TASK_JSON_FILE, OBSERVATIONS_FILE];

/** Given an absolute path under board/, classify it. */
function classify(env: Env, filePath: string): { id: string; kind: "task" | "attachment" } | null {
  const rel = path.relative(env.boardDir, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]/);
  const dir = parts[0];
  if (!dir || !ID_DIR_RE.test(dir)) return null;
  const id = normalizeId(dir);
  if (parts.length === 2 && TASK_FILES.includes(parts[1])) return { id, kind: "task" };
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
      // Atomic writes land as `<name>.tmp-<nanoid>` siblings before the rename.
      ignored: (p: string) => {
        const relative = path.relative(this.env.boardDir, p).split(path.sep).join("/");
        // Write locks are rapidly created/removed by HTTP and stdio. Watching them
        // can race Windows realpath and crash chokidar; they carry no board content.
        return relative === "_meta/runtime" || relative.startsWith("_meta/runtime/")
          || /\.(?:tmp|migration)-[A-Za-z0-9_-]+$/.test(p);
      },
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
    if (info.kind !== "task") {
      this.maybeAttachment(p);
      return;
    }
    // Removing one representation does not delete the task — dropping legacy
    // task.md after a migration leaves task.json in charge. Only report a
    // deletion once no format remains readable.
    this.schedule(`task:${info.id}`, async () => {
      try {
        const detail = await this.repo.read(info.id);
        if (detail.valid) {
          const summary = await this.summaryFor(info.id);
          if (summary) this.bus.publish({ type: "task.updated", id: info.id, task: summary, rev: detail.rev });
        } else {
          this.bus.publish({ type: "task.invalid", id: info.id, parseError: detail.parseError });
        }
      } catch {
        this.bus.publish({ type: "task.deleted", id: info.id });
      }
    });
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
