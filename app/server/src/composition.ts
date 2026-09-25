/**
 * Shared composition root: wires config + repository + services over the board/
 * filesystem. Used by BOTH the HTTP server (main.ts) and the stdio MCP entrypoint
 * (mcp.ts) so the two transports expose exactly the same application services.
 *
 * HTTP-only concerns (Fastify, SSE hub, watcher, config-file watching) stay in main.ts.
 */
import fs from "node:fs/promises";
import path from "node:path";
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
  LibraryResourceService,
} from "./application/services";
import { LibraryResourceStore } from "./infrastructure/libraryResourceStore";
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
  resourceStore: AttachmentStore;
  libraryStore: LibraryResourceStore;
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
  const resourceStore = new AttachmentStore(env, "resources", "resources/files");
  const libraryStore = new LibraryResourceStore(env);
  const repo = new FsTaskRepository(env, config, attachmentStore, resourceStore, bus, recentWrites);
  const projects = new ProjectsService(env, bus);
  await projects.ensureFile();

  const services: Services = {
    storageInfo: () => ({
      applicationRoot: env.root,
      dataRoot: path.dirname(env.boardDir),
      boardDir: env.boardDir,
      exportsDir: env.exportsDir,
      graphsDir: env.graphsDir,
      projectDocsDir: env.projectDocsDir,
      configPath: env.configPath,
      projectsPath: env.projectsPath,
      storageSettingsPath: path.join(env.root, "storage.local.json"),
      environmentOverride: "AIDAILYTASKS_DATA_ROOT",
      relocation: "Stop HTTP and all stdio writers. Copy board, exports, graphs, project-docs, board.config.json and projects.json to an existing destination directory. Set dataRoot in storage.local.json (the environment override takes precedence). Restart and reconnect all clients; refresh generated stdio configs from Connect. Verify the copy before removing originals. This tool is read-only; it does not move files or switch running processes.",
    }),
    config,
    projects,
    tasks: new TaskService(repo),
    attachments: new AttachmentService(attachmentStore, repo, bus),
    resources: new AttachmentService(resourceStore, repo, bus),
    library: new LibraryResourceService(libraryStore),
    graph: new GraphService(repo),
    codeGraph: new CodeGraphService(env, projects, bus),
    projectDocumentation: new ProjectDocumentationService(env, projects),
    exports: new ExportService(env, repo),
  };

  return { config, projects, recentWrites, attachmentStore, resourceStore, libraryStore, repo, services };
}
