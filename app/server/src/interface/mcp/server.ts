/**
 * Builds the AiDailyTasks MCP server: exposes the board's application services as MCP
 * tools so an agent can read/create/update tasks, manage projects, and inspect the
 * config/graph. The same builder backs BOTH transports — stdio (mcp.ts) and the
 * Streamable-HTTP mount (http.ts) — so they present an identical tool set.
 *
 * Tool inputs are validated with the shared contract schemas (single source of truth);
 * baseRev is optional on writes — when omitted we read the task's current rev first, which
 * is friendlier for a model at the (accepted) cost of a wider optimistic-concurrency window.
 */
import type { ReadStream } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CreateRequestSchema,
  TaskFilterSchema,
  normalizeId,
  type EditableFields,
  type PatchRequest,
  type TaskDetailOrInvalid,
} from "@AiDailyTasks/shared";
import type { Services } from "../http/routes";

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource";
      resource:
        | { uri: string; mimeType?: string; text: string }
        | { uri: string; mimeType?: string; blob: string };
    };

type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
};

/** Cap on inline attachment fetches; larger files must be downloaded over HTTP. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Collect a readable stream into a single Buffer. */
async function collectStream(stream: ReadStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

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
  { name: "get_task", description: "Read one task in full; may include a ready-Graphify study hint." },
  { name: "create_task", description: "Create a task; the id is auto-assigned." },
  { name: "update_task", description: "Patch a task's fields and/or summary/scope." },
  { name: "delete_task", description: "Permanently delete an archived task after revision confirmation." },
  { name: "add_observation", description: "Append a timestamped note to a task's Observations log." },
  { name: "list_attachments", description: "List the files attached to a task (name, size, mime, url)." },
  { name: "get_attachment", description: "Fetch one of a task's attachments by filename (image/text/base64)." },
  { name: "upload_attachment", description: "Upload a text or base64 file to a task." },
  { name: "delete_attachment", description: "Permanently delete one attachment from a task." },
  { name: "archive_task", description: "Archive a task; completed recurring work creates one successor." },
  { name: "unarchive_task", description: "Restore an archived task." },
  { name: "list_projects", description: "List configured projects (id, label, source root)." },
  { name: "get_project", description: "Read one project's metadata, documentation, and code-graph status." },
  { name: "add_project", description: "Add a project to the local projects.json (optional source root)." },
  { name: "update_project", description: "Edit a project's label and/or source root path." },
  { name: "get_project_documentation", description: "Get project details, agent instructions, and imported README." },
  { name: "update_project_documentation", description: "Save project-specific Markdown instructions for people and agents." },
  { name: "import_project_readme", description: "Copy a project's root README into its private documentation store." },
  { name: "get_config", description: "Board vocabulary: statuses, categories, severities, risks, projects." },
  { name: "update_config", description: "Update local board vocabulary and workspace visibility preferences." },
  { name: "get_graph", description: "Task relationship graph (depends_on / blocks / relates_to / parent)." },
  { name: "generate_code_graph", description: "Build/refresh a project's code graph (async; built-in or graphify per project)." },
  { name: "refresh_code_graph", description: "Explicitly rebuild a project's current built-in or Graphify index." },
  { name: "get_code_graph", description: "Code-graph status + overview (hubs, folders, kinds); set full=true for all nodes/edges." },
  { name: "query_code_graph", description: "A file/symbol's dependencies/dependents (kind + relation aware) — avoids re-reading the repo." },
  { name: "graphify_query", description: "Natural-language question answered from the graphify knowledge graph (needs graphify indexer)." },
  { name: "graphify_affected", description: "Blast radius: what a change to a node impacts (graphify indexer)." },
  { name: "graphify_explain", description: "Plain-language explanation of a node and its neighbors (graphify indexer)." },
  { name: "graphify_path", description: "Shortest path between two nodes in the graphify graph (graphify indexer)." },
];

/** Message for the standard { conflict, current } result. */
const CONFLICT_MSG =
  "Conflict: the task changed on disk since it was read. Re-read the task and retry with its current rev.";

