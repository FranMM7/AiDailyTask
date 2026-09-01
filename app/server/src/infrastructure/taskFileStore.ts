/**
 * The board's file-format boundary.
 *
 * Two on-disk representations of a task are supported and every filesystem read
 * or write in the repository goes through here, so the rest of the server never
 * branches on the format:
 *
 *   markdown    board/<ID>/task.md          (legacy: frontmatter + body + ## Observations)
 *   structured  board/<ID>/task.json        (frontmatter + body sections, no history)
 *               board/<ID>/observations.jsonl  (one validated record per line)
 *
 * A task document here deliberately EXCLUDES observations. That is the whole
 * point of the structured format: rendering the board list or patching a field
 * must not read, parse, or rewrite a growing activity log. Callers that want
 * history ask for it explicitly and get a bounded page.
 *
 * `rev` keeps the meaning it always had — an opaque revision token compared for
 * optimistic concurrency. For markdown it is task.md's mtime; for structured it
 * is the newer of the two files' mtimes, so appending an observation still
 * moves the revision forward.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import { nanoid } from "nanoid";
import type { Frontmatter, Observation } from "@AiDailyTasks/shared";
import {
  type ParsedBody,
  getSection,
  parseObservations,
  parseTaskFile,
  serializeTaskFile,
  setSection,
} from "../domain/task";
import {
  type StoredObservation,
  OBSERVATIONS_FILE,
  TASK_JSON_FILE,
  TASK_MARKDOWN_FILE,
  historyStamp,
  newObservationId,
  parseStructuredTask,
  renderStructuredTaskMarkdown,
  serializeObservationJsonl,
  serializeStructuredTask,
} from "../domain/structuredTask";
import type { RecentWrites } from "./recentWrites";

/**
 * `auto` — read whichever format a task is stored in, preferring task.json when
 * both exist, and create new tasks as JSON once any task has been migrated.
 * The explicit modes force one format and are the escape hatch for a rollback.
 */
export type TaskStoreMode = "auto" | "markdown" | "json";
export type TaskFormat = "markdown" | "structured";

export const TASK_STORE_MODES: readonly TaskStoreMode[] = ["auto", "markdown", "json"];

export function isTaskStoreMode(value: string): value is TaskStoreMode {
  return (TASK_STORE_MODES as readonly string[]).includes(value);
}

/** A task's metadata and body sections, without its observation history. */
export interface TaskDocument {
  ok: true;
  format: TaskFormat;
  frontmatter: Frontmatter;
  /** Body sections excluding Observations. */
  body: ParsedBody;
  rev: number;
  /**
   * How many observations the task has. Resolved during the load so the board
   * list gets it for free rather than opening the history file per task.
   */
  observationCount: number;
}

export interface TaskDocumentError {
  ok: false;
  format: TaskFormat;
  rev: number;
  error: string;
  rawFrontmatter?: string;
  rawBody?: string;
}

export type TaskDocumentResult = TaskDocument | TaskDocumentError;

export interface ObservationSlice {
  observations: Observation[];
  /** Cursor for the next older page, or null when the oldest entry is included. */
  nextCursor: string | null;
  total: number;
}

/** Everything a single write may change, applied as one atomic revision. */
export interface SaveRequest {
  frontmatter: Frontmatter;
  /** Body sections excluding Observations; whatever is passed replaces what is stored. */
  body: ParsedBody;
  /** Appended to the end of the history, in order. */
  appendObservations?: Observation[];
  /**
   * The observation count the caller last read, from the document it is saving.
   * Supplying it keeps an append O(1): the new stamp is derived by addition
   * instead of re-reading the whole history to recount it. Omit it and the
   * store counts for real.
   */
  previousObservationCount?: number;
}

const OBSERVATIONS_HEADING = "Observations";

function withoutObservations(body: ParsedBody): ParsedBody {
  return {
    preamble: body.preamble,
    sections: body.sections.filter((section) => section.heading.toLowerCase() !== OBSERVATIONS_HEADING.toLowerCase()),
  };
}

