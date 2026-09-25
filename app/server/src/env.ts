/**
 * Environment / path resolution for the AiDailyTasks server.
 *
 * AiDailyTasks_ROOT is the repo root that holds `board/`, `exports/` and
 * `board.config.json`. It can be overridden with the AiDailyTasks_ROOT env var;
 * otherwise it is resolved three levels up from this file
 * (app/server/src -> app/server -> app -> <root>).
 *
 * AIDAILYTASKS_TASK_STORE selects the on-disk task format. See TaskStoreMode.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import { type TaskStoreMode, isTaskStoreMode } from "./infrastructure/taskFileStore";

export interface Env {
  root: string;
  boardDir: string;
  exportsDir: string;
  graphsDir: string;
  projectDocsDir: string;
  libraryDir?: string;
  configPath: string;
  configTemplatePath: string;
  projectsPath: string;
  webDistDir: string;
  port: number;
  host: string;
  taskStore: TaskStoreMode;
}

/**
 * Defaults to `auto`: read each task in whichever format it is stored in. An
 * explicit `json` or `markdown` forces one format and is how a migration is
 * committed to, or rolled back from.
 */
function resolveTaskStore(): TaskStoreMode {
  const raw = (process.env.AIDAILYTASKS_TASK_STORE ?? "").trim().toLowerCase();
  if (raw.length === 0) return "auto";
  if (!isTaskStoreMode(raw)) {
    throw new Error(`AIDAILYTASKS_TASK_STORE must be one of auto|markdown|json (got "${raw}")`);
  }
  return raw;
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

function checkedDataRoot(root: string, value: string): string {
  const resolved = path.resolve(root, value);
  if (!statSync(resolved).isDirectory()) throw new Error(`Data root is not a directory: ${resolved}`);
  return resolved;
}

/** A machine-local pointer shared by HTTP, stdio and maintenance commands. */
export function resolveDataRoot(root: string): string {
  const override = process.env.AIDAILYTASKS_DATA_ROOT?.trim();
  if (override) return checkedDataRoot(root, override);
  let raw: string;
  try {
    raw = readFileSync(path.join(root, "storage.local.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return root;
    throw error;
  }
  const settings = JSON.parse(raw) as { dataRoot?: unknown };
  if (typeof settings?.dataRoot !== "string" || !settings.dataRoot.trim()) {
    throw new Error("storage.local.json must contain a non-empty dataRoot path");
  }
  return checkedDataRoot(root, settings.dataRoot.trim());
}

export function loadEnv(): Env {
  const root = resolveRoot();
  const dataRoot = resolveDataRoot(root);
  const portRaw = process.env.PORT;
  const port = portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : 4317;
  return {
    root,
    boardDir: path.join(dataRoot, "board"),
    exportsDir: path.join(dataRoot, "exports"),
    graphsDir: path.join(dataRoot, "graphs"),
    projectDocsDir: path.join(dataRoot, "project-docs"),
    libraryDir: path.join(dataRoot, "board", "_meta", "resources"),
    configPath: path.join(dataRoot, "board.config.json"),
    configTemplatePath: path.join(root, "board.config.json.template"),
    projectsPath: path.join(dataRoot, "projects.json"),
    webDistDir: path.join(root, "app", "web", "dist"),
    port,
    host: "127.0.0.1",
    taskStore: resolveTaskStore(),
  };
}
