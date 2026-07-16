/**
 * Shared composition root: wires config + repository + services over the board/
 * filesystem. Used by BOTH the HTTP server (main.ts) and the stdio MCP entrypoint
 * (mcp.ts) so the two transports expose exactly the same application services.
 *
 * HTTP-only concerns (Fastify, SSE hub, watcher, config-file watching) stay in main.ts.
 */
import fs from "node:fs/promises";
import { ConfigService } from "./config";
import { ProjectsService } from "./projects";
import { RecentWrites } from "./infrastructure/recentWrites";
import { AttachmentStore } from "./infrastructure/attachmentStore";
import { FsTaskRepository } from "./infrastructure/taskRepository";
import {
  TaskService,
  AttachmentService,
  GraphService,
  ExportService,
} from "./application/services";
import { CodeGraphService } from "./application/codeGraphService";
import { ProjectDocumentationService } from "./application/projectDocumentationService";
import type { Services } from "./interface/http/routes";
import type { Env } from "./env";
import type { EventBus } from "./infrastructure/eventBus";

export interface Core {
  config: ConfigService;
  projects: ProjectsService;
  recentWrites: RecentWrites;
  attachmentStore: AttachmentStore;
  repo: FsTaskRepository;
  services: Services;
}

/** Ensure board/ + exports/ exist, then build config, projects, repository and services. */
export async function buildCore(env: Env, bus: EventBus): Promise<Core> {
  await fs.mkdir(env.boardDir, { recursive: true });
  await fs.mkdir(env.exportsDir, { recursive: true });
  await fs.mkdir(env.graphsDir, { recursive: true });
  await fs.mkdir(env.projectDocsDir, { recursive: true });

  const config = new ConfigService(env);
  const recentWrites = new RecentWrites();
  const attachmentStore = new AttachmentStore(env);
  const repo = new FsTaskRepository(env, config, attachmentStore, bus, recentWrites);
  const projects = new ProjectsService(env, bus);
  await projects.ensureFile();

  const services: Services = {
    config,
    projects,
    tasks: new TaskService(repo),
    attachments: new AttachmentService(attachmentStore, repo, bus),
    graph: new GraphService(repo),
    codeGraph: new CodeGraphService(env, projects, bus),
    projectDocumentation: new ProjectDocumentationService(env, projects),
    exports: new ExportService(env, repo),
  };

  return { config, projects, recentWrites, attachmentStore, repo, services };
}
