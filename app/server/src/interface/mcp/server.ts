/**
 * Builds the AiDailyTaks MCP server: exposes the board's application services as MCP
 * tools so an agent can read/create/update tasks, manage projects, and inspect the
 * config/graph. The same builder backs BOTH transports — stdio (mcp.ts) and the
 * Streamable-HTTP mount (http.ts) — so they present an identical tool set.
 *
 * Tool inputs are validated with the shared contract schemas (single source of truth);
 * baseRev is optional on writes — when omitted we read the task's current rev first, which
 * is friendlier for a model at the (accepted) cost of a wider optimistic-concurrency window.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CreateRequestSchema,
  TaskFilterSchema,
  STATUSES,
  CATEGORIES,
  LEVELS,
  type EditableFields,
  type PatchRequest,
  type TaskDetailOrInvalid,
} from "@AiDailyTaks/shared";
import type { Services } from "../http/routes";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}
function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Names + one-liners for the registered tools — surfaced by GET /api/mcp-info for the Connect page. */
export const MCP_TOOL_SUMMARY: { name: string; description: string }[] = [
  { name: "list_tasks", description: "List board tasks (summaries) with optional filters." },
  { name: "get_task", description: "Read one task in full (frontmatter, summary, scope, observations)." },
  { name: "create_task", description: "Create a task; the id is auto-assigned." },
  { name: "update_task", description: "Patch a task's fields and/or summary/scope." },
  { name: "add_observation", description: "Append a timestamped note to a task's Observations log." },
  { name: "archive_task", description: "Archive a task (hide from the board)." },
  { name: "unarchive_task", description: "Restore an archived task." },
  { name: "list_projects", description: "List configured projects." },
  { name: "add_project", description: "Add a project to the local projects.json." },
  { name: "get_config", description: "Board vocabulary: statuses, categories, severities, risks, projects." },
  { name: "get_graph", description: "Task relationship graph (depends_on / blocks / relates_to / parent)." },
];

/** Message for the standard { conflict, current } result. */
const CONFLICT_MSG =
  "Conflict: the task changed on disk since it was read. Re-read the task and retry with its current rev.";

