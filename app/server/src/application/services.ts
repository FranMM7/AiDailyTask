/**
 * Application services: thin orchestration over the repository, attachment store,
 * config, graph and export rendering. Kept free of HTTP concerns.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  type BoardConfig,
  type TaskFilter,
  type TaskSummaryOrInvalid,
  type TaskDetailOrInvalid,
  type CreateRequest,
  type PatchRequest,
  type ObservationRequest,
  type Attachment,
  type GraphData,
  type ExportRequest,
  type ExportResult,
  type TaskDetail,
  type TaskSummary,
  STATUSES,
  CATEGORIES,
  idNum,
} from "@AiDailyTasks/shared";
import { applyFilter } from "../domain/filter";
import { buildGraph } from "../domain/graph";
import type { FsTaskRepository, MutationResult, DeleteResult } from "../infrastructure/taskRepository";
import type { AttachmentStore } from "../infrastructure/attachmentStore";
import type { EventBus } from "../infrastructure/eventBus";
import type { Env } from "../env";

export class TaskService {
  private summariesInFlight: Promise<TaskSummaryOrInvalid[]> | null = null;

  constructor(private readonly repo: FsTaskRepository) {}

  async list(filter: TaskFilter): Promise<TaskSummaryOrInvalid[]> {
    // Collapse overlapping board/MCP list requests into one filesystem scan. This
    // matters when several agent calls arrive together on Windows: without it each
    // request independently stats every task and attachment.
    if (!this.summariesInFlight) {
      this.summariesInFlight = this.repo.listSummaries().finally(() => {
        this.summariesInFlight = null;
      });
    }
    const all = await this.summariesInFlight;
    return applyFilter(all, filter);
  }

  get(id: string): Promise<TaskDetailOrInvalid> {
    return this.repo.read(id);
  }

  create(req: CreateRequest): Promise<TaskDetail> {
    return this.repo.create(req);
  }

  patch(id: string, req: PatchRequest): Promise<MutationResult> {
    return this.repo.patch(id, req);
  }

  addObservation(id: string, req: ObservationRequest): Promise<MutationResult> {
    return this.repo.appendObservation(id, req);
  }

  archive(id: string, baseRev?: number): Promise<MutationResult> {
    return this.repo.setArchived(id, true, baseRev);
  }

  unarchive(id: string, baseRev?: number): Promise<MutationResult> {
    return this.repo.setArchived(id, false, baseRev);
  }

  delete(id: string, baseRev: number): Promise<DeleteResult> {
    return this.repo.delete(id, baseRev);
  }

  /**
   * Archive every Completed task whose `completed` date is older than `days`.
   * Idempotent and safe to run repeatedly (already-archived tasks are skipped).
   * Returns the number newly archived.
   */
  async archiveStale(days: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    const all = await this.repo.listSummaries();
    let archived = 0;
    for (const t of all) {
      if (!t.valid || t.archived || t.status !== "Completed") continue;
      const done = (t.completed ?? "").slice(0, 10);
      if (!done || done > cutoffDay) continue; // no completion date, or still inside the window
      try {
        const res = await this.repo.setArchived(t.id, true, t.rev);
        if (!res.conflict) archived++;
      } catch {
        /* a task that raced/vanished — the next sweep will retry */
      }
    }
    return archived;
  }
}

export class AttachmentService {
  constructor(
    private readonly store: AttachmentStore,
    private readonly repo: FsTaskRepository,
    private readonly bus: EventBus,
  ) {}

  private async assertTaskExists(id: string): Promise<void> {
    // Throws NotFoundError if the task.md is missing.
    await this.repo.read(id);
  }

  async list(id: string): Promise<Attachment[]> {
    await this.assertTaskExists(id);
    return this.store.list(id);
  }

  async saveMany(id: string, files: { filename: string; data: Buffer }[]): Promise<Attachment[]> {
    await this.assertTaskExists(id);
    const saved: Attachment[] = [];
    for (const f of files) saved.push(await this.store.save(id, f.filename, f.data));
    if (saved.length > 0) this.bus.publish({ type: "attachments.changed", id });
    return saved;
  }

  read(id: string, name: string) {
    return this.store.read(id, name);
  }

  async delete(id: string, name: string): Promise<void> {
    await this.store.delete(id, name);
    this.bus.publish({ type: "attachments.changed", id });
  }
}

export class GraphService {
  constructor(private readonly repo: FsTaskRepository) {}

  async build(project?: string): Promise<GraphData> {
    let frontmatters = await this.repo.listFrontmatters();
    frontmatters = frontmatters.filter((fm) => !fm.archived); // archived tasks stay out of the graph
    if (project) frontmatters = frontmatters.filter((fm) => fm.project === project);
    return buildGraph(frontmatters);
  }
}

export interface ExportListing {
  filename: string;
  path: string;
  size: number;
  modified: string;
}

