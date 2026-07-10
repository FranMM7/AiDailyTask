/**
 * AiDailyTaks — shared API contract.
 *
 * Single source of truth for the shapes exchanged between the Fastify server
 * and the React web app. Imported by BOTH `app/server` and `app/web`.
 *
 * The canonical vocabularies below MUST mirror `board.config.json` at the repo
 * root (the config carries colors/order; these arrays carry the allowed values
 * for compile-time typing + runtime zod validation). The server validates the
 * loaded config against these at boot.
 *
 * Note: the severity/risk values use an EN DASH (–, U+2013) in the compound
 * labels ("Low–Med", "Med–High"), matching the source audit. Keep it exact.
 */
import { z } from "zod";

// ── Canonical vocabularies ─────────────────────────────────────────────────
export const STATUSES = ["Backlog", "Not started", "Scoped", "In progress", "Completed"] as const;
export type Status = (typeof STATUSES)[number];

export const CATEGORIES = ["Refactor", "Bug", "Feature", "UX", "Arch", "Org"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Severity and Risk share this 5-level ordinal scale. */
export const LEVELS = ["Low", "Low–Med", "Medium", "Med–High", "High"] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_RANK: Record<Level, number> = {
  Low: 1,
  "Low–Med": 2,
  Medium: 3,
  "Med–High": 4,
  High: 5,
};

export const STATUS_ORDER: Record<Status, number> = {
  Backlog: 0,
  "Not started": 1,
  Scoped: 2,
  "In progress": 3,
  Completed: 4,
};

export const ID_PATTERN = /^C\d+$/;

// ── Frontmatter (persisted in each task.md) ─────────────────────────────────
export const FrontmatterSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  title: z.string().min(1),
  project: z.string().default("Sample"),
  category: z.enum(CATEGORIES),
  severity: z.enum(LEVELS),
  risk: z.enum(LEVELS),
  status: z.enum(STATUSES),
  status_detail: z.string().default(""),
  created: z.string().optional(),
  updated: z.string().optional(),
  completed: z.string().optional(),
  /** True once the task has been archived (completed and aged out, or archived manually). */
  archived: z.boolean().default(false),
  /** Date (YYYY-MM-DD) the task was archived; omitted while active. */
  archived_at: z.string().optional(),
  tags: z.array(z.string()).default([]),
  depends_on: z.array(z.string()).default([]),
  blocks: z.array(z.string()).default([]),
  relates_to: z.array(z.string()).default([]),
  parent: z.string().nullable().default(null),
  children: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
});
export type Frontmatter = z.infer<typeof FrontmatterSchema>;

/** Editable frontmatter subset accepted by PATCH. */
export const EditableFieldsSchema = FrontmatterSchema.pick({
  title: true,
  project: true,
  category: true,
  severity: true,
  risk: true,
  status: true,
  status_detail: true,
  completed: true,
  tags: true,
  depends_on: true,
  blocks: true,
  relates_to: true,
  parent: true,
  children: true,
}).partial();
export type EditableFields = z.infer<typeof EditableFieldsSchema>;

// ── Sub-objects ─────────────────────────────────────────────────────────────
export interface Observation {
  /** ISO-8601 UTC timestamp, e.g. 2026-07-07T15:17:00Z */
  at: string;
  /** "human" | "claude" | free-form */
  author: string;
  markdown: string;
}

export interface Attachment {
  name: string;
  size: number;
  mime: string;
  /** ISO-8601 UTC */
  modified: string;
  /** relative API url to fetch the file, e.g. /api/tasks/C41/attachments/log.txt */
  url: string;
}

// ── API response DTOs ────────────────────────────────────────────────────────
export interface TaskSummary extends Frontmatter {
  /** concurrency token = file mtimeMs */
  rev: number;
  valid: true;
  excerpt: string;
  attachmentCount: number;
  observationCount: number;
  /** max(frontmatter.updated, file mtime) as ISO-8601 */
  updatedEffective: string;
}

export interface TaskDetail extends Frontmatter {
  rev: number;
  valid: true;
  summaryMarkdown: string;
  scopeMarkdown: string;
  observations: Observation[];
  attachments: Attachment[];
  rawBody: string;
  updatedEffective: string;
}

/** A task.md that failed frontmatter validation — still surfaced, never crashes the board. */
export interface InvalidTask {
  id: string;
  valid: false;
  rev: number;
  parseError: string;
  rawFrontmatter?: string;
  rawBody?: string;
}

export type TaskSummaryOrInvalid = TaskSummary | InvalidTask;
export type TaskDetailOrInvalid = TaskDetail | InvalidTask;

// ── API request DTOs ─────────────────────────────────────────────────────────
export const PatchRequestSchema = z.object({
  baseRev: z.number(),
  fields: EditableFieldsSchema.optional(),
  body: z
    .object({
      summary: z.string().optional(),
      scope: z.string().optional(),
    })
    .optional(),
});
export type PatchRequest = z.infer<typeof PatchRequestSchema>;

export const CreateRequestSchema = z.object({
  /** optional explicit id ("C99"); when omitted the server allocates max+1 */
  id: z.string().regex(ID_PATTERN).optional(),
  title: z.string().min(1),
  project: z.string().default("Sample"),
  category: z.enum(CATEGORIES),
  severity: z.enum(LEVELS).default("Medium"),
  risk: z.enum(LEVELS).default("Low"),
  status: z.enum(STATUSES).default("Not started"),
  status_detail: z.string().default(""),
  tags: z.array(z.string()).default([]),
  depends_on: z.array(z.string()).default([]),
  blocks: z.array(z.string()).default([]),
  relates_to: z.array(z.string()).default([]),
  parent: z.string().nullable().default(null),
  summary: z.string().default(""),
  scope: z.string().default(""),
});
export type CreateRequest = z.infer<typeof CreateRequestSchema>;

