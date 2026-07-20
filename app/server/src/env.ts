/**
 * Environment / path resolution for the AiDailyTasks server.
 *
 * AiDailyTasks_ROOT is the repo root that holds `board/`, `exports/` and
 * `board.config.json`. It can be overridden with the AiDailyTasks_ROOT env var;
 * otherwise it is resolved three levels up from this file
 * (app/server/src -> app/server -> app -> <root>).
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface Env {
  root: string;
  boardDir: string;
  exportsDir: string;
  graphsDir: string;
  projectDocsDir: string;
  configPath: string;
  configTemplatePath: string;
  projectsPath: string;
  webDistDir: string;
  port: number;
  host: string;
}

function resolveRoot(): string {
  // Keep the misspelled legacy variable working for existing local setups.
  const fromEnv = process.env.AiDailyTasks_ROOT ?? process.env.AiDailyTaks_ROOT;
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv);
  }
  const here = path.dirname(fileURLToPath(import.meta.url)); // app/server/src
  return path.resolve(here, "..", "..", "..");
}

export function loadEnv(): Env {
  const root = resolveRoot();
  const portRaw = process.env.PORT;
  const port = portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : 4317;
  return {
    root,
    boardDir: path.join(root, "board"),
    exportsDir: path.join(root, "exports"),
    graphsDir: path.join(root, "graphs"),
    projectDocsDir: path.join(root, "project-docs"),
    configPath: path.join(root, "board.config.json"),
    configTemplatePath: path.join(root, "board.config.json.template"),
    projectsPath: path.join(root, "projects.json"),
    webDistDir: path.join(root, "app", "web", "dist"),
    port,
    host: "127.0.0.1",
  };
}