function slugify(input: string): string {
  const s = input
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
  return s.length > 0 ? s.slice(0, 60) : "export";
}

function timestampStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function mdEscapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

export class ExportService {
  constructor(
    private readonly env: Env,
    private readonly repo: FsTaskRepository,
  ) {}

  async buildAndSave(req: ExportRequest): Promise<ExportResult> {
    const summaries = (await this.repo.listSummaries()).filter(
      (t): t is TaskSummary => t.valid === true,
    );

    const selected = summaries.filter((t) => {
      if (req.statuses && req.statuses.length && !req.statuses.includes(t.status)) return false;
      if (req.categories && req.categories.length && !req.categories.includes(t.category)) return false;
      if (req.projects && req.projects.length && !req.projects.includes(t.project)) return false;
      if (req.severities && req.severities.length && !req.severities.includes(t.severity)) return false;
      return true;
    });
    selected.sort((a, b) => idNum(a.id) - idNum(b.id));

    const title = req.title && req.title.trim() ? req.title.trim() : "AiDailyTasks export";
    const now = new Date();
    const markdown = await this.render(title, now, selected, req);

    await fs.mkdir(this.env.exportsDir, { recursive: true });
    const filename = `${timestampStamp(now)}-${slugify(req.title ?? "export")}.md`;
    const filePath = path.join(this.env.exportsDir, filename);
    await fs.writeFile(filePath, markdown, "utf8");

    return { filename, path: filePath, markdown, taskCount: selected.length };
  }

  private groupKey(t: TaskSummary, groupBy: ExportRequest["groupBy"]): string {
    switch (groupBy) {
      case "status":
        return t.status;
      case "category":
        return t.category;
      case "project":
        return t.project;
      case "none":
      default:
        return "";
    }
  }

  private orderedGroupKeys(groupBy: ExportRequest["groupBy"], present: Set<string>): string[] {
    if (groupBy === "status" || groupBy === "category") {
      const preferred = groupBy === "status" ? STATUSES : CATEGORIES;
      return [
        ...preferred.filter((value) => present.has(value)),
        ...[...present].filter((value) => !(preferred as readonly string[]).includes(value)).sort(),
      ];
    }
    return [...present].sort();
  }

  private async render(
    title: string,
    now: Date,
    tasks: TaskSummary[],
    req: ExportRequest,
  ): Promise<string> {
    const lines: string[] = [];
    lines.push(`# ${title}`, "");
    lines.push(`_Generated ${now.toISOString()} · ${tasks.length} task(s)_`, "");

    const groups = new Map<string, TaskSummary[]>();
    for (const t of tasks) {
      const key = this.groupKey(t, req.groupBy);
      const arr = groups.get(key) ?? [];
      arr.push(t);
      groups.set(key, arr);
    }
    const keys =
      req.groupBy === "none"
        ? [""]
        : this.orderedGroupKeys(req.groupBy, new Set(groups.keys()));

    for (const key of keys) {
      const rows = groups.get(key);
      if (!rows || rows.length === 0) continue;
      if (req.groupBy !== "none") lines.push(`## ${key} (${rows.length})`, "");

      lines.push("| ID | Title | Status | Category | Severity | Risk | Skills | Updated |");
      lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
      for (const t of rows) {
        lines.push(
          `| ${t.id} | ${mdEscapeCell(t.title)} | ${t.status} | ${t.category} | ${t.severity} | ${t.risk} | ${mdEscapeCell(t.skills.join(", "))} | ${(t.updated ?? t.created ?? t.updatedEffective).slice(0, 10)} |`,
        );
      }
      lines.push("");

      if (req.includeScope || req.includeObservations) {
        for (const t of rows) {
          const detail = await this.repo.read(t.id);
          if (!detail.valid) continue;
          lines.push(`### ${t.id} — ${mdEscapeCell(t.title)}`, "");
          if (req.includeScope && detail.scopeMarkdown.trim()) {
            lines.push("**Scope**", "", detail.scopeMarkdown.trim(), "");
          }
          if (req.includeObservations && detail.observations.length > 0) {
            lines.push("**Observations**", "");
            for (const o of detail.observations) {
              lines.push(`- \`${o.at}\` — ${o.author}: ${mdEscapeCell(o.markdown)}`);
            }
            lines.push("");
          }
        }
      }
    }

    return `${lines.join("\n").trimEnd()}\n`;
  }

  async listExports(): Promise<ExportListing[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.env.exportsDir);
    } catch {
      return [];
    }
    const out: ExportListing[] = [];
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const filePath = path.join(this.env.exportsDir, name);
      try {
        const st = await fs.stat(filePath);
        if (!st.isFile()) continue;
        out.push({ filename: name, path: filePath, size: st.size, modified: new Date(st.mtimeMs).toISOString() });
      } catch {
        /* skip */
      }
    }
    out.sort((a, b) => b.modified.localeCompare(a.modified));
    return out;
  }
}