export function buildMcpServer(services: Services, version = "1.0.0"): McpServer {
  const server = new McpServer({ name: "AiDailyTasks", version });
  // One McpServer instance is created per HTTP session (and once per stdio process),
  // so this keeps the advisory useful without repeating it on every task read.
  const graphifyHintsShown = new Set<string>();

  // ── Read ───────────────────────────────────────────────────────────────────
  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List board tasks (summaries) with optional filters. Archived tasks are excluded by default.",
      inputSchema: {
        project: z.string().optional(),
        status: z.array(z.string()).optional(),
        category: z.array(z.string()).optional(),
        severity: z.array(z.string()).optional(),
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
              recurring: t.recurring,
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
      description:
        "Read one task in full: frontmatter, summary, scope, observations, attachments. " +
        "The first eligible read in a session may include a non-blocking Graphify study hint.",
      inputSchema: { id: z.string().describe("Task id, e.g. C09") },
    },
    async ({ id }) => {
      const t = await services.tasks.get(id);
      if (!t.valid) return fail(`Task ${id} is invalid: ${t.parseError}`);

      const hintKey = t.project;
      let projectStudyHint: {
        label: string;
        project: string;
        recommended_tool: "graphify_query";
        message: string;
      } | undefined;
      if (!graphifyHintsShown.has(hintKey) && (await services.codeGraph.hasReadyGraphify(t.project))) {
        graphifyHintsShown.add(hintKey);
        projectStudyHint = {
          label: "Ready Graphify project context",
          project: t.project,
          recommended_tool: "graphify_query",
          message:
            `A ready Graphify index is available for ${t.project}. Before substantial work, ` +
            "consider graphify_query for a quick architecture study. This is advisory; no graph " +
            "query or refresh has run.",
        };
      }

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
        skills: t.skills,
        skill_details: t.skills.map((id) => {
          const configured = services.config.get().skills.find((skill) => skill.id === id);
          return {
            id,
            title: configured?.id ?? id,
            instructions:
              configured?.instructions ??
              (configured?.label && configured.label !== configured.id ? configured.label : ""),
            configured: Boolean(configured),
          };
        }),
        recurring: t.recurring,
        recurrence_of: t.recurrence_of,
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
        ...(projectStudyHint ? { project_study_hint: projectStudyHint } : {}),
      });
    },
  );

  server.registerTool(
    "list_attachments",
    {
      title: "List attachments",
      description:
        "List the files attached to a task: name, size (bytes), mime type, last-modified, and download url. " +
        "Use get_attachment to fetch a file's contents.",
      inputSchema: { id: z.string().describe("Task id, e.g. C09") },
    },
    async ({ id }) => {
      try {
        const attachments = await services.attachments.list(id);
        return ok({ id: normalizeId(id), count: attachments.length, attachments });
      } catch (err) {
        return fail(`Cannot list attachments for ${id}: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Get attachment",
      description:
        "Fetch one of a task's attachments by filename. Images are returned as image content, text files " +
        "(text/*, application/json) as text, and any other type as a base64 resource. Use list_attachments " +
        "first to get exact filenames.",
      inputSchema: {
        id: z.string().describe("Task id, e.g. C09"),
        name: z.string().describe("Attachment filename, exactly as returned by list_attachments"),
      },
    },
    async ({ id, name }) => {
      let file: Awaited<ReturnType<Services["attachments"]["read"]>>;
      try {
        file = await services.attachments.read(id, name);
      } catch (err) {
        return fail(`Attachment not found: ${name} (task ${id}) — ${(err as Error).message}`);
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        return fail(
          `Attachment ${name} is ${file.size} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte inline limit. ` +
            `Download it over HTTP at /api/tasks/${normalizeId(id)}/attachments/${encodeURIComponent(name)}.`,
        );
      }
      const buffer = await collectStream(file.stream());
      const mimeType = file.mime;
      if (/^image\//.test(mimeType)) {
        return { content: [{ type: "image", data: buffer.toString("base64"), mimeType }] };
      }
      if (/^text\//.test(mimeType) || mimeType === "application/json") {
        return { content: [{ type: "text", text: buffer.toString("utf8") }] };
      }
      return {
        content: [
          {
            type: "resource",
            resource: {
              uri: `file:///${normalizeId(id)}/files/${encodeURIComponent(name)}`,
              mimeType,
              blob: buffer.toString("base64"),
            },
          },
        ],
      };
    },
  );

  server.registerTool(
    "upload_attachment",
    {
      title: "Upload attachment",
      description:
        "Attach one file to a task. Provide exactly one of `text` (UTF-8 content) or `base64` (binary content). " +
        "The server sanitizes and de-duplicates the filename.",
      inputSchema: {
        id: z.string().describe("Task id, e.g. C09"),
        filename: z.string().min(1),
        text: z.string().optional().describe("UTF-8 text file content"),
        base64: z.string().optional().describe("Base64-encoded binary file content"),
      },
    },
    async ({ id, filename, text, base64 }) => {
      if ((text === undefined) === (base64 === undefined)) {
        return fail("Provide exactly one of text or base64.");
      }
      let data: Buffer;
      try {
        data = text !== undefined ? Buffer.from(text, "utf8") : Buffer.from(base64!, "base64");
      } catch (err) {
        return fail(`Invalid attachment content: ${(err as Error).message}`);
      }
      if (data.byteLength > MAX_ATTACHMENT_BYTES) {
        return fail(`Attachment is over the ${MAX_ATTACHMENT_BYTES}-byte MCP upload limit.`);
      }
      try {
        const attachments = await services.attachments.saveMany(id, [{ filename, data }]);
        return ok({ id: normalizeId(id), attachment: attachments[0] });
      } catch (err) {
        return fail(`Cannot upload attachment to ${id}: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "delete_attachment",
    {
      title: "Delete attachment",
      description: "Permanently delete one task attachment by its exact filename.",
      inputSchema: {
        id: z.string().describe("Task id, e.g. C09"),
        name: z.string().min(1).describe("Exact filename returned by list_attachments"),
        confirm: z.literal(true).describe("Must be true because this cannot be undone"),
      },
    },
    async ({ id, name }) => {
      try {
        await services.attachments.delete(id, name);
        return ok({ id: normalizeId(id), deleted: name });
      } catch (err) {
        return fail(`Cannot delete attachment ${name} from ${id}: ${(err as Error).message}`);
      }
    },
  );

  // ── Write: tasks ─────────────────────────────────────────────────────────────
  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Create a task. The id is auto-assigned unless an available explicit id is provided. Only title and category are required.",
      inputSchema: {
        id: z.string().optional().describe("Optional explicit task id, e.g. C99"),
        title: z.string().min(1),
        category: z.string().min(1),
        project: z.string().optional(),
        severity: z.string().min(1).optional(),
        risk: z.string().min(1).optional(),
        status: z.string().min(1).optional(),
        status_detail: z.string().optional(),
        summary: z.string().optional(),
        scope: z.string().optional(),
        tags: z.array(z.string()).optional(),
        skills: z.array(z.string()).optional().describe("Agent execution expectations, e.g. Senior frontend engineer"),
        recurring: z.boolean().optional().describe("Create a new Backlog occurrence when completed and archived"),
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
        status: z.string().min(1).optional(),
        category: z.string().min(1).optional(),
        severity: z.string().min(1).optional(),
        risk: z.string().min(1).optional(),
        project: z.string().optional(),
        status_detail: z.string().optional(),
        tags: z.array(z.string()).optional(),
        skills: z.array(z.string()).optional(),
        recurring: z.boolean().optional(),
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
    "delete_task",
    {
      title: "Delete task permanently",
      description:
        "Permanently delete a task and all of its attachments. The task must already be archived; " +
        "pass its current revision and confirm=true. This cannot be undone.",
      inputSchema: {
        id: z.string(),
        baseRev: z.number().describe("Exact current revision returned by get_task"),
        confirm: z.literal(true),
      },
    },
    async ({ id, baseRev }) => {
      try {
        const res = await services.tasks.delete(id, baseRev);
        if (res.conflict) return fail(CONFLICT_MSG);
        return ok({ id: res.id, deleted: true });
      } catch (err) {
        return fail(`Cannot delete task ${id}: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "archive_task",
    {
      title: "Archive task",
      description:
        "Archive a task (hides it from the board; kept in the Archive view). A completed recurring task creates one Backlog successor.",
      inputSchema: { id: z.string(), baseRev: z.number().optional() },
    },
    async ({ id, baseRev }) => {
      const res = await services.tasks.archive(id, baseRev);
      if (res.conflict) return fail(CONFLICT_MSG);
      return ok({
        id: res.task.id,
        archived: res.task.archived,
        rev: res.task.rev,
        ...(res.successor
          ? { successor: { id: res.successor.id, status: res.successor.status, rev: res.successor.rev } }
          : {}),
      });
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
    "get_project",
    {
      title: "Get project",
      description: "Read one project's metadata, agent instructions, imported README, and current code-graph status.",
      inputSchema: { project: z.string().min(1) },
    },
    async ({ project }) => {
      try {
        const documentation = await services.projectDocumentation.get(project);
        const graph = await services.codeGraph.getGraph(project);
        return ok({ ...documentation, codeGraph: graph.meta });
      } catch (err) {
        return fail(`Cannot read project ${project}: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "add_project",
    {
      title: "Add project",
      description:
        "Add a project to the local projects.json. Pass `root` (absolute source path) to enable code-graph " +
        "generation, and `indexer` to choose the engine (default 'builtin').",
      inputSchema: {
        id: z.string().min(1),
        label: z.string().optional(),
        root: z.string().optional().describe("Absolute path to the project's source tree"),
        indexer: z
          .enum(["builtin", "graphify"])
          .optional()
          .describe("Code-graph engine: 'builtin' (file-level) or 'graphify' (symbols + calls)"),
      },
    },
    async ({ id, label, root, indexer }) => {
      const projects = await services.projects.add({ id, label, root, indexer });
      return ok({ projects });
    },
  );

  server.registerTool(
    "update_project",
    {
      title: "Update project",
      description:
        "Edit an existing project's label, source root, and/or code-graph engine (the id is immutable). " +
        "Set root to enable code-graph generation (empty string clears it); set indexer to 'graphify' for the " +
        "richer symbol/call graph or 'builtin' for the file-level scanner.",
      inputSchema: {
        id: z.string().min(1),
        label: z.string().optional(),
        root: z.string().optional().describe("Absolute source path; empty string clears it"),
        indexer: z.enum(["builtin", "graphify"]).optional().describe("Code-graph engine"),
      },
    },
    async ({ id, label, root, indexer }) => {
      if (label === undefined && root === undefined && indexer === undefined) {
        return fail("Provide at least one of label, root, or indexer.");
      }
      try {
        const projects = await services.projects.update(id, { label, root, indexer });
        return ok({ projects });
      } catch (err) {
        return fail(`Cannot update project ${id}: ${(err as Error).message}`);
      }
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
    "update_config",
    {
      title: "Update board config",
      description:
        "Update local board vocabulary and visibility preferences. Read get_config first, preserve protected " +
        "status ids Backlog and Completed, and send the full config object.",
      inputSchema: { config: z.record(z.unknown()) },
    },
    async ({ config }) => {
      try {
        const updated = await services.config.update(config);
        return ok({ ...updated, projects: services.projects.list() });
      } catch (err) {
        return fail(`Cannot update board config: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "get_project_documentation",
    {
      title: "Get project documentation",
      description: "Get a project's configuration, maintained agent instructions, and the last imported README.",
      inputSchema: { project: z.string().min(1) },
    },
    async ({ project }) => {
      try { return ok(await services.projectDocumentation.get(project)); }
      catch (err) { return fail(`Cannot read documentation for ${project}: ${(err as Error).message}`); }
    },
  );

  server.registerTool(
    "update_project_documentation",
    {
      title: "Update project documentation",
      description: "Replace the project-specific Markdown instructions agents should follow when working on this project.",
      inputSchema: { project: z.string().min(1), instructions: z.string().max(500_000) },
    },
    async ({ project, instructions }) => {
      try { return ok(await services.projectDocumentation.update(project, instructions)); }
      catch (err) { return fail(`Cannot update documentation for ${project}: ${(err as Error).message}`); }
    },
  );

  server.registerTool(
    "import_project_readme",
    {
      title: "Import project README",
      description: "Copy the Markdown README from the configured source root into the board's private project documentation store.",
      inputSchema: { project: z.string().min(1) },
    },
    async ({ project }) => {
      try { return ok(await services.projectDocumentation.importReadme(project)); }
      catch (err) { return fail(`Cannot import README for ${project}: ${(err as Error).message}`); }
    },
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

  // ── Code graph (per-project source dependency map) ────────────────────────────
  server.registerTool(
    "generate_code_graph",
    {
      title: "Generate code graph",
      description:
        "Build or refresh a project's code dependency graph by scanning its source root (JS/TS, Python, C#). " +
        "Runs asynchronously and returns immediately with status \"indexing\"; poll get_code_graph until status " +
        "is \"ready\". Requires the project to have a source root (set it via add_project/update_project).",
      inputSchema: { project: z.string().describe("Project id, e.g. my-app") },
    },
    async ({ project }) => {
      try {
        const meta = await services.codeGraph.generate(project);
        return ok({
          project,
          status: meta.status,
          note: "Indexing started. Poll get_code_graph until status is 'ready' (or 'failed').",
        });
      } catch (err) {
        return fail(`Cannot generate code graph for ${project}: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "refresh_code_graph",
    {
      title: "Refresh code graph",
      description:
        "Explicitly rebuild a project's code graph after source changes, using the indexer configured on the project " +
        "('graphify' or 'builtin'). Returns immediately; poll get_code_graph until ready.",
      inputSchema: { project: z.string().min(1) },
    },
    async ({ project }) => {
      try {
        const definition = services.projects.get(project);
        if (!definition) return fail(`Project ${project} not found.`);
        const meta = await services.codeGraph.generate(project);
        return ok({ project, indexer: definition.indexer ?? "builtin", meta });
      } catch (err) {
        return fail(`Cannot refresh code graph for ${project}: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "get_code_graph",
    {
      title: "Get code graph",
      description:
        "A project's code-graph status and overview: file/edge counts, languages, and the most-depended-on " +
        "files (hubs) and folders. Pass full=true to return every node and edge (only for small graphs).",
      inputSchema: {
        project: z.string().describe("Project id, e.g. my-app"),
        full: z.boolean().optional().describe("Return all nodes + edges instead of an overview"),
      },
    },
    async ({ project, full }) => {
      try {
        const { meta, nodes, edges } = await services.codeGraph.getGraph(project);
        if (meta.status !== "ready") {
          return ok({
            project,
            status: meta.status,
            ...(meta.error ? { error: meta.error } : {}),
            note:
              meta.status === "empty"
                ? "No graph yet — run generate_code_graph first."
                : meta.status === "indexing"
                  ? "Still indexing — poll again shortly."
                  : "Generation failed — fix the source root and regenerate.",
          });
        }
        if (full) return ok({ project, meta, nodes, edges });

        const hubs = [...nodes]
          .filter((n) => n.inDegree > 0)
          .sort((a, b) => b.inDegree - a.inDegree)
          .slice(0, 15)
          .map((n) => ({
            label: n.label,
            kind: n.kind,
            file: n.file,
            dependents: n.inDegree,
            dependencies: n.outDegree,
          }));
        const folders = new Map<string, number>();
        for (const n of nodes) folders.set(n.group, (folders.get(n.group) ?? 0) + 1);
        const folderCounts = [...folders.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([group, count]) => ({ group, nodes: count }));

        return ok({
          project,
          status: meta.status,
          indexer: meta.indexer,
          generatedAt: meta.generatedAt,
          nodeCount: meta.nodeCount,
          fileCount: meta.fileCount,
          edgeCount: meta.edgeCount,
          languages: meta.languages,
          nodeKinds: meta.nodeKinds,
          relations: meta.relations,
          truncated: meta.truncated ?? false,
          topHubs: hubs,
          folders: folderCounts,
          note: "Use query_code_graph to inspect a file/symbol's dependencies or dependents, or full=true for everything.",
        });
      } catch (err) {
        return fail(`Cannot read code graph for ${project}: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "query_code_graph",
    {
      title: "Query code graph",
      description:
        "Look up a file OR symbol (function/class/namespace) in a project's code graph and return what it " +
        "depends on and/or what depends on it, up to a given depth — its blast radius, without re-reading the " +
        "codebase. `file` matches an exact path, then id, then basename, then symbol label, then substring. " +
        "Optionally filter to one edge relation (e.g. 'calls' or 'imports').",
      inputSchema: {
        project: z.string().describe("Project id, e.g. my-app"),
        file: z.string().describe("File path, basename, or symbol label, e.g. 'services.ts', 'src/app/main', or 'a()'"),
        direction: z
          .enum(["dependencies", "dependents", "both"])
          .optional()
          .describe("dependencies = what it imports/calls; dependents = what imports/calls it. Default both."),
        relation: z
          .enum(["imports", "imports_from", "contains", "calls", "method", "references"])
          .optional()
          .describe("Only traverse edges of this relation (e.g. 'calls' for the call graph)."),
        depth: z.number().int().min(1).max(4).optional().describe("Traversal depth (default 1)"),
      },
    },
    async ({ project, file, direction, relation, depth }) => {
      try {
        const { meta, nodes, edges } = await services.codeGraph.getGraph(project);
        if (meta.status !== "ready") {
          return fail(
            `Code graph for ${project} is "${meta.status}". Run generate_code_graph and wait for "ready".`,
          );
        }
        const byId = new Map(nodes.map((n) => [n.id, n]));
        const needle = file.toLowerCase();
        const base = needle.split("/").pop()!;
        const describe = (n: (typeof nodes)[number]) => ({
          label: n.label,
          kind: n.kind,
          ...(n.file ? { file: n.file } : {}),
        });

        // Resolve the target node: exact file, exact id, basename, exact label, then substring.
        let match =
          nodes.find((n) => n.file?.toLowerCase() === needle) ??
          nodes.find((n) => n.id.toLowerCase() === needle) ??
          nodes.find((n) => (n.file ? n.file.toLowerCase().split("/").pop() === base : false)) ??
          nodes.find((n) => n.label.toLowerCase() === needle);
        if (!match) {
          const subs = nodes.filter(
            (n) => n.file?.toLowerCase().includes(needle) || n.label.toLowerCase().includes(needle),
          );
          if (subs.length === 1) match = subs[0];
          else if (subs.length > 1) {
            return ok({
              project,
              ambiguous: true,
              candidates: subs.slice(0, 25).map(describe),
              note: "Several nodes match — call again with a fuller path or exact symbol label.",
            });
          }
        }
        if (!match) return fail(`No file or symbol matching "${file}" in ${project}'s code graph.`);

        interface Adj {
          to: string;
          relation: string;
        }
        const out = new Map<string, Adj[]>();
        const inc = new Map<string, Adj[]>();
        const push = (m: Map<string, Adj[]>, k: string, v: Adj): void => {
          const arr = m.get(k);
          if (arr) arr.push(v);
          else m.set(k, [v]);
        };
        for (const e of edges) {
          if (relation && e.relation !== relation) continue;
          push(out, e.source, { to: e.target, relation: e.relation });
          push(inc, e.target, { to: e.source, relation: e.relation });
        }

        const maxDepth = depth ?? 1;
        const walk = (start: string, adj: Map<string, Adj[]>) => {
          const seen = new Set([start]);
          const result: Record<string, unknown>[] = [];
          let frontier = [start];
          for (let d = 1; d <= maxDepth; d++) {
            const nextFrontier: string[] = [];
            for (const cur of frontier) {
              for (const { to, relation: r } of adj.get(cur) ?? []) {
                if (seen.has(to)) continue;
                seen.add(to);
                const n = byId.get(to);
                result.push({ ...(n ? describe(n) : { label: to, kind: "external" }), relation: r, depth: d });
                nextFrontier.push(to);
              }
            }
            frontier = nextFrontier;
            if (frontier.length === 0) break;
          }
          return result;
        };

        const dir = direction ?? "both";
        const payload: Record<string, unknown> = { project, node: describe(match), depth: maxDepth };
        if (relation) payload.relation = relation;
        if (dir === "dependencies" || dir === "both") payload.dependencies = walk(match.id, out);
        if (dir === "dependents" || dir === "both") payload.dependents = walk(match.id, inc);
        return ok(payload);
      } catch (err) {
        return fail(`Cannot query code graph for ${project}: ${(err as Error).message}`);
      }
    },
  );

  // ── Graphify passthrough (native semantic queries over the graphify graph) ─────
  // These run graphify's own subcommands against the project's graphify graph.json.
  // They require the project to have been generated with the "graphify" indexer.
  const graphifyText = async (project: string, args: string[], label: string): Promise<ToolResult> => {
    try {
      const text = await services.codeGraph.runGraphifyText(project, args);
      return ok(text || `(${label} returned no output)`);
    } catch (err) {
      return fail(`graphify ${label} failed for ${project}: ${(err as Error).message}`);
    }
  };

  server.registerTool(
    "graphify_query",
    {
      title: "Graphify: query",
      description:
        "Ask a natural-language question about the codebase; graphify does a token-budgeted BFS over its " +
        "knowledge graph and returns the relevant subgraph/answer. Far cheaper than reading files. " +
        "Requires the project's indexer to be 'graphify' and a graph to have been generated.",
      inputSchema: {
        project: z.string().describe("Project id, e.g. my-app"),
        question: z.string().min(1).describe("e.g. 'how does authentication work?'"),
        budget: z.number().int().min(200).max(20000).optional().describe("Token budget (default graphify's own)"),
      },
    },
    async ({ project, question, budget }) => {
      const args = ["query", question];
      if (budget) args.push("--budget", String(budget));
      return graphifyText(project, args, "query");
    },
  );

  server.registerTool(
    "graphify_affected",
    {
      title: "Graphify: affected",
      description:
        "Reverse-traverse the graph to find what would be impacted by changing a node (its blast radius). " +
        "Requires the 'graphify' indexer.",
      inputSchema: {
        project: z.string().describe("Project id, e.g. my-app"),
        node: z.string().min(1).describe("Node label to start from, e.g. a function or file name"),
        depth: z.number().int().min(1).max(6).optional().describe("Reverse depth (graphify default 2)"),
      },
    },
    async ({ project, node, depth }) => {
      const args = ["affected", node];
      if (depth) args.push("--depth", String(depth));
      return graphifyText(project, args, "affected");
    },
  );

  server.registerTool(
    "graphify_explain",
    {
      title: "Graphify: explain",
      description:
        "Plain-language explanation of a node and its neighbors from the graph. Requires the 'graphify' indexer.",
      inputSchema: {
        project: z.string().describe("Project id, e.g. my-app"),
        node: z.string().min(1).describe("Node label to explain"),
      },
    },
    async ({ project, node }) => graphifyText(project, ["explain", node], "explain"),
  );

  server.registerTool(
    "graphify_path",
    {
      title: "Graphify: path",
      description:
        "Find the shortest path between two nodes in the graph (how A relates to B). Requires the 'graphify' indexer.",
      inputSchema: {
        project: z.string().describe("Project id, e.g. my-app"),
        from: z.string().min(1).describe("Start node label"),
        to: z.string().min(1).describe("End node label"),
      },
    },
    async ({ project, from, to }) => graphifyText(project, ["path", from, to], "path"),
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