function renderObservationSection(observations: readonly Observation[]): string {
  return observations
    .map((observation) => `### ${observation.at} — ${observation.author}\n\n${observation.markdown}`)
    .join("\n\n");
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export class TaskNotFoundInStoreError extends Error {}

export class TaskFileStore {
  constructor(
    private readonly boardDir: string,
    private readonly mode: TaskStoreMode,
    private readonly recentWrites: RecentWrites,
  ) {}

  // ── Paths ──────────────────────────────────────────────────────────────────
  dir(id: string): string {
    return path.join(this.boardDir, id);
  }
  markdownFile(id: string): string {
    return path.join(this.dir(id), TASK_MARKDOWN_FILE);
  }
  jsonFile(id: string): string {
    return path.join(this.dir(id), TASK_JSON_FILE);
  }
  observationsFile(id: string): string {
    return path.join(this.dir(id), OBSERVATIONS_FILE);
  }

  /** The format a NEW task is written in. */
  get writeFormat(): TaskFormat {
    return this.mode === "markdown" ? "markdown" : "structured";
  }

  /**
   * In `auto`, a board with no migrated tasks yet must keep creating Markdown —
   * otherwise the first new task after an upgrade silently changes format.
   */
  async newTaskFormat(): Promise<TaskFormat> {
    if (this.mode === "json") return "structured";
    if (this.mode === "markdown") return "markdown";
    return (await this.anyStructured()) ? "structured" : "markdown";
  }

  private structuredSeen: boolean | null = null;
  private async anyStructured(): Promise<boolean> {
    if (this.structuredSeen !== null) return this.structuredSeen;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.boardDir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await fs.access(path.join(this.boardDir, entry.name, TASK_JSON_FILE));
        this.structuredSeen = true;
        return true;
      } catch {
        /* keep looking */
      }
    }
    this.structuredSeen = false;
    return false;
  }

  // ── Format resolution ──────────────────────────────────────────────────────
  /** Which format this task is actually stored in, or null when it does not exist. */
  async formatOf(id: string): Promise<TaskFormat | null> {
    if (this.mode !== "markdown") {
      try {
        await fs.access(this.jsonFile(id));
        return "structured";
      } catch {
        if (this.mode === "json") return null;
      }
    }
    try {
      await fs.access(this.markdownFile(id));
      return "markdown";
    } catch {
      return null;
    }
  }

  /** Revision token, or null when the task does not exist. */
  async rev(id: string): Promise<number | null> {
    const format = await this.formatOf(id);
    if (format === null) return null;
    return this.revFor(id, format);
  }

  private async revFor(id: string, format: TaskFormat): Promise<number> {
    if (format === "markdown") return (await fs.stat(this.markdownFile(id))).mtimeMs;
    const [task, observations] = await Promise.all([fs.stat(this.jsonFile(id)), this.statHistory(id)]);
    // The history file is created lazily, so a task with no observations yet is
    // revisioned by task.json alone.
    return Math.max(task.mtimeMs, observations?.mtimeMs ?? 0);
  }

  // ── Read ───────────────────────────────────────────────────────────────────
  /**
   * Read metadata and body sections. Never touches the observation log, so this
   * stays O(task size) rather than O(history size) in the structured format.
   */
  async loadDocument(id: string): Promise<TaskDocumentResult> {
    // Probing with access() before reading would double the syscalls on a path
    // that runs once per task per board list. Attempt the read instead and let
    // ENOENT select the other format.
    if (this.mode !== "markdown") {
      try {
        return await this.loadStructuredDocument(id);
      } catch (err) {
        if (!isMissing(err)) throw err;
        if (this.mode === "json") throw new TaskNotFoundInStoreError(`Task ${id} not found`);
      }
    }
    try {
      return await this.loadMarkdownDocument(id);
    } catch (err) {
      if (!isMissing(err)) throw err;
      throw new TaskNotFoundInStoreError(`Task ${id} not found`);
    }
  }

  private async loadMarkdownDocument(id: string): Promise<TaskDocumentResult> {
    const file = this.markdownFile(id);
    const handle = await fs.open(file, "r");
    let stat: Stats;
    let raw: string;
    try {
      stat = await handle.stat();
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const parsed = parseTaskFile(raw);
    if (!parsed.ok) {
      return {
        ok: false,
        format: "markdown",
        rev: stat.mtimeMs,
        error: parsed.error,
        rawFrontmatter: parsed.rawFrontmatter,
        rawBody: parsed.rawBody,
      };
    }
    return {
      ok: true,
      format: "markdown",
      frontmatter: parsed.frontmatter,
      body: withoutObservations(parsed.parsed),
      rev: stat.mtimeMs,
      observationCount: parseObservations(getSection(parsed.parsed, OBSERVATIONS_HEADING)).length,
    };
  }

  private async loadStructuredDocument(id: string): Promise<TaskDocumentResult> {
    const file = this.jsonFile(id);
    const handle = await fs.open(file, "r");
    let taskStat: Stats;
    let raw: string;
    let historyStat: Stats | null;
    try {
      [taskStat, raw, historyStat] = await Promise.all([
        handle.stat(),
        handle.readFile("utf8"),
        this.statHistory(id),
      ]);
    } finally {
      await handle.close();
    }
    const rev = Math.max(taskStat.mtimeMs, historyStat?.mtimeMs ?? 0);
    try {
      const task = parseStructuredTask(raw);
      return {
        ok: true,
        format: "structured",
        frontmatter: task.frontmatter,
        body: withoutObservations({ preamble: task.body.preamble, sections: task.body.sections }),
        rev,
        // Trust the stamp only while the history file is byte-for-byte the size
        // it was stamped at; otherwise pay for a real count.
        observationCount:
          task.history && task.history.bytes === (historyStat?.size ?? 0)
            ? task.history.count
            : (await this.readObservationLines(id)).length,
      };
    } catch (err) {
      // Surface a broken task.json the same way a broken task.md is surfaced:
      // visible on the board with its raw text, never a crash.
      return { ok: false, format: "structured", rev, error: (err as Error).message, rawBody: raw };
    }
  }

  private async statHistory(id: string): Promise<Stats | null> {
    try {
      return await fs.stat(this.observationsFile(id));
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  /** Number of observations without deserializing any of their bodies. */
  async observationCount(id: string, format?: TaskFormat): Promise<number> {
    const doc = await this.loadDocument(id).catch(() => null);
    if (doc === null || !doc.ok) return 0;
    return doc.observationCount;
  }

  private async readObservationLines(id: string): Promise<string[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.observationsFile(id), "utf8");
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  }

  /** The complete history. Prefer `pageObservations` on any request path. */
  async loadObservations(id: string, format?: TaskFormat): Promise<Observation[]> {
    const resolved = format ?? (await this.formatOf(id));
    if (resolved === null) throw new TaskNotFoundInStoreError(`Task ${id} not found`);
    if (resolved === "markdown") {
      const parsed = parseTaskFile(await fs.readFile(this.markdownFile(id), "utf8"));
      return parsed.ok ? parseObservations(getSection(parsed.parsed, OBSERVATIONS_HEADING)) : [];
    }
    return (await this.readObservationLines(id)).map((line) => this.decodeObservation(line));
  }

  private decodeObservation(line: string): Observation {
    const stored = JSON.parse(line) as StoredObservation;
    return { at: stored.at, author: stored.author, markdown: stored.markdown };
  }

  /**
   * The newest `limit` observations older than `cursor`. Cursor is the index of
   * the oldest entry already returned, matching the Markdown implementation, so
   * a client paging through history does not care which format backs the task.
   */
  async pageObservations(
    id: string,
    cursor: string | undefined,
    limit: number,
    /** The count the caller already knows (e.g. it just wrote the history). */
    knownTotal?: number,
  ): Promise<ObservationSlice> {
    const format = await this.formatOf(id);
    if (format === null) throw new TaskNotFoundInStoreError(`Task ${id} not found`);
    const size = Math.max(1, limit);

    if (format === "structured") {
      const total = knownTotal ?? (await this.resolveObservationCount(id));
      const { start, end } = window(total, cursor, size);
      // The newest page — the one every request asks for — is read from the end
      // of the file, so its cost is set by the page size and not by how much
      // history the task has accumulated. Paging backwards is rare and reads the
      // whole log rather than seeking line boundaries from an arbitrary offset.
      const lines =
        end === total
          ? await this.readTailLines(id, total - start)
          : (await this.readObservationLines(id)).slice(start, end);
      return {
        // Only the requested window is deserialized; the rest stays raw text.
        observations: lines.slice(0, end - start).map((line) => this.decodeObservation(line)),
        nextCursor: start > 0 ? String(start) : null,
        total,
      };
    }

    const all = await this.loadObservations(id, "markdown");
    const { start, end } = window(all.length, cursor, size);
    return { observations: all.slice(start, end), nextCursor: start > 0 ? String(start) : null, total: all.length };
  }

  /** The authoritative count: the stamp when it is verifiable, a real count otherwise. */
  private async resolveObservationCount(id: string): Promise<number> {
    const doc = await this.loadStructuredDocument(id);
    if (!doc.ok) throw new Error(`Cannot read observations for invalid task ${id}: ${doc.error}`);
    return doc.observationCount;
  }

  /**
   * The last `count` non-empty lines, read from the end of the file.
   *
   * Reads a trailing chunk and grows it until enough complete lines are in
   * hand. When the chunk does not start at the beginning of the file its first
   * line is partial and gets dropped — which also discards any character split
   * across the chunk boundary, so the remaining text is always valid UTF-8.
   */
  private async readTailLines(id: string, count: number): Promise<string[]> {
    if (count <= 0) return [];
    let handle;
    try {
      handle = await fs.open(this.observationsFile(id), "r");
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return [];
      for (let chunk = Math.min(size, 64 * 1024); ; chunk = Math.min(size, chunk * 4)) {
        const from = size - chunk;
        const buffer = Buffer.alloc(chunk);
        await handle.read(buffer, 0, chunk, from);
        let text = buffer.toString("utf8");
        if (from > 0) {
          const newline = text.indexOf("\n");
          text = newline >= 0 ? text.slice(newline + 1) : "";
        }
        const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
        if (lines.length >= count || from === 0) return lines.slice(-count);
      }
    } finally {
      await handle.close();
    }
  }

  /**
   * The Markdown rendering of a task, history included. Structured tasks render
   * one on demand — it is an export, never a second source of truth.
   */
  async renderMarkdown(id: string): Promise<string> {
    const format = await this.formatOf(id);
    if (format === null) throw new TaskNotFoundInStoreError(`Task ${id} not found`);
    if (format === "markdown") return fs.readFile(this.markdownFile(id), "utf8");
    const doc = await this.loadStructuredDocument(id);
    if (!doc.ok) throw new Error(`Cannot render invalid task ${id}: ${doc.error}`);
    const observations = await this.loadObservations(id, "structured");
    const stored: StoredObservation[] = observations.map((observation) => ({
      id: newObservationId(),
      ...observation,
    }));
    return renderStructuredTaskMarkdown(
      {
        schemaVersion: 1,
        frontmatter: doc.frontmatter,
        body: { preamble: doc.body.preamble, sections: doc.body.sections },
        history: historyStamp(serializeObservationJsonl(stored), stored.length),
      },
      stored,
    );
  }

  // ── Write ──────────────────────────────────────────────────────────────────
  /**
   * Persist metadata, body, and any appended observations as ONE revision. Both
   * backends write atomically (temp sibling + rename) so a reader or the watcher
   * never observes a half-written task.
   */
  async save(id: string, req: SaveRequest, format?: TaskFormat): Promise<number> {
    const resolved = format ?? (await this.formatOf(id)) ?? (await this.newTaskFormat());
    return resolved === "structured" ? this.saveStructured(id, req) : this.saveMarkdown(id, req);
  }

  private async saveMarkdown(id: string, req: SaveRequest): Promise<number> {
    // Markdown keeps the history in the same file being rewritten, so it must be
    // read back on EVERY save — not only when something is being appended —
    // or an unrelated field edit would truncate the log.
    const existing = await this.loadObservations(id, "markdown").catch(() => [] as Observation[]);
    const observations = [...existing, ...(req.appendObservations ?? [])];
    const body = setSection(req.body, OBSERVATIONS_HEADING, renderObservationSection(observations));
    const stat = await this.atomicWrite(this.markdownFile(id), serializeTaskFile(req.frontmatter, body));
    return stat.mtimeMs;
  }

  private async saveStructured(id: string, req: SaveRequest): Promise<number> {
    const body = withoutObservations(req.body);
    const appended = req.appendObservations ?? [];
    // The history is written FIRST so the stamp recorded in task.json describes
    // the file that actually exists. A crash between the two leaves the stamp
    // stale, which the size check downgrades to a slow read, never a wrong count.
    if (appended.length > 0) await this.appendObservationLines(id, appended);
    const historyStat = await this.statHistory(id);
    const count =
      historyStat === null
        ? 0
        : req.previousObservationCount !== undefined
          ? req.previousObservationCount + appended.length
          : (await this.readObservationLines(id)).length;

    const taskStat = await this.atomicWrite(
      this.jsonFile(id),
      serializeStructuredTask({
        schemaVersion: 1,
        frontmatter: req.frontmatter,
        body: { preamble: body.preamble, sections: body.sections },
        history: { count, bytes: historyStat?.size ?? 0 },
      }),
    );
    return Math.max(taskStat.mtimeMs, historyStat?.mtimeMs ?? 0);
  }

  /**
   * Append to the history without rewriting it. This is the operation the whole
   * format exists for: adding a note to a task with 200 observations costs one
   * line, not a full-document rewrite.
   */
  private async appendObservationLines(id: string, observations: readonly Observation[]): Promise<number> {
    const file = this.observationsFile(id);
    const stored: StoredObservation[] = observations.map((observation) => ({
      id: newObservationId(),
      at: observation.at,
      author: observation.author,
      markdown: observation.markdown,
    }));
    await fs.appendFile(file, serializeObservationJsonl(stored), "utf8");
    const stat = await fs.stat(file);
    this.recentWrites.add(file, stat.mtimeMs);
    return stat.mtimeMs;
  }

  /** Create the directory skeleton for a task that does not exist yet. */
  async createDirectories(id: string): Promise<void> {
    const dir = this.dir(id);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, "files"), { recursive: true });
    await fs.mkdir(path.join(dir, "resources"), { recursive: true });
  }

  async exists(id: string): Promise<boolean> {
    try {
      await fs.access(this.dir(id));
      return true;
    } catch {
      return false;
    }
  }

  private async atomicWrite(file: string, contents: string): Promise<Stats> {
    const tmp = path.join(path.dirname(file), `${path.basename(file)}.tmp-${nanoid(8)}`);
    await fs.writeFile(tmp, contents, "utf8");
    try {
      await renameWithRetry(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    const stat = await fs.stat(file);
    this.recentWrites.add(file, stat.mtimeMs);
    return stat;
  }
}

/**
 * Windows fails a rename with EPERM/EBUSY while another process holds the
 * destination open — routinely the virus scanner or search indexer that woke up
 * because we just wrote the temp file. The lock is released within milliseconds,
 * so a short backoff turns a spurious write failure into a slightly slower write.
 */
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (attempt >= attempts - 1 || !RENAME_RETRY_CODES.has(code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt));
    }
  }
}

/** Shared cursor arithmetic so both backends page identically. */
function window(total: number, cursor: string | undefined, limit: number): { start: number; end: number } {
  const parsed = cursor === undefined ? total : Number.parseInt(cursor, 10);
  const end = Number.isInteger(parsed) && parsed >= 0 && parsed <= total ? parsed : total;
  return { start: Math.max(0, end - limit), end };
}
