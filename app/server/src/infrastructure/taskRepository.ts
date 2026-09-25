/**
 * Task repository over board/. Handles reads, listing, create/patch/observation
 * with optimistic concurrency and atomic writes. Per-id + allocation mutexes
 * serialize mutations. Writes register their mtime in RecentWrites so the
 * watcher can suppress self-echoes.
 *
 * The on-disk format (legacy task.md vs structured task.json +
 * observations.jsonl) is entirely TaskFileStore's concern. Nothing below reads
 * or writes a task file directly, so the two formats cannot drift in behaviour.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Mutex } from "async-mutex";
import {
  type Frontmatter,
  type Observation,
  type TaskDetail,
  type TaskDetailOrInvalid,
  type TaskSummaryOrInvalid,
  type InvalidTask,
  type CreateRequest,
  type PatchRequest,
  type ObservationRequest,
  type ObservationPage,
  padId,
  idNum,
  normalizeId,
  ID_PATTERN,
} from "@AiDailyTasks/shared";
import {
  setSection,
  getSection,
  buildTaskDetail,
  toTaskSummary,
  type ParsedBody,
} from "../domain/task";
import {
  TaskFileStore,
  TaskNotFoundInStoreError,
  type TaskDocument,
} from "./taskFileStore";
import type { ConfigService } from "../config";
import type { AttachmentStore } from "./attachmentStore";
import type { EventBus } from "./eventBus";
import type { RecentWrites } from "./recentWrites";
import type { Env } from "../env";
import { NotFoundError, ValidationError } from "../errors";

const ID_DIR_RE = /^C\d+$/;

/** Matches the default limit on GET /api/tasks/:id so both paths agree. */
const DEFAULT_OBSERVATION_PAGE = 20;

/** Scalar frontmatter fields whose manual (web-UI) changes get logged to Observations. */
const TRACKED_FIELDS: Array<[keyof Frontmatter, string]> = [
  ["status", "status"],
  ["status_detail", "status detail"],
  ["severity", "severity"],
  ["risk", "risk"],
  ["category", "category"],
  ["project", "project"],
  ["title", "title"],
  ["recurring", "recurring"],
];

/** Quote embedded Markdown so headings cannot become legacy task/observation boundaries. */
function blockerHistory(markdown: string): string {
  return markdown.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

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
  /** Generated or previously-generated successor when a recurring task is archived. */
  successor?: TaskDetail;
}
export interface ConflictOutcome {
  conflict: true;
  current: TaskDetailOrInvalid;
}
export type MutationResult = PatchOutcome | ConflictOutcome;
export type DeleteResult = { conflict: false; id: string } | ConflictOutcome;

export class FsTaskRepository {
  private locks = new Map<string, Mutex>();
  private allocationLock = new Mutex();
  private readonly store: TaskFileStore;

