/**
 * Filesystem-backed task repository over board/. Handles reads, listing,
 * create/patch/observation with optimistic concurrency (rev = task.md mtimeMs)
 * and atomic writes (temp sibling + rename). Per-id + allocation mutexes serialize
 * mutations. Writes register their mtime in RecentWrites so the watcher can
 * suppress self-echoes.
 */
import fs from "node:fs/promises";
import { Stats } from "node:fs";
import path from "node:path";
import { Mutex } from "async-mutex";
import { nanoid } from "nanoid";
import {
  type Frontmatter,
  type TaskDetail,
  type TaskDetailOrInvalid,
  type TaskSummaryOrInvalid,
  type InvalidTask,
  type CreateRequest,
  type PatchRequest,
  type ObservationRequest,
  padId,
  idNum,
  normalizeId,
  ID_PATTERN,
} from "@AiDailyTasks/shared";
import {
  parseTaskFile,
  serializeTaskFile,
  setSection,
  getSection,
  parseObservations,
  toTaskDetail,
  toTaskSummary,
  type ParsedBody,
} from "../domain/task";
import type { ConfigService } from "../config";
import type { AttachmentStore } from "./attachmentStore";
import type { EventBus } from "./eventBus";
import type { RecentWrites } from "./recentWrites";
import type { Env } from "../env";
import { NotFoundError, ValidationError } from "../errors";

const ID_DIR_RE = /^C\d+$/;

/** Scalar frontmatter fields whose manual (web-UI) changes get logged to Observations. */
const TRACKED_FIELDS: Array<[keyof Frontmatter, string]> = [
  ["status", "status"],
  ["status_detail", "status detail"],
  ["severity", "severity"],
  ["risk", "risk"],
  ["category", "category"],
  ["project", "project"],
  ["title", "title"],
];

function fmtVal(v: unknown): string {
  const s = v == null ? "" : String(v);
  return s.trim() === "" ? "(none)" : s;
}

/** Human-readable list of changed tracked fields, e.g. ["status: In progress → Completed"]. */
function describeFieldChanges(before: Frontmatter, after: Frontmatter): string[] {
  const out: string[] = [];
  for (const [key, label] of TRACKED_FIELDS) {
    if (String(before[key] ?? "") !== String(after[key] ?? "")) {
      out.push(`${label}: ${fmtVal(before[key])} → ${fmtVal(after[key])}`);
    }
  }
  return out;
}

export interface PatchOutcome {
  conflict: false;
  task: TaskDetail;
}
export interface ConflictOutcome {
  conflict: true;
  current: TaskDetailOrInvalid;
}
export type MutationResult = PatchOutcome | ConflictOutcome;

export class FsTaskRepository {
  private locks = new Map<string, Mutex>();
  private allocationLock = new Mutex();

  constructor(
    private readonly env: Env,
    private readonly config: ConfigService,
    private readonly attachments: AttachmentStore,
    private readonly bus: EventBus,
    private readonly recentWrites: RecentWrites,
  ) {}

  private lockFor(id: string): Mutex {
    const key = normalizeId(id);
    let m = this.locks.get(key);
    if (!m) {
      m = new Mutex();
      this.locks.set(key, m);
    }
    return m;
  }

  private taskDir(id: string): string {
    return path.join(this.env.boardDir, normalizeId(id));
  }
  private taskFile(id: string): string {
    return path.join(this.taskDir(id), "task.md");
  }