export const ObservationRequestSchema = z.object({
  baseRev: z.number(),
  author: z.string().default("human"),
  text: z.string().min(1),
  /** optional ISO timestamp; server stamps now() if omitted */
  at: z.string().optional(),
});
export type ObservationRequest = z.infer<typeof ObservationRequestSchema>;

/** Query params for GET /tasks. Arrays may arrive as repeated query keys or CSV. */
export const TaskFilterSchema = z.object({
  project: z.string().optional(),
  status: z.array(z.enum(STATUSES)).optional(),
  category: z.array(z.enum(CATEGORIES)).optional(),
  severity: z.array(z.enum(LEVELS)).optional(),
  tag: z.string().optional(),
  q: z.string().optional(),
  /** Date-range filter: which date field to test, plus an inclusive [from, to] window (YYYY-MM-DD). */
  dateField: z.enum(["created", "updated", "completed"]).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  /** Archived visibility: "exclude" (default, hide archived), "only" (Archive view), "include" (both). */
  archived: z.enum(["exclude", "only", "include"]).default("exclude"),
  sort: z
    .enum(["id", "title", "status", "severity", "risk", "category", "updated", "created", "completed", "project"])
    .default("id"),
  order: z.enum(["asc", "desc"]).default("asc"),
});
export type TaskFilter = z.infer<typeof TaskFilterSchema>;

/** A configurable project. `projects` live in a local (git-ignored) projects.json, not board.config.json. */
export interface ProjectDef {
  id: string;
  label: string;
}
export const CreateProjectRequestSchema = z.object({
  id: z.string().trim().min(1),
  /** Display label; defaults to the id when omitted. */
  label: z.string().trim().min(1).optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const ExportRequestSchema = z.object({
  statuses: z.array(z.enum(STATUSES)).optional(),
  categories: z.array(z.enum(CATEGORIES)).optional(),
  projects: z.array(z.string()).optional(),
  severities: z.array(z.enum(LEVELS)).optional(),
  includeObservations: z.boolean().default(false),
  includeScope: z.boolean().default(false),
  groupBy: z.enum(["status", "category", "project", "none"]).default("status"),
  title: z.string().optional(),
});
export type ExportRequest = z.infer<typeof ExportRequestSchema>;

export interface ExportResult {
  filename: string;
  path: string;
  markdown: string;
  taskCount: number;
}

// ── Graph ─────────────────────────────────────────────────────────────────────
export interface GraphNode {
  id: string;
  title: string;
  status: Status;
  category: Category;
  severity: Level;
  project: string;
  parent: string | null;
  umbrella: boolean;
}
export type GraphEdgeType = "depends_on" | "blocks" | "relates_to" | "parent";
export interface GraphEdge {
  source: string;
  target: string;
  type: GraphEdgeType;
}
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── MCP connection info (GET /api/mcp-info) ─────────────────────────────────────
export interface McpToolInfo {
  name: string;
  description: string;
}
export interface McpInfo {
  serverName: string;
  /** Streamable-HTTP transport mounted on the running server. */
  http: { url: string };
  /** stdio transport an agent spawns locally. */
  stdio: { command: string; args: string[]; cwd: string };
  tools: McpToolInfo[];
}

// ── Config ─────────────────────────────────────────────────────────────────────
export interface EnumDef {
  id: string;
  label?: string;
  color: string;
  order?: number;
  rank?: number;
}
export interface BoardConfig {
  idPrefix: string;
  idPad: number;
  statuses: EnumDef[];
  categories: EnumDef[];
  severities: EnumDef[];
  risks: EnumDef[];
  /** Loaded from local projects.json and merged into the /api/config response. */
  projects: ProjectDef[];
  card: { colorBy: "category" | "severity" };
  /** Board view tuning. `completedColumnLimit` caps how many (most-recent) cards the Completed column shows. */
  board?: { completedColumnLimit?: number };
  /** Auto-archive policy. Completed tasks older than `autoArchiveDays` are archived by a server sweep. */
  archive?: { autoArchiveDays: number };
}

// ── SSE events (pushed to the browser over GET /api/events) ─────────────────────
export type SseEvent =
  | { type: "hello"; ts: number }
  | { type: "task.created"; id: string; task: TaskSummary }
  | { type: "task.updated"; id: string; task: TaskSummary; rev: number }
  | { type: "task.deleted"; id: string }
  | { type: "task.invalid"; id: string; parseError: string }
  | { type: "attachments.changed"; id: string }
  | { type: "config.updated" };

// ── Error envelope ──────────────────────────────────────────────────────────────
export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
/** 409 body on optimistic-concurrency conflict. */
export interface ConflictResponse {
  conflict: true;
  current: TaskDetailOrInvalid;
}

// ── Helpers shared by both sides ─────────────────────────────────────────────────
export function padId(num: number, prefix = "C", pad = 2): string {
  return `${prefix}${String(num).padStart(pad, "0")}`;
}
/** "C9" | "C09" -> numeric 9; returns NaN if not a task id. */
export function idNum(id: string): number {
  const m = /^C0*(\d+)$/.exec(id);
  return m ? Number(m[1]) : NaN;
}
/** Normalize any "C9"/"C09" reference to canonical zero-padded "C09". */
export function normalizeId(id: string, prefix = "C", pad = 2): string {
  const n = idNum(id);
  return Number.isNaN(n) ? id : padId(n, prefix, pad);
}