  constructor(
    private readonly env: Env,
    private readonly config: ConfigService,
    private readonly attachments: AttachmentStore,
    private readonly resourceFiles: AttachmentStore,
    private readonly bus: EventBus,
    recentWrites: RecentWrites,
  ) {
    this.store = new TaskFileStore(env.boardDir, env.taskStore, recentWrites);
  }

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
    return this.store.dir(normalizeId(id));
  }

  /**
   * Load a task's metadata and body, never its history. Throws NotFoundError so
   * callers keep the error contract they had when this was a direct stat().
   */
  private async loadDocument(id: string): Promise<TaskDocument | InvalidTask> {
    let doc;
    try {
      doc = await this.store.loadDocument(normalizeId(id));
    } catch (err) {
      if (err instanceof TaskNotFoundInStoreError) throw new NotFoundError(`Task ${normalizeId(id)} not found`);
      throw err;
    }
    if (!doc.ok) return this.invalid(id, doc.rev, doc.error, doc.rawFrontmatter, doc.rawBody);
    return { ...doc, frontmatter: { ...doc.frontmatter, id: normalizeId(id) } };
  }

  /** Current revision, or NotFoundError. */
  private async revOf(id: string): Promise<number> {
    const rev = await this.store.rev(normalizeId(id));
    if (rev === null) throw new NotFoundError(`Task ${normalizeId(id)} not found`);
    return rev;
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
    // Task files are independent. Reading them serially made list_tasks scale with
    // every file/attachment stat and caused multi-second cold spikes on Windows.
    return Promise.all(ids.map((id) => this.readSummary(id)));
  }

  /** All valid frontmatters (for graph building); invalid tasks are skipped. */
  async listFrontmatters(): Promise<Frontmatter[]> {
    const ids = await this.listIds();
    const rows = await Promise.all(ids.map(async (id): Promise<Frontmatter | null> => {
      try {
        const doc = await this.store.loadDocument(id);
        return doc.ok ? { ...doc.frontmatter, id: normalizeId(id) } : null;
      } catch {
        return null;
      }
    }));
    return rows.filter((row): row is Frontmatter => row !== null);
  }

  private async readSummary(id: string): Promise<TaskSummaryOrInvalid> {
    let doc;
    try {
      doc = await this.store.loadDocument(id);
    } catch (err) {
      return this.invalid(id, 0, `Cannot read task ${normalizeId(id)}: ${(err as Error).message}`);
    }
    if (!doc.ok) return this.invalid(id, doc.rev, doc.error, doc.rawFrontmatter, doc.rawBody);
    const fm = { ...doc.frontmatter, id: normalizeId(id) };
    // Counting is deliberately separate from loading: the structured store counts
    // lines without deserializing a single observation body.
    const attachmentCount = await this.attachments
      .list(id)
      .then((list) => list.length)
      .catch(() => 0);
    return toTaskSummary({
      fm,
      rev: doc.rev,
      summaryMarkdown: getSection(doc.body, "Summary"),
      scopeMarkdown: getSection(doc.body, "Scope"),
      attachmentCount,
      observationCount: doc.observationCount,
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
  async read(id: string, observationLimit?: number): Promise<TaskDetailOrInvalid> {
    const doc = await this.loadDocument(id);
    if ("valid" in doc) return doc;
    const canonical = normalizeId(id);
    const [attachments, resourceFiles, history] = await Promise.all([
      this.attachments.list(canonical),
      this.resourceFiles.list(canonical),
      observationLimit === undefined
        ? this.store
            .loadObservations(canonical, doc.format)
            .then((observations) => ({ observations, total: observations.length }))
        : this.store.pageObservations(canonical, undefined, observationLimit),
    ]);
    return buildTaskDetail({
      fm: doc.frontmatter,
      rev: doc.rev,
      summaryMarkdown: getSection(doc.body, "Summary"),
      scopeMarkdown: getSection(doc.body, "Scope"),
      qaMarkdown: getSection(doc.body, "QA"),
      observations: history.observations,
      observationCount: history.total,
      attachments,
      resourceFiles,
      // rawBody is a diagnostic for tasks that FAILED to parse; a valid task is
      // consumed through the structured fields above and no caller reads it.
      // Populating it would mean rendering the whole task to Markdown on every
      // read, including the read that follows every write.
      rawBody: "",
      paged: observationLimit !== undefined,
    });
  }

  /** Read one bounded page without serializing the rest of a task's observation history. */
  async listObservations(id: string, cursor?: string, limit = 20): Promise<ObservationPage> {
    const doc = await this.loadDocument(id);
    if ("valid" in doc) {
      throw new ValidationError(`Cannot read observations for invalid task ${normalizeId(id)}: ${doc.parseError}`);
    }
    return this.store.pageObservations(normalizeId(id), cursor, limit);
  }

  /**
   * Build the response for a write from what was just written, rather than
   * reading the task back.
   *
   * Re-reading a file immediately after modifying it is the slowest read there
   * is on Windows — the just-written file is exactly what a virus scanner has
   * woken up to inspect — and the structured format modifies two files per
   * write, so it paid that penalty twice. Every field is already known here;
   * only the observation page and the attachment listings need the disk.
   */
  private async detailAfterWrite(
    id: string,
    fm: Frontmatter,
    body: ParsedBody,
    rev: number,
    observationCount: number,
  ): Promise<TaskDetail> {
    const canonical = normalizeId(id);
    const [attachments, resourceFiles, page] = await Promise.all([
      this.attachments.list(canonical),
      this.resourceFiles.list(canonical),
      // The count is known from what was just written, so the page can be read
      // straight off the end of the history.
      this.store.pageObservations(canonical, undefined, DEFAULT_OBSERVATION_PAGE, observationCount),
    ]);
    return buildTaskDetail({
      fm,
      rev,
      summaryMarkdown: getSection(body, "Summary"),
      scopeMarkdown: getSection(body, "Scope"),
      qaMarkdown: getSection(body, "QA"),
      observations: page.observations,
      observationCount: page.total,
      attachments,
      resourceFiles,
      rawBody: "",
      paged: true,
    });
  }

  /**
   * Read requiring validity. Used when the task being read is not the one we
   * just wrote. Bounded to the same page size the GET route defaults to.
   */
  private async readDetailStrict(id: string): Promise<TaskDetail> {
    const detail = await this.read(id, DEFAULT_OBSERVATION_PAGE);
    if (!detail.valid) {
      throw new Error(`Task ${normalizeId(id)} became invalid after write: ${detail.parseError}`);
    }
    return detail;
  }

  // ── Create ────────────────────────────────────────────────────────────────────
  async create(req: CreateRequest): Promise<TaskDetail> {
    return this.createWithLineage(req, null);
  }

  private async createWithLineage(
    req: CreateRequest,
    recurrenceOf: string | null,
  ): Promise<TaskDetail> {
    return this.allocationLock.runExclusive(async () => {
      const id = await this.resolveNewId(req.id);
      await this.store.createDirectories(id);

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
        blocker: req.blocker ?? "",
        blocked_since: req.blocker ? new Date().toISOString() : null,
        created: today,
        updated: today,
        completed: req.status === "Completed" ? today : undefined,
        archived: false,
        tags: req.tags,
        skills: req.skills,
        recurring: req.recurring,
        recurrence_of: recurrenceOf,
        depends_on: req.depends_on,
        blocks: req.blocks,
        relates_to: req.relates_to,
        parent: req.parent,
        children: [],
        sources: [],
        resources: req.resources,
      };
      const body: ParsedBody = {
        preamble: "",
        sections: [
          { heading: "Summary", content: req.summary.trim() },
          { heading: "Scope", content: req.scope.trim() },
          // QA is written only when provided — most tasks never need the section.
          ...(req.qa.trim() ? [{ heading: "QA", content: req.qa.trim() }] : []),
        ],
      };
      const appendObservations: Observation[] = fm.blocker ? [{
        at: fm.blocked_since!, author: "system", markdown: `Blocker started:\n\n${blockerHistory(fm.blocker)}`,
      }] : [];
      const rev = await this.store.save(
        id,
        { frontmatter: fm, body, appendObservations, previousObservationCount: 0 },
        await this.store.newTaskFormat(),
      );
      const detail = await this.detailAfterWrite(id, fm, body, rev, appendObservations.length);
      this.bus.publish({ type: "task.created", id, task: this.summaryFromDetail(detail) });
      return detail;
    });
  }

  private async resolveNewId(explicit?: string): Promise<string> {
    if (explicit) {
      if (!ID_PATTERN.test(explicit)) throw new ValidationError(`Invalid id: ${explicit}`);
      const norm = normalizeId(explicit, this.config.idPrefix, this.config.idPad);
      if (await this.store.exists(norm)) throw new ValidationError(`Task ${norm} already exists`);
      return norm;
    }
    const ids = await this.listIds();
    let next = ids.reduce((max, id) => Math.max(max, idNum(id) || 0), 0) + 1;
    // Retry forward if a directory somehow already exists.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const candidate = padId(next, this.config.idPrefix, this.config.idPad);
      if (!(await this.store.exists(candidate))) return candidate;
      next += 1;
    }
  }

  // ── Patch ───────────────────────────────────────────────────────────────────
  async patch(id: string, req: PatchRequest): Promise<MutationResult> {
    return this.lockFor(id).runExclusive(async () => {
      // One load answers both questions: the revision to compare and the
      // document to mutate. Checking the revision first preserves the existing
      // contract that a stale write conflicts rather than reporting a parse error.
      const doc = await this.loadDocument(id);
      if (doc.rev !== req.baseRev) {
        return { conflict: true, current: await this.read(id) };
      }
      if ("valid" in doc) {
        throw new ValidationError(`Cannot patch invalid task ${normalizeId(id)}: ${doc.parseError}`);
      }

      const fm: Frontmatter = { ...doc.frontmatter };
      let body = doc.body;
      const appendObservations: Observation[] = [];

      if (req.fields) {
        const before: Frontmatter = { ...fm };
        const prevStatus = fm.status;
        Object.assign(fm, req.fields);
        if (req.fields.blocker !== undefined && fm.blocker !== before.blocker) {
          const at = new Date().toISOString();
          fm.blocked_since = fm.blocker ? (before.blocked_since ?? at) : null;
          appendObservations.push({
            at,
            author: "system",
            markdown: fm.blocker
              ? before.blocker
                ? `Blocker updated (started ${fm.blocked_since}).\n\nPrevious details:\n\n${blockerHistory(before.blocker)}\n\nUpdated details:\n\n${blockerHistory(fm.blocker)}`
                : `Blocker started:\n\n${blockerHistory(fm.blocker)}`
              : `Blocker resolved (started ${before.blocked_since ?? "unknown"}; resolved ${at}):\n\n${blockerHistory(before.blocker)}`,
          });
        }
        fm.id = normalizeId(id); // id is not editable
        if (req.fields.status !== undefined) {
          if (req.fields.status === "Completed") {
            fm.completed = fm.completed && fm.completed.trim() ? fm.completed : this.today();
          } else if (prevStatus === "Completed") {
            fm.completed = undefined;
          }
        }
        // An API patch comes from the web UI (= the user editing manually), so record what
        // changed under Observations. An agent editing the task file directly goes through
        // the watcher, not here — so this only logs human/UI edits, by design.
        const changes = describeFieldChanges(before, fm);
        if (changes.length > 0) {
          appendObservations.push({
            at: new Date().toISOString(),
            author: "human",
            markdown: `Updated via web UI — ${changes.join("; ")}.`,
          });
        }
      }
      if (req.body) {
        if (req.body.summary !== undefined) body = setSection(body, "Summary", req.body.summary);
        if (req.body.scope !== undefined) body = setSection(body, "Scope", req.body.scope);
        if (req.body.qa !== undefined) body = setSection(body, "QA", req.body.qa);
      }
      fm.updated = this.today();

      const rev = await this.store.save(
        normalizeId(id),
        { frontmatter: fm, body, appendObservations, previousObservationCount: doc.observationCount },
        doc.format,
      );
      const detail = await this.detailAfterWrite(id, fm, body, rev, doc.observationCount + appendObservations.length);
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
      const doc = await this.loadDocument(id);
      if (doc.rev !== req.baseRev) {
        return { conflict: true, current: await this.read(id) };
      }
      if ("valid" in doc) {
        throw new ValidationError(`Cannot annotate invalid task ${normalizeId(id)}: ${doc.parseError}`);
      }
      const fm: Frontmatter = { ...doc.frontmatter };
      fm.updated = this.today();
      const appendObservations: Observation[] = [
        {
          at: req.at && req.at.trim() ? req.at.trim() : new Date().toISOString(),
          author: req.author,
          markdown: req.text.trim(),
        },
      ];

      // In the structured format this appends one line; the history is never rewritten.
      const rev = await this.store.save(
        normalizeId(id),
        { frontmatter: fm, body: doc.body, appendObservations, previousObservationCount: doc.observationCount },
        doc.format,
      );
      const detail = await this.detailAfterWrite(id, fm, doc.body, rev, doc.observationCount + appendObservations.length);
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
      const doc = await this.loadDocument(id);
      if (baseRev !== undefined && doc.rev !== baseRev) {
        return { conflict: true, current: await this.read(id) };
      }
      if ("valid" in doc) {
        throw new ValidationError(`Cannot archive invalid task ${normalizeId(id)}: ${doc.parseError}`);
      }
      const fm: Frontmatter = { ...doc.frontmatter };
      if (fm.archived === archived) {
        // Already in the desired state — don't rewrite the file.
        const task = await this.readDetailStrict(id);
        const successor = archived ? await this.ensureRecurringSuccessor(task) : undefined;
        return { conflict: false, task, ...(successor ? { successor } : {}) };
      }
      fm.archived = archived;
      fm.archived_at = archived ? this.today() : undefined;

      const rev = await this.store.save(
        normalizeId(id),
        { frontmatter: fm, body: doc.body, previousObservationCount: doc.observationCount },
        doc.format,
      );
      const detail = await this.detailAfterWrite(id, fm, doc.body, rev, doc.observationCount);
      this.bus.publish({
        type: "task.updated",
        id: normalizeId(id),
        task: this.summaryFromDetail(detail),
        rev: detail.rev,
      });
      const successor = archived ? await this.ensureRecurringSuccessor(detail) : undefined;
      return { conflict: false, task: detail, ...(successor ? { successor } : {}) };
    });
  }

  private async ensureRecurringSuccessor(source: TaskDetail): Promise<TaskDetail | undefined> {
    if (!source.recurring || source.status !== "Completed") return undefined;

    const sourceId = normalizeId(source.id);
    for (const candidateId of await this.listIds()) {
      if (candidateId === sourceId) continue;
      try {
        const candidate = await this.store.loadDocument(candidateId);
        if (
          candidate.ok &&
          candidate.frontmatter.recurrence_of &&
          normalizeId(candidate.frontmatter.recurrence_of) === sourceId
        ) {
          return this.readDetailStrict(candidateId);
        }
      } catch {
        // Invalid or concurrently removed tasks cannot be a confirmed successor.
      }
    }

    const successor = await this.createWithLineage(
      {
        title: source.title,
        project: source.project,
        category: source.category,
        severity: source.severity,
        risk: source.risk,
        status: "Backlog",
        status_detail: "",
        tags: [...source.tags],
        skills: [...source.skills],
        recurring: true,
        depends_on: [],
        blocks: [],
        relates_to: [],
        parent: null,
        resources: source.resources.map((resource) => ({ ...resource })),
        summary: source.summaryMarkdown,
        scope: source.scopeMarkdown,
        // How-to-test steps are content, not lifecycle state: the next occurrence is
        // tested the same way, so they carry forward with summary/scope.
        qa: source.qaMarkdown,
      },
      sourceId,
    );
    const sourceResources = path.join(this.taskDir(sourceId), "resources");
    const successorResources = path.join(this.taskDir(successor.id), "resources");
    try {
      await fs.cp(sourceResources, successorResources, { recursive: true, force: false });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return this.readDetailStrict(successor.id);
  }

  /** Permanently remove an archived task directory after an exact revision check. */
  async delete(id: string, baseRev: number): Promise<DeleteResult> {
    return this.lockFor(id).runExclusive(async () => {
      const canonical = normalizeId(id);
      if ((await this.revOf(canonical)) !== baseRev) {
        return { conflict: true, current: await this.read(canonical) };
      }
      const detail = await this.readDetailStrict(canonical);
      if (!detail.archived) {
        throw new ValidationError(`Task ${canonical} must be archived before permanent deletion`);
      }
      const dir = this.taskDir(canonical);
      const rel = path.relative(this.env.boardDir, dir);
      if (!ID_DIR_RE.test(rel) || path.isAbsolute(rel)) {
        throw new ValidationError(`Refusing to delete unsafe task path for ${canonical}`);
      }
      await fs.rm(dir, { recursive: true, force: false });
      this.bus.publish({ type: "task.deleted", id: canonical });
      return { conflict: false, id: canonical };
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
      blocker: detail.blocker,
      blocked_since: detail.blocked_since,
      created: detail.created,
      updated: detail.updated,
      completed: detail.completed,
      archived: detail.archived,
      archived_at: detail.archived_at,
      tags: detail.tags,
      skills: detail.skills,
      recurring: detail.recurring,
      recurrence_of: detail.recurrence_of,
      depends_on: detail.depends_on,
      blocks: detail.blocks,
      relates_to: detail.relates_to,
      parent: detail.parent,
      children: detail.children,
      sources: detail.sources,
      resources: detail.resources,
    };
    return toTaskSummary({
      fm,
      rev: detail.rev,
      summaryMarkdown: detail.summaryMarkdown,
      scopeMarkdown: detail.scopeMarkdown,
      attachmentCount: detail.attachments.length,
      observationCount: detail.observationCount,
    });
  }
}