  // ── Listing ────────────────────────────────────────────────────────────────
  async listIds(): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.env.boardDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && ID_DIR_RE.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => idNum(a) - idNum(b));
  }

  async listSummaries(): Promise<TaskSummaryOrInvalid[]> {
    const ids = await this.listIds();
    const out: TaskSummaryOrInvalid[] = [];
    for (const id of ids) {
      out.push(await this.readSummary(id));
    }
    return out;
  }

  /** All valid frontmatters (for graph building); invalid tasks are skipped. */
  async listFrontmatters(): Promise<Frontmatter[]> {
    const ids = await this.listIds();
    const out: Frontmatter[] = [];
    for (const id of ids) {
      try {
        const raw = await fs.readFile(this.taskFile(id), "utf8");
        const parsed = parseTaskFile(raw);
        if (parsed.ok) out.push({ ...parsed.frontmatter, id: normalizeId(id) });
      } catch {
        /* skip */
      }
    }
    return out;
  }

  private async readSummary(id: string): Promise<TaskSummaryOrInvalid> {
    const file = this.taskFile(id);
    let raw: string;
    let st: Stats;
    try {
      st = await fs.stat(file);
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      return this.invalid(id, 0, `Cannot read task.md: ${(err as Error).message}`);
    }
    const parsed = parseTaskFile(raw);
    if (!parsed.ok) {
      return this.invalid(id, st.mtimeMs, parsed.error, parsed.rawFrontmatter, parsed.rawBody);
    }
    const fm = { ...parsed.frontmatter, id: normalizeId(id) };
    let attachmentCount = 0;
    try {
      attachmentCount = (await this.attachments.list(id)).length;
    } catch {
      /* ignore */
    }
    const observationCount = parseObservations(getSection(parsed.parsed, "Observations")).length;
    return toTaskSummary({
      fm,
      rev: st.mtimeMs,
      summaryMarkdown: getSection(parsed.parsed, "Summary"),
      scopeMarkdown: getSection(parsed.parsed, "Scope"),
      attachmentCount,
      observationCount,
    });
  }

  private invalid(
    id: string,
    rev: number,
    parseError: string,
    rawFrontmatter?: string,
    rawBody?: string,
  ): InvalidTask {
    return { id: normalizeId(id), valid: false, rev, parseError, rawFrontmatter, rawBody };
  }

  // ── Read one ─────────────────────────────────────────────────────────────────
  async read(id: string): Promise<TaskDetailOrInvalid> {
    const file = this.taskFile(id);
    let st: Stats;
    let raw: string;
    try {
      st = await fs.stat(file);
    } catch {
      throw new NotFoundError(`Task ${normalizeId(id)} not found`);
    }
    raw = await fs.readFile(file, "utf8");
    const parsed = parseTaskFile(raw);
    if (!parsed.ok) {
      return this.invalid(id, st.mtimeMs, parsed.error, parsed.rawFrontmatter, parsed.rawBody);
    }
    const fm = { ...parsed.frontmatter, id: normalizeId(id) };
    const attachments = await this.attachments.list(id);
    return toTaskDetail({ fm, rev: st.mtimeMs, parsed: parsed.parsed, rawBody: parsed.body, attachments });
  }

  /** Read requiring validity (used after our own writes). */
  private async readDetailStrict(id: string): Promise<TaskDetail> {
    const detail = await this.read(id);
    if (!detail.valid) {
      throw new Error(`Task ${normalizeId(id)} became invalid after write: ${detail.parseError}`);
    }
    return detail;
  }

  // ── Atomic write ──────────────────────────────────────────────────────────────
  private async atomicWrite(file: string, contents: string): Promise<Stats> {
    const tmp = path.join(path.dirname(file), `task.md.tmp-${nanoid(8)}`);
    await fs.writeFile(tmp, contents, "utf8");
    try {
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    const st = await fs.stat(file);
    this.recentWrites.add(file, st.mtimeMs);
    return st;
  }

  // ── Create ────────────────────────────────────────────────────────────────────
  async create(req: CreateRequest): Promise<TaskDetail> {
    return this.allocationLock.runExclusive(async () => {
      const id = await this.resolveNewId(req.id);
      const dir = this.taskDir(id);
      await fs.mkdir(dir, { recursive: true });
      await fs.mkdir(path.join(dir, "files"), { recursive: true });

      const today = this.today();
      const fm: Frontmatter = {
        id,
        title: req.title,
        project: req.project,
        category: req.category,
        severity: req.severity,
        risk: req.risk,
        status: req.status,
        status_detail: req.status_detail,
        created: today,
        updated: today,
        completed: req.status === "Completed" ? today : undefined,
        archived: false,
        tags: req.tags,
        depends_on: req.depends_on,
        blocks: req.blocks,
        relates_to: req.relates_to,
        parent: req.parent,
        children: [],
        sources: [],
      };
      const body: ParsedBody = {
        preamble: "",
        sections: [
          { heading: "Summary", content: req.summary.trim() },
          { heading: "Scope", content: req.scope.trim() },
          { heading: "Observations", content: "" },
        ],
      };
      await this.atomicWrite(this.taskFile(id), serializeTaskFile(fm, body));
      const detail = await this.readDetailStrict(id);
      this.bus.publish({ type: "task.created", id, task: this.summaryFromDetail(detail) });
      return detail;
    });
  }

  private async resolveNewId(explicit?: string): Promise<string> {
    if (explicit) {
      if (!ID_PATTERN.test(explicit)) throw new ValidationError(`Invalid id: ${explicit}`);
      const norm = normalizeId(explicit, this.config.idPrefix, this.config.idPad);
      try {
        await fs.access(this.taskDir(norm));
        throw new ValidationError(`Task ${norm} already exists`);
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        return norm; // access failed => does not exist
      }
    }
    const ids = await this.listIds();
    let next = ids.reduce((max, id) => Math.max(max, idNum(id) || 0), 0) + 1;
    // Retry forward if a directory somehow already exists.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const candidate = padId(next, this.config.idPrefix, this.config.idPad);
      try {
        await fs.access(this.taskDir(candidate));
        next += 1;
      } catch {
        return candidate;
      }
    }
  }

  // ── Patch ───────────────────────────────────────────────────────────────────
  async patch(id: string, req: PatchRequest): Promise<MutationResult> {
    return this.lockFor(id).runExclusive(async () => {
      const file = this.taskFile(id);
      let st: Stats;
      try {
        st = await fs.stat(file);
      } catch {
        throw new NotFoundError(`Task ${normalizeId(id)} not found`);
      }
      if (st.mtimeMs !== req.baseRev) {
        return { conflict: true, current: await this.read(id) };
      }
      const raw = await fs.readFile(file, "utf8");
      const parsed = parseTaskFile(raw);
      if (!parsed.ok) {
        throw new ValidationError(`Cannot patch invalid task ${normalizeId(id)}: ${parsed.error}`);
      }

      const fm: Frontmatter = { ...parsed.frontmatter, id: normalizeId(id) };
      let body = parsed.parsed;

      if (req.fields) {
        const before: Frontmatter = { ...fm };
        const prevStatus = fm.status;
        Object.assign(fm, req.fields);
        fm.id = normalizeId(id); // id is not editable
        if (req.fields.status !== undefined) {
          if (req.fields.status === "Completed") {
            fm.completed = fm.completed && fm.completed.trim() ? fm.completed : this.today();
          } else if (prevStatus === "Completed") {
            fm.completed = undefined;
          }
        }
        // An API patch comes from the web UI (= the user editing manually), so record what
        // changed under Observations. Claude edits task.md directly (via the watcher path),
        // which does NOT go through here — so this only logs human/UI edits, by design.
        const changes = describeFieldChanges(before, fm);
        if (changes.length > 0) {
          const at = new Date().toISOString();
          const note = `### ${at} — human\n\nUpdated via web UI — ${changes.join("; ")}.`;
          const existing = getSection(body, "Observations").trim();
          body = setSection(body, "Observations", existing ? `${existing}\n\n${note}` : note);
        }
      }
      if (req.body) {
        if (req.body.summary !== undefined) body = setSection(body, "Summary", req.body.summary);
        if (req.body.scope !== undefined) body = setSection(body, "Scope", req.body.scope);
      }
      fm.updated = this.today();

      await this.atomicWrite(file, serializeTaskFile(fm, body));
      const detail = await this.readDetailStrict(id);
      this.bus.publish({
        type: "task.updated",
        id: normalizeId(id),
        task: this.summaryFromDetail(detail),
        rev: detail.rev,
      });
      return { conflict: false, task: detail };
    });
  }

  // ── Observations ──────────────────────────────────────────────────────────────
  async appendObservation(id: string, req: ObservationRequest): Promise<MutationResult> {
    return this.lockFor(id).runExclusive(async () => {
      const file = this.taskFile(id);
      let st: Stats;
      try {
        st = await fs.stat(file);
      } catch {
        throw new NotFoundError(`Task ${normalizeId(id)} not found`);
      }
      if (st.mtimeMs !== req.baseRev) {
        return { conflict: true, current: await this.read(id) };
      }
      const raw = await fs.readFile(file, "utf8");
      const parsed = parseTaskFile(raw);
      if (!parsed.ok) {
        throw new ValidationError(`Cannot annotate invalid task ${normalizeId(id)}: ${parsed.error}`);
      }
      const fm: Frontmatter = { ...parsed.frontmatter, id: normalizeId(id) };
      const at = req.at && req.at.trim() ? req.at.trim() : new Date().toISOString();
      const entry = `### ${at} — ${req.author}\n\n${req.text.trim()}`;
      const existing = getSection(parsed.parsed, "Observations").trim();
      const merged = existing ? `${existing}\n\n${entry}` : entry;
      const body = setSection(parsed.parsed, "Observations", merged);
      fm.updated = this.today();

      await this.atomicWrite(file, serializeTaskFile(fm, body));
      const detail = await this.readDetailStrict(id);
      this.bus.publish({
        type: "task.updated",
        id: normalizeId(id),
        task: this.summaryFromDetail(detail),
        rev: detail.rev,
      });
      return { conflict: false, task: detail };
    });
  }

  // ── Archive ──────────────────────────────────────────────────────────────────
  /**
   * Set or clear the archived flag. Deliberately does NOT bump `updated` — archiving is a
   * lifecycle move, not a content edit — and writes no Observation, so it stays quiet.
   * When `baseRev` is provided, enforces the same optimistic concurrency as patch().
   */
  async setArchived(id: string, archived: boolean, baseRev?: number): Promise<MutationResult> {
    return this.lockFor(id).runExclusive(async () => {
      const file = this.taskFile(id);
      let st: Stats;
      try {
        st = await fs.stat(file);
      } catch {
        throw new NotFoundError(`Task ${normalizeId(id)} not found`);
      }
      if (baseRev !== undefined && st.mtimeMs !== baseRev) {
        return { conflict: true, current: await this.read(id) };
      }
      const raw = await fs.readFile(file, "utf8");
      const parsed = parseTaskFile(raw);
      if (!parsed.ok) {
        throw new ValidationError(`Cannot archive invalid task ${normalizeId(id)}: ${parsed.error}`);
      }
      const fm: Frontmatter = { ...parsed.frontmatter, id: normalizeId(id) };
      if (fm.archived === archived) {
        // Already in the desired state — don't rewrite the file.
        return { conflict: false, task: await this.readDetailStrict(id) };
      }
      fm.archived = archived;
      fm.archived_at = archived ? this.today() : undefined;

      await this.atomicWrite(file, serializeTaskFile(fm, parsed.parsed));
      const detail = await this.readDetailStrict(id);
      this.bus.publish({
        type: "task.updated",
        id: normalizeId(id),
        task: this.summaryFromDetail(detail),
        rev: detail.rev,
      });
      return { conflict: false, task: detail };
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────
  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private summaryFromDetail(detail: TaskDetail) {
    const fm: Frontmatter = {
      id: detail.id,
      title: detail.title,
      project: detail.project,
      category: detail.category,
      severity: detail.severity,
      risk: detail.risk,
      status: detail.status,
      status_detail: detail.status_detail,
      created: detail.created,
      updated: detail.updated,
      completed: detail.completed,
      archived: detail.archived,
      archived_at: detail.archived_at,
      tags: detail.tags,
      depends_on: detail.depends_on,
      blocks: detail.blocks,
      relates_to: detail.relates_to,
      parent: detail.parent,
      children: detail.children,
      sources: detail.sources,
    };
    return toTaskSummary({
      fm,
      rev: detail.rev,
      summaryMarkdown: detail.summaryMarkdown,
      scopeMarkdown: detail.scopeMarkdown,
      attachmentCount: detail.attachments.length,
      observationCount: detail.observations.length,
    });
  }
}
