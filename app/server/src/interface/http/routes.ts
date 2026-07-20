/**
 * REST route registration. Validates params/query/bodies against the shared zod
 * schemas, maps domain conflicts to 409 (ConflictResponse) and other errors to
 * the { error: { code, message, details? } } envelope.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  PatchRequestSchema,
  CreateRequestSchema,
  CreateProjectRequestSchema,
  UpdateProjectRequestSchema,
  UpdateProjectDocumentationSchema,
  ObservationRequestSchema,
  TaskFilterSchema,
  ExportRequestSchema,
  ID_PATTERN,
  type ApiError,
  type ConflictResponse,
} from "@AiDailyTasks/shared";
import type {
  TaskService,
  AttachmentService,
  GraphService,
  ExportService,
} from "../../application/services";
import type { CodeGraphService } from "../../application/codeGraphService";
import type { ConfigService } from "../../config";
import type { ProjectsService } from "../../projects";
import type { ProjectDocumentationService } from "../../application/projectDocumentationService";
import { NotFoundError, ValidationError, PayloadTooLargeError } from "../../errors";

export interface Services {
  config: ConfigService;
  projects: ProjectsService;
  tasks: TaskService;
  attachments: AttachmentService;
  graph: GraphService;
  codeGraph: CodeGraphService;
  projectDocumentation: ProjectDocumentationService;
  exports: ExportService;
}

function errorEnvelope(code: string, message: string, details?: unknown): ApiError {
  return { error: { code, message, details } };
}

function sendError(reply: FastifyReply, err: unknown): void {
  if (err instanceof NotFoundError) {
    reply.code(404).send(errorEnvelope("not_found", err.message));
    return;
  }
  if (err instanceof ValidationError) {
    reply.code(400).send(errorEnvelope("validation_error", err.message, err.details));
    return;
  }
  if (err instanceof PayloadTooLargeError) {
    reply.code(413).send(errorEnvelope("payload_too_large", err.message));
    return;
  }
  const anyErr = err as { code?: string; message?: string };
  if (anyErr?.code === "FST_REQ_FILE_TOO_LARGE" || anyErr?.code === "FST_FILES_LIMIT") {
    reply.code(413).send(errorEnvelope("payload_too_large", anyErr.message ?? "Upload too large"));
    return;
  }
  reply.code(500).send(errorEnvelope("internal_error", (err as Error)?.message ?? "Internal error"));
}

/** Coerce repeated (?a=x&a=y) OR CSV (?a=x,y) query values into a string[]. */
function toArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const out = raw
    .flatMap((v) => String(v).split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return out.length > 0 ? out : undefined;
}

const IdParam = z.object({ id: z.string().regex(ID_PATTERN) });
const ArchiveBody = z.object({ baseRev: z.number().optional() });