export function buildMcpServer(services: Services, version = "1.0.0"): McpServer {
  const server = new McpServer({ name: "AiDailyTaks", version });

  // ── Read ───────────────────────────────────────────────────────────────────
  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List board tasks (summaries) with optional filters. Archived tasks are excluded by default.",
      inputSchema: {
        project: z.string().optional(),
        status: z.array(z.enum(STATUSES)).optional(),
        category: z.array(z.enum(CATEGORIES)).optional(),
        severity: z.array(z.enum(LEVELS)).optional(),
        tag: z.string().optional(),
        q: z.string().optional().describe("Full-text search over title/summary/scope"),
        archived: z.enum(["exclude", "only", "include"]).optional(),
        sort: z
          .enum(["id", "title", "status", "severity", "risk", "category", "updated", "created", "completed", "project"])
          .optional(),
        order: z.enum(["asc", "desc"]).optional(),
      },
    },
    async (args) => {
      const parsed = TaskFilterSchema.safeParse(args);
      if (!parsed.success) return fail(`Invalid filter: ${parsed.error.message}`);
      const tasks = await services.tasks.list(parsed.data);
      const rows = tasks.map((t) =>
        t.valid
          ? {
              id: t.id,
              title: t.title,
              status: t.status,
              category: t.category,
              severity: t.severity,
              project: t.project,
              updated: t.updatedEffective,
              completed: t.completed,
              archived: t.archived,
              rev: t.rev,
            }
          : { id: t.id, valid: false, parseError: t.parseError },
      );
      return ok({ count: rows.length, tasks: rows });
    },
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description: "Read one task in full: frontmatter, summary, scope, observations, attachments.",
      inputSchema: { id: z.string().describe("Task id, e.g. C09") },
    },
    async ({ id }) => {
      const t = await services.tasks.get(id);
      if (!t.valid) return fail(`Task ${id} is invalid: ${t.parseError}`);
      return ok({
        id: t.id,
        title: t.title,
        project: t.project,
        category: t.category,
        severity: t.severity,
        risk: t.risk,
        status: t.status,
        status_detail: t.status_detail,
        created: t.created,
        updated: t.updated,
        completed: t.completed,
        archived: t.archived,
        tags: t.tags,
        depends_on: t.depends_on,
        blocks: t.blocks,
        relates_to: t.relates_to,
        parent: t.parent,
        children: t.children,
        rev: t.rev,
        summary: t.summaryMarkdown,
        scope: t.scopeMarkdown,
        observations: t.observations,
        attachments: t.attachments.map((a) => ({ name: a.name, size: a.size, url: a.url })),
      });
    },
  );

  // ── Write: tasks ─────────────────────────────────────────────────────────────
  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Create a task. The id is auto-assigned (next available). Only title and category are required.",
      inputSchema: {
        title: z.string().min(1),
        category: z.enum(CATEGORIES),
        project: z.string().optional(),
        severity: z.enum(LEVELS).optional(),
        risk: z.enum(LEVELS).optional(),
        status: z.enum(STATUSES).optional(),
        status_detail: z.string().optional(),
        summary: z.string().optional(),
        scope: z.string().optional(),
        tags: z.array(z.string()).optional(),
        depends_on: z.array(z.string()).optional(),
        blocks: z.array(z.string()).optional(),
        relates_to: z.array(z.string()).optional(),
        parent: z.string().nullable().optional(),
      },
    },
    async (args) => {
      const parsed = CreateRequestSchema.safeParse(args);
      if (!parsed.success) return fail(`Invalid task: ${parsed.error.message}`);
      const task = await services.tasks.create(parsed.data);
      return ok({ id: task.id, rev: task.rev, title: task.title, status: task.status });
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Patch a task's fields and/or summary/scope. Pass baseRev for optimistic concurrency; if omitted, the current rev is used.",
      inputSchema: {
        id: z.string(),
        baseRev: z.number().optional(),
        title: z.string().optional(),
        status: z.enum(STATUSES).optional(),
        category: z.enum(CATEGORIES).optional(),
        severity: z.enum(LEVELS).optional(),
        risk: z.enum(LEVELS).optional(),
        project: z.string().optional(),
        status_detail: z.string().optional(),
        tags: z.array(z.string()).optional(),
        depends_on: z.array(z.string()).optional(),
        blocks: z.array(z.string()).optional(),
        relates_to: z.array(z.string()).optional(),
        parent: z.string().nullable().optional(),
        summary: z.string().optional(),
        scope: z.string().optional(),
      },
    },
    async (args) => {
      const { id, baseRev, summary, scope, ...fields } = args;
      const rev = await resolveRev(services, id, baseRev);
      if (rev === null) return fail(`Task ${id} not found or invalid.`);
      const editable = fields as EditableFields;
      const body: PatchRequest = {
        baseRev: rev,
        fields: Object.keys(editable).length > 0 ? editable : undefined,
        body: summary !== undefined || scope !== undefined ? { summary, scope } : undefined,
      };
      const res = await services.tasks.patch(id, body);
      if (res.conflict) return fail(CONFLICT_MSG);
      return ok({ id: res.task.id, rev: res.task.rev, status: res.task.status, updated: res.task.updated });
    },
  );

  server.registerTool(
    "add_observation",
    {
      title: "Add observation",
      description: "Append a timestamped note under a task's Observations log.",
      inputSchema: {
        id: z.string(),
        text: z.string().min(1),
        author: z.string().optional().describe('Defaults to "claude"'),
        baseRev: z.number().optional(),
      },
    },
    async ({ id, text, author, baseRev }) => {
      const rev = await resolveRev(services, id, baseRev);
      if (rev === null) return fail(`Task ${id} not found or invalid.`);
      const res = await services.tasks.addObservation(id, {
        baseRev: rev,
        author: author ?? "claude",
        text,
      });
      if (res.conflict) return fail(CONFLICT_MSG);
      return ok({ id: res.task.id, rev: res.task.rev, observationCount: res.task.observations.length });
    },
  );

  server.registerTool(
    "archive_task",
    {
      title: "Archive task",
      description: "Archive a task (hides it from the board; kept in the Archive view).",
      inputSchema: { id: z.string(), baseRev: z.number().optional() },
    },
    async ({ id, baseRev }) => {
      const res = await services.tasks.archive(id, baseRev);
      if (res.conflict) return fail(CONFLICT_MSG);
      return ok({ id: res.task.id, archived: res.task.archived, rev: res.task.rev });
    },
  );

  server.registerTool(
    "unarchive_task",
    {
      title: "Unarchive task",
      description: "Restore an archived task back to the board.",
      inputSchema: { id: z.string(), baseRev: z.number().optional() },
    },
    async ({ id, baseRev }) => {
      const res = await services.tasks.unarchive(id, baseRev);
      if (res.conflict) return fail(CONFLICT_MSG);
      return ok({ id: res.task.id, archived: res.task.archived, rev: res.task.rev });
    },
  );

  // ── Projects & config ────────────────────────────────────────────────────────
  server.registerTool(
    "list_projects",
    { title: "List projects", description: "List configured projects." },
    async () => ok({ projects: services.projects.list() }),
  );

  server.registerTool(
    "add_project",
    {
      title: "Add project",
      description: "Add a project to the local projects.json.",
      inputSchema: { id: z.string().min(1), label: z.string().optional() },
    },
    async ({ id, label }) => {
      const projects = await services.projects.add({ id, label });
      return ok({ projects });
    },
  );

  server.registerTool(
    "get_config",
    {
      title: "Get board config",
      description: "The board vocabulary: statuses, categories, severities, risks, projects.",
    },
    async () => ok({ ...services.config.get(), projects: services.projects.list() }),
  );

  server.registerTool(
    "get_graph",
    {
      title: "Get relationship graph",
      description: "Nodes + edges (depends_on / blocks / relates_to / parent) across tasks.",
      inputSchema: { project: z.string().optional() },
    },
    async ({ project }) => ok(await services.graph.build(project)),
  );

  return server;
}

/** Resolve the rev to use for a write: the caller's baseRev, or the task's current rev. Null if missing/invalid. */
async function resolveRev(
  services: Services,
  id: string,
  baseRev: number | undefined,
): Promise<number | null> {
  if (baseRev !== undefined) return baseRev;
  let current: TaskDetailOrInvalid;
  try {
    current = await services.tasks.get(id);
  } catch {
    return null;
  }
  return current.valid ? current.rev : null;
}
