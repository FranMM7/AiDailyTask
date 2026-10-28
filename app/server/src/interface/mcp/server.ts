import { StatusMigrationSchema } from "../../application/statusMigration";
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
  CreateRequestSchema, PatchRequestSchema, EditableFieldsSchema, ObservationRequestSchema,
  ChangesFilterSchema, CommunicationFilterSchema, CommunicationMutationSchema, NextActionSchema, VerificationSchema,
  blockerExcerpt,
  TaskFilterSchema,
  normalizeId,
  type EditableFields,
  type PatchRequest,
  type TaskDetailOrInvalid,
  TaskResourceSchema,
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

function compactObservation(o: import("@AiDailyTasks/shared").Observation) {
  const {changes,verification_evidence,...note}=o;
  return {...note,markdown:o.markdown.slice(0,1000),verification_evidence:verification_evidence?.slice(0,1000),fields:changes ? Object.keys(changes) : undefined,truncated:o.markdown.length > 1000 || (verification_evidence?.length ?? 0) > 1000 || !!changes,detail_reference:o.id};
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
  { name: "migrate_status_alias", description: "Preview/apply the Depricated to Cancelled repair, or resume/rollback a journal." },
  { name: "list_changes", description: "Read a fixed window of cross-task activity; follow every next_cursor." },
  { name: "list_communications", description: "List recorded drafts, sent messages and items awaiting reply; no messages are sent." },
  { name: "get_communication", description: "Read a full recorded communication body." },
  { name: "add_communication", description: "Record a communication locally with baseRev and an optional retry-safe item_id." },
  { name: "update_communication", description: "Update a recorded communication with baseRev; sends nothing." },
  { name: "list_tasks", description: "List board tasks with optional filters and short blocker excerpts; get_task returns full blocker Markdown." },
  { name: "get_task", description: "Read one task with its latest observation page; may include a ready code-graph usage hint." },
  { name: "list_observations", description: "Read a bounded page of a task's observation history." },
  { name: "create_task", description: "Create a task, optionally with blocker Markdown; the id is auto-assigned." },
  { name: "update_task", description: "Patch task fields/content. Set blocker Markdown to record a blocker; set blocker to an empty string to resolve with automatic history." },
  { name: "delete_task", description: "Permanently delete an archived task after revision confirmation." },
  { name: "add_observation", description: "Append a timestamped note to a task's Observations log." },
  { name: "list_attachments", description: "List the files attached to a task (name, size, mime, url)." },
  { name: "get_attachment", description: "Fetch one of a task's attachments by filename (image/text/base64)." },
  { name: "upload_attachment", description: "Upload a text or base64 file to a task." },
  { name: "delete_attachment", description: "Permanently delete one attachment from a task." },
  { name: "upload_resource_file", description: "Upload a durable file used by a task resource." },
  { name: "get_resource_file", description: "Fetch a durable task-resource file." },
  { name: "delete_resource_file", description: "Delete a durable task-resource file." },
  { name: "archive_task", description: "Archive a task; completed recurring work creates one successor." },
  { name: "unarchive_task", description: "Restore an archived task." },
  { name: "list_projects", description: "List configured projects (id, label, source root)." },
  { name: "get_project", description: "Read one project's metadata, documentation, and code-graph status." },
  { name: "add_project", description: "Add a project to the local projects.json (optional source root)." },
  { name: "update_project", description: "Edit a project's label and/or source root path." },
  { name: "delete_project", description: "Delete a project from projects.json (refused while tasks still use it)." },
  { name: "get_project_documentation", description: "Get project details, agent instructions, and imported README." },
  { name: "update_project_documentation", description: "Save project-specific Markdown instructions for people and agents." },
  { name: "import_project_readme", description: "Copy a project's root README into its private documentation store." },
  { name: "get_storage_info", description: "Inspect active board data paths and instructions for relocation." },
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
  const server = new McpServer({ name: "AiDailyTasks", version }, {
    instructions: "When task work cannot proceed because information, approval, access, or an external dependency is missing, " +
      "record the current situation using update_task's top-level blocker argument. This Markdown appears in the Blocker tab. " +
      "Start with a short reason, then document evidence, attempted actions, the exact question/approval needed and who can resolve it when known. " +
      "Read get_task first and pass its rev as baseRev; blocker replaces the full current text, so preserve still-relevant details. " +
      "Example: update_task({id:'C123', baseRev:CURRENT_REV, blocker:'Waiting for approval.\n\n## Context\nMigration is ready.\n\n## Needed to unblock\nApprove the migration plan.'}). " +
      "create_task accepts blocker too. list_tasks returns only an excerpt; get_task returns the full Markdown. " +
      "Once resolved, call update_task({id:'C123', baseRev:CURRENT_REV, blocker:''}). " +
      "Omit blocker to leave it unchanged. Do not write blocked_since yourself. " +
      "The server records start/update/resolution observations automatically, including full details and dates; do not duplicate them with add_observation. " +
      "A blocker records a pending decision; it does not grant approval or change task status.",
  });
  // One McpServer instance is created per HTTP session (and once per stdio process),
  // so this keeps the advisory useful without repeating it on every task read.
  const graphifyHintsShown = new Set<string>();

  server.registerTool("migrate_status_alias", { description:"Preview the Depricated -> Cancelled repair. Apply requires the reviewed preview_hash. Backups/journals are task attachments; use operation_id to resume or rollback. Stop direct file writers.",inputSchema:StatusMigrationSchema.shape },async args=>{
    try{return ok(await services.statusMigration.run(StatusMigrationSchema.parse(args)));}catch(err){return fail((err as Error).message);}
  });
  server.registerTool("list_changes", {
    description: "Chronological activity in (since, until]. Follow next_cursor using identical filters. Expired cursors require restarting. Observation IDs retrieve full evidence using list_observations. Current fields are current context; coverage describes historical limits.",
    inputSchema: ChangesFilterSchema.innerType().shape,
  }, async args => {
    try { return ok(await services.workflow.listChanges(ChangesFilterSchema.parse(args))); }
    catch (err) { return fail((err as Error).message); }
  });
  server.registerTool("list_communications", { description: "Local communication records. awaiting_reply=true selects sent items still waiting; archived items included by default. Follow next_cursor.", inputSchema: CommunicationFilterSchema.shape }, async args => {
    try { return ok(await services.workflow.listCommunications(CommunicationFilterSchema.parse(args))); }
    catch (err) { return fail((err as Error).message); }
  });
  server.registerTool("get_communication", { description: "Read one full local communication; no external send.", inputSchema: { id:z.string(), item_id:z.string() } }, async ({id,item_id}) => {
    try { return ok(await services.workflow.getCommunication(id,item_id)); } catch (err) { return fail((err as Error).message); }
  });
  for (const create of [true,false]) server.registerTool(create ? "add_communication" : "update_communication", {
    description: "Record/update a local communication with exact baseRev. No external messages are sent. Reuse item_id with identical creation fields for a retry-safe creation.",
    inputSchema: { ...CommunicationMutationSchema.shape, id:z.string() },
  }, async ({id,...args}) => {
    try {
      const res = await services.tasks.communication(id,CommunicationMutationSchema.parse(args),create);
      if (res.conflict) return { ...ok({ conflict:true,current_rev:res.current.rev,message:CONFLICT_MSG }),isError:true };
      return ok({ id:res.task.id, rev:res.task.rev, communication_count:res.task.communication_count });
    } catch (err) { return fail((err as Error).message); }
  });

  // ── Read ───────────────────────────────────────────────────────────────────
  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List board tasks with optional filters and short blocker excerpts. Use get_task for full blocker Markdown when blocker_truncated is true. Archived tasks are excluded by default.",
      inputSchema: TaskFilterSchema.shape,
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
              priority: t.priority, next_action: t.next_action,
              status_freshness: t.status_freshness, status_detail_updated_at: t.status_detail_updated_at, latest_note_at: t.latest_note_at,
              communication_counts: t.communication_counts,
              blocker: blockerExcerpt(t.blocker),
              blocker_truncated: t.blocker.length > 240,
              blocked_since: t.blocked_since,
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
        "Read one task: frontmatter, summary, scope, reusable resources, the latest 20 observations, and attachments. " +
        "The first eligible read in a session may include a non-blocking code-graph usage hint.",
      inputSchema: { id: z.string().describe("Task id, e.g. C09") },
    },
    async ({ id }) => {
      const t = await services.tasks.get(id, 20);
      if (!t.valid) return fail(`Task ${id} is invalid: ${t.parseError}`);

      const hintKey = t.project;
      let projectStudyHint: {
        label: string;
        project: string;
        recommended_tool: "query_code_graph";
        message: string;
      } | undefined;
      if (!graphifyHintsShown.has(hintKey) && (await services.codeGraph.hasReadyGraphify(t.project))) {
        graphifyHintsShown.add(hintKey);
        projectStudyHint = {
          label: "Ready code graph",
          project: t.project,
          recommended_tool: "query_code_graph",
          message:
            `A ready Graphify-backed code graph is available for ${t.project}. For a precise file or ` +
            "symbol question, consider query_code_graph; use graphify_explain, graphify_path, or " +
            "graphify_affected only when you already have an exact node label. Avoid broad " +
            "graphify_query architecture questions. This is advisory; no graph query or refresh has run.",
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
        priority: t.priority, next_action: t.next_action,
        status_freshness: t.status_freshness, status_detail_updated_at: t.status_detail_updated_at, latest_note_at: t.latest_note_at,
        communication_count: t.communication_count, communication_page: t.communication_page,
        blocker: t.blocker,
        blocked_since: t.blocked_since,
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
        qa: t.qa, verification: t.verification,
        observations: t.observations.map(compactObservation),
        observation_count: t.observationCount,
        next_observation_cursor: t.nextObservationCursor,
        attachments: t.attachments.map((a) => ({ name: a.name, size: a.size, url: a.url })),
        resources: t.resources,
        resource_files: t.resourceFiles,
        ...(projectStudyHint ? { project_study_hint: projectStudyHint } : {}),
      });
    },
  );

  server.registerTool(
    "list_observations",
    {
      title: "List observations",
      description: "Read one bounded chronological page of a task's observations. Pass next_cursor from get_task or a prior page to retrieve older notes.",
      inputSchema: {
        id: z.string().describe("Task id, e.g. C09"),
        observation_id: z.string().optional().describe("Retrieve a full observation by stable ID, including evidence and field snapshots"),
        cursor: z.string().optional().describe("Opaque cursor for older observations"),
        limit: z.number().int().min(1).max(100).optional().describe("Page size; defaults to 20"),
      },
    },
    async ({ id, cursor, limit, observation_id }) => {
      try {
        if (observation_id) return ok({ id: normalizeId(id), observations: [await services.tasks.observation(id, observation_id)], next_cursor: null });
        const page = await services.tasks.listObservations(id, cursor, limit);
        return ok({ id: normalizeId(id), ...page, observations:page.observations.map(compactObservation) });
      } catch (err) {
        return fail(`Cannot read observations for ${id}: ${(err as Error).message}`);
      }
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

  server.registerTool(
    "upload_resource_file",
    {
      title: "Upload resource file",
      description: "Upload a durable reference file. Then add a kind=file resource with update_task.",
      inputSchema: { id: z.string(), filename: z.string().min(1), text: z.string().optional(), base64: z.string().optional() },
    },
    async ({ id, filename, text, base64 }) => {
      if ((text === undefined) === (base64 === undefined)) return fail("Provide exactly one of text or base64.");
      const data = text !== undefined ? Buffer.from(text, "utf8") : Buffer.from(base64!, "base64");
      if (data.byteLength > MAX_ATTACHMENT_BYTES) return fail(`Resource file is over the ${MAX_ATTACHMENT_BYTES}-byte MCP upload limit.`);
      try {
        const files = await services.resources.saveMany(id, [{ filename, data }]);
        return ok({ id: normalizeId(id), file: files[0] });
      } catch (err) { return fail(`Cannot upload resource file to ${id}: ${(err as Error).message}`); }
    },
  );

  server.registerTool(
    "get_resource_file",
    {
      title: "Get resource file",
      description: "Fetch a durable task-resource file as text, image, or base64 content.",
      inputSchema: { id: z.string(), name: z.string().min(1) },
    },
    async ({ id, name }) => {
      try {
        const file = await services.resources.read(id, name);
        if (file.size > MAX_ATTACHMENT_BYTES) return fail(`Resource file is over the ${MAX_ATTACHMENT_BYTES}-byte inline limit.`);
        const buffer = await collectStream(file.stream());
        if (/^image\//.test(file.mime)) return { content: [{ type: "image", data: buffer.toString("base64"), mimeType: file.mime }] };
        if (/^text\//.test(file.mime) || file.mime === "application/json") return { content: [{ type: "text", text: buffer.toString("utf8") }] };
        return { content: [{ type: "resource", resource: { uri: `file:///${normalizeId(id)}/resources/${encodeURIComponent(name)}`, mimeType: file.mime, blob: buffer.toString("base64") } }] };
      } catch (err) { return fail(`Resource file not found: ${name} (task ${id}) — ${(err as Error).message}`); }
    },
  );

  server.registerTool(
    "delete_resource_file",
    {
      title: "Delete resource file",
      description: "Delete a resource file after removing its metadata reference with update_task.",
      inputSchema: { id: z.string(), name: z.string().min(1), confirm: z.literal(true) },
    },
    async ({ id, name }) => {
      try { await services.resources.delete(id, name); return ok({ id: normalizeId(id), deleted: name }); }
      catch (err) { return fail(`Cannot delete resource file ${name} from ${id}: ${(err as Error).message}`); }
    },
  );

  // ── Write: tasks ─────────────────────────────────────────────────────────────
  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Create a task. The id is auto-assigned unless an available explicit id is provided. Only title and category are required. Optional blocker Markdown appears in the Blocker tab and automatically records its start; put the reason first, followed by evidence, attempts, and what is needed to unblock.",
      inputSchema: CreateRequestSchema.strict(),
    },
    async (args) => {
      const parsed = CreateRequestSchema.safeParse(args);
      if (!parsed.success) return fail(`Invalid task: ${parsed.error.message}`);
      const task = await services.tasks.create(parsed.data);
      return ok({ id: task.id, rev: task.rev, title: task.title, status: task.status, blocker: task.blocker, blocked_since: task.blocked_since });
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Patch a task's fields and/or summary/scope/qa. Pass baseRev from get_task for optimistic concurrency; if omitted, the current rev is used. " +
        "To add or edit the Blocker tab, pass top-level blocker with the full Markdown (not body.blocker or an observation). " +
        "It replaces existing blocker text. Include a short reason, context/evidence, attempted actions, and the exact missing information or approval. " +
        "Omitting blocker leaves it unchanged; blocker: \"\" resolves it. The server maintains blocked_since and automatically logs start, edits and resolution with full details and dates. No separate add_observation call is needed.",
      inputSchema: z.object({
        ...EditableFieldsSchema.shape, id: z.string(), baseRev: z.number().optional().describe("Current get_task revision; HTTP requires this, MCP resolves it if omitted"),
        summary: z.string().optional(), scope: z.string().optional(), qa: z.string().optional(), verification: z.string().optional(),
      }).strict(),
    },
    async (args) => {
      const { id, baseRev, ...patch } = args;
      const rev = await resolveRev(services, id, baseRev);
      if (rev === null) return fail(`Task ${id} not found or invalid.`);
      const parsed = PatchRequestSchema.safeParse({ ...patch, baseRev: rev });
      if (!parsed.success) return fail(parsed.error.message);
      const res = await services.tasks.patch(id, parsed.data);
      if (res.conflict) return { ...ok({ conflict: true, current_rev: res.current.rev, message: CONFLICT_MSG }), isError: true };
      return ok({ id: res.task.id, rev: res.task.rev, status: res.task.status, updated: res.task.updated, blocker: res.task.blocker, blocked_since: res.task.blocked_since });
    },
  );

  server.registerTool(
    "add_observation",
    {
      title: "Add observation",
      description: "Append a timestamped note under a task's Observations log.",
      inputSchema: { ...ObservationRequestSchema.shape, id: z.string(), baseRev: z.number().optional(), author: z.string().optional() },
    },
    async ({ id, text, author, baseRev, at, verification, verification_evidence }) => {
      const rev = await resolveRev(services, id, baseRev);
      if (rev === null) return fail(`Task ${id} not found or invalid.`);
      const res = await services.tasks.addObservation(id, {
        baseRev: rev,
        author: author ?? "claude",
        text, at, verification, verification_evidence,
      });
      if (res.conflict) return { ...ok({ conflict: true, current_rev: res.current.rev, message: CONFLICT_MSG }), isError: true };
      return ok({ id: res.task.id, rev: res.task.rev, observationCount: res.task.observationCount, observation: res.task.observations.at(-1), status_freshness: res.task.status_freshness });
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
        if (res.conflict) return { ...ok({ conflict: true, current_rev: res.current.rev, message: CONFLICT_MSG }), isError: true };
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
      if (res.conflict) return { ...ok({ conflict: true, current_rev: res.current.rev, message: CONFLICT_MSG }), isError: true };
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
      if (res.conflict) return { ...ok({ conflict: true, current_rev: res.current.rev, message: CONFLICT_MSG }), isError: true };
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
    "delete_project",
    {
      title: "Delete project",
      description:
        "Delete a project from the local projects.json. Refused while any task (archived included) is still " +
        "assigned to it — reassign or delete those tasks first. Does not touch task files.",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        const inUse = (await services.tasks.list({
          project: id,
          archived: "include",
          sort: "id",
          order: "asc",
        })).length;
        const projects = await services.projects.remove(id, inUse);
        return ok({ projects });
      } catch (err) {
        return fail(`Cannot delete project ${id}: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "get_storage_info",
    {
      title: "Get board storage location",
      description: "Read the active data root and board/project/config paths before direct file access. Includes configuration and safe offline relocation instructions. Does not move data or change storage.",
      annotations: { readOnlyHint: true },
    },
    async () => ok(services.storageInfo()),
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
        "Run Graphify's token-budgeted BFS over a narrowly phrased question with distinctive symbol names. " +
        "Broad architecture questions can return noisy, truncated traversals; prefer query_code_graph for " +
        "precise file/symbol lookup. Requires the project's indexer to be 'graphify' and a graph to have been generated.",
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
    current = await services.tasks.get(id, 1);
  } catch {
    return null;
  }
  return current.valid ? current.rev : null;
}