export function registerRoutes(app: FastifyInstance, services: Services): void {
  // ── Config ───────────────────────────────────────────────────────────────
  // Projects are merged in from the local projects.json (ProjectsService), not the
  // committed board.config.json.
  app.get("/api/config", async (_req, reply) => {
    reply.send({ ...services.config.get(), projects: services.projects.list() });
  });

  app.put("/api/config", async (req, reply) => {
    try {
      const next = await services.config.update(req.body);
      reply.send({ ...next, projects: services.projects.list() });
    } catch (err) {
      reply.code(400).send(errorEnvelope("validation_error", (err as Error).message));
    }
  });

  // ── Projects ───────────────────────────────────────────────────────────────
  app.get("/api/projects", async (_req, reply) => {
    reply.send({ projects: services.projects.list() });
  });

  app.post("/api/projects", async (req, reply) => {
    try {
      const parsed = CreateProjectRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send(errorEnvelope("validation_error", "Invalid project", parsed.error.flatten()));
        return;
      }
      const projects = await services.projects.add(parsed.data);
      reply.code(201).send({ projects });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Edit an existing project's label / source root (id is immutable).
  app.patch("/api/projects/:id", async (req, reply) => {
    try {
      const id = decodeURIComponent((req.params as { id: string }).id);
      const parsed = UpdateProjectRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send(errorEnvelope("validation_error", "Invalid project update", parsed.error.flatten()));
        return;
      }
      const projects = await services.projects.update(id, parsed.data);
      reply.send({ projects });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get("/api/projects/:id/documentation", async (req, reply) => {
    try {
      const id = decodeURIComponent((req.params as { id: string }).id);
      reply.send(await services.projectDocumentation.get(id));
    } catch (err) { sendError(reply, err); }
  });

  app.put("/api/projects/:id/documentation", async (req, reply) => {
    try {
      const id = decodeURIComponent((req.params as { id: string }).id);
      const parsed = UpdateProjectDocumentationSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send(errorEnvelope("validation_error", "Invalid project documentation", parsed.error.flatten()));
        return;
      }
      reply.send(await services.projectDocumentation.update(id, parsed.data.instructions));
    } catch (err) { sendError(reply, err); }
  });

  app.post("/api/projects/:id/documentation/import-readme", async (req, reply) => {
    try {
      const id = decodeURIComponent((req.params as { id: string }).id);
      reply.send(await services.projectDocumentation.importReadme(id));
    } catch (err) { sendError(reply, err); }
  });

  // ── Code graph (per-project source map) ──────────────────────────────────────
  app.get("/api/projects/:id/code-graph", async (req, reply) => {
    try {
      const id = decodeURIComponent((req.params as { id: string }).id);
      const graph = await services.codeGraph.getGraph(id);
      reply.send(graph);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Kick off (or report already-running) generation. Returns immediately with meta.status="indexing".
  app.post("/api/projects/:id/code-graph/generate", async (req, reply) => {
    try {
      const id = decodeURIComponent((req.params as { id: string }).id);
      const meta = await services.codeGraph.generate(id);
      reply.code(202).send({ meta });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── List tasks ───────────────────────────────────────────────────────────
  app.get("/api/tasks", async (req: FastifyRequest, reply) => {
    try {
      const q = req.query as Record<string, unknown>;
      const candidate = {
        project: typeof q.project === "string" ? q.project : undefined,
        status: toArray(q.status),
        category: toArray(q.category),
        severity: toArray(q.severity),
        tag: typeof q.tag === "string" ? q.tag : undefined,
        q: typeof q.q === "string" ? q.q : undefined,
        dateField: typeof q.dateField === "string" ? q.dateField : undefined,
        dateFrom: typeof q.dateFrom === "string" ? q.dateFrom : undefined,
        dateTo: typeof q.dateTo === "string" ? q.dateTo : undefined,
        archived: typeof q.archived === "string" ? q.archived : undefined,
        sort: typeof q.sort === "string" ? q.sort : undefined,
        order: typeof q.order === "string" ? q.order : undefined,
      };
      const parsed = TaskFilterSchema.safeParse(candidate);
      if (!parsed.success) {
        reply.code(400).send(errorEnvelope("validation_error", "Invalid filter", parsed.error.flatten()));
        return;
      }
      const tasks = await services.tasks.list(parsed.data);
      reply.send({ tasks });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Get one ──────────────────────────────────────────────────────────────
  app.get("/api/tasks/:id", async (req, reply) => {
    try {
      const { id } = IdParam.parse(req.params);
      const task = await services.tasks.get(id);
      reply.send({ task });
    } catch (err) {
      handleParamOrError(reply, err);
    }
  });

  // ── Create ───────────────────────────────────────────────────────────────
  app.post("/api/tasks", async (req, reply) => {
    try {
      const parsed = CreateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send(errorEnvelope("validation_error", "Invalid create request", parsed.error.flatten()));
        return;
      }
      const task = await services.tasks.create(parsed.data);
      reply.code(201).send({ task });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Patch ────────────────────────────────────────────────────────────────
  app.patch("/api/tasks/:id", async (req, reply) => {
    try {
      const { id } = IdParam.parse(req.params);
      const parsed = PatchRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send(errorEnvelope("validation_error", "Invalid patch request", parsed.error.flatten()));
        return;
      }
      const result = await services.tasks.patch(id, parsed.data);
      if (result.conflict) {
        const body: ConflictResponse = { conflict: true, current: result.current };
        reply.code(409).send(body);
        return;
      }
      reply.code(200).send({ task: result.task });
    } catch (err) {
      handleParamOrError(reply, err);
    }
  });

  // ── Observation ──────────────────────────────────────────────────────────
  app.post("/api/tasks/:id/observations", async (req, reply) => {
    try {
      const { id } = IdParam.parse(req.params);
      const parsed = ObservationRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send(errorEnvelope("validation_error", "Invalid observation request", parsed.error.flatten()));
        return;
      }
      const result = await services.tasks.addObservation(id, parsed.data);
      if (result.conflict) {
        const body: ConflictResponse = { conflict: true, current: result.current };
        reply.code(409).send(body);
        return;
      }
      reply.code(200).send({ task: result.task });
    } catch (err) {
      handleParamOrError(reply, err);
    }
  });

  // ── Archive / unarchive ──────────────────────────────────────────────────
  app.post("/api/tasks/:id/archive", async (req, reply) => {
    try {
      const { id } = IdParam.parse(req.params);
      const parsed = ArchiveBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400).send(errorEnvelope("validation_error", "Invalid archive request", parsed.error.flatten()));
        return;
      }
      const result = await services.tasks.archive(id, parsed.data.baseRev);
      if (result.conflict) {
        const body: ConflictResponse = { conflict: true, current: result.current };
        reply.code(409).send(body);
        return;
      }
      reply.code(200).send({
        task: result.task,
        ...(result.successor ? { successor: result.successor } : {}),
      });
    } catch (err) {
      handleParamOrError(reply, err);
    }
  });

  app.post("/api/tasks/:id/unarchive", async (req, reply) => {
    try {
      const { id } = IdParam.parse(req.params);
      const parsed = ArchiveBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400).send(errorEnvelope("validation_error", "Invalid unarchive request", parsed.error.flatten()));
        return;
      }
      const result = await services.tasks.unarchive(id, parsed.data.baseRev);
      if (result.conflict) {
        const body: ConflictResponse = { conflict: true, current: result.current };
        reply.code(409).send(body);
        return;
      }
      reply.code(200).send({ task: result.task });
    } catch (err) {
      handleParamOrError(reply, err);
    }
  });

  // ── Attachments: list ──────────────────────────────────────────────────────
  app.get("/api/tasks/:id/attachments", async (req, reply) => {
    try {
      const { id } = IdParam.parse(req.params);
      const attachments = await services.attachments.list(id);
      reply.send({ attachments });
    } catch (err) {
      handleParamOrError(reply, err);
    }
  });

  // ── Attachments: upload (multipart) ──────────────────────────────────────────
  app.post("/api/tasks/:id/attachments", async (req, reply) => {
    try {
      const { id } = IdParam.parse(req.params);
      if (!req.isMultipart()) {
        reply.code(400).send(errorEnvelope("validation_error", "Expected multipart/form-data"));
        return;
      }
      const files: { filename: string; data: Buffer }[] = [];
      for await (const part of req.files()) {
        if (!part.filename) continue;
        const data = await part.toBuffer();
        files.push({ filename: part.filename, data });
      }
      if (files.length === 0) {
        reply.code(400).send(errorEnvelope("validation_error", "No files uploaded (field name must be 'files')"));
        return;
      }
      const attachments = await services.attachments.saveMany(id, files);
      reply.send({ attachments });
    } catch (err) {
      handleParamOrError(reply, err);
    }
  });

  // ── Attachments: download (Range-aware) ──────────────────────────────────────
  app.get("/api/tasks/:id/attachments/:name", async (req, reply) => {
    try {
      const { id } = IdParam.parse(req.params);
      const name = decodeURIComponent((req.params as { name: string }).name);
      const file = await services.attachments.read(id, name);

      const inline = /^image\//.test(file.mime) || file.mime === "application/pdf" || /^text\//.test(file.mime);
      const disposition = `${inline ? "inline" : "attachment"}; filename="${name.replace(/"/g, "")}"`;

      reply.header("Content-Type", file.mime);
      reply.header("Accept-Ranges", "bytes");
      reply.header("Content-Disposition", disposition);
      reply.header("Cache-Control", "no-cache");

      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m) {
          const total = file.size;
          let start = m[1] === "" ? undefined : Number(m[1]);
          let end = m[2] === "" ? undefined : Number(m[2]);
          if (start === undefined && end !== undefined) {
            // suffix range: last N bytes
            start = Math.max(0, total - end);
            end = total - 1;
          } else {
            if (start === undefined) start = 0;
            if (end === undefined) end = total - 1;
          }
          if (start > end || start >= total) {
            reply.header("Content-Range", `bytes */${total}`);
            reply.code(416).send(errorEnvelope("range_not_satisfiable", "Requested range not satisfiable"));
            return;
          }
          reply.code(206);
          reply.header("Content-Range", `bytes ${start}-${end}/${total}`);
          reply.header("Content-Length", String(end - start + 1));
          return reply.send(file.stream({ start, end }));
        }
      }
      reply.header("Content-Length", String(file.size));
      return reply.send(file.stream());
    } catch (err) {
      handleParamOrError(reply, err);
    }
  });

  // ── Attachments: delete ──────────────────────────────────────────────────────
  app.delete("/api/tasks/:id/attachments/:name", async (req, reply) => {
    try {
      const { id } = IdParam.parse(req.params);
      const name = decodeURIComponent((req.params as { name: string }).name);
      await services.attachments.delete(id, name);
      reply.code(204).send();
    } catch (err) {
      handleParamOrError(reply, err);
    }
  });

  // ── Export ───────────────────────────────────────────────────────────────────
  app.post("/api/export", async (req, reply) => {
    try {
      const parsed = ExportRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400).send(errorEnvelope("validation_error", "Invalid export request", parsed.error.flatten()));
        return;
      }
      const result = await services.exports.buildAndSave(parsed.data);
      reply.send({ result });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get("/api/exports", async (_req, reply) => {
    try {
      const exports = await services.exports.listExports();
      reply.send({ exports });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Graph ──────────────────────────────────────────────────────────────────
  app.get("/api/graph", async (req, reply) => {
    try {
      const q = req.query as Record<string, unknown>;
      const project = typeof q.project === "string" ? q.project : undefined;
      const graph = await services.graph.build(project);
      reply.send({ graph });
    } catch (err) {
      sendError(reply, err);
    }
  });
}

/** Distinguish zod param failures (400) from downstream domain errors. */
function handleParamOrError(reply: FastifyReply, err: unknown): void {
  if (err instanceof z.ZodError) {
    reply.code(400).send(errorEnvelope("validation_error", "Invalid path parameter", err.flatten()));
    return;
  }
  sendError(reply, err);
}
