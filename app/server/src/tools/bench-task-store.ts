import { loadEnv } from "../env";
/**
 * Measure the request paths this storage format exists to make fast, against a
 * real board. Reads only — point it at a copy if you want to be certain.
 *
 *   npm run bench:store -- --board <dir> --store <auto|markdown|json> [--task C171]
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ConfigService } from "../config";
import type { Env } from "../env";
import { AttachmentStore } from "../infrastructure/attachmentStore";
import { EventBus } from "../infrastructure/eventBus";
import { RecentWrites } from "../infrastructure/recentWrites";
import { FsTaskRepository } from "../infrastructure/taskRepository";
import { isTaskStoreMode, type TaskStoreMode } from "../infrastructure/taskFileStore";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function envFor(root: string, boardDir: string, taskStore: TaskStoreMode): Env {
  return {
    root,
    boardDir,
    exportsDir: path.join(root, "exports"),
    graphsDir: path.join(root, "graphs"),
    projectDocsDir: path.join(root, "project-docs"),
    libraryDir: path.join(boardDir, "_meta", "resources"),
    configPath: path.join(REPO_ROOT, "board.config.json"),
    configTemplatePath: path.join(REPO_ROOT, "board.config.json.template"),
    projectsPath: path.join(REPO_ROOT, "projects.json"),
    webDistDir: path.join(root, "dist"),
    port: 0,
    host: "127.0.0.1",
    taskStore,
  };
}

async function time(label: string, runs: number, fn: () => Promise<unknown>): Promise<void> {
  await fn(); // warm the page cache so this measures parsing, not first-touch IO
  const started = process.hrtime.bigint();
  for (let i = 0; i < runs; i++) await fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6 / runs;
  console.log(`  ${label.padEnd(44)} ${ms.toFixed(1)} ms`);
}

async function main(): Promise<void> {
  const boardDir = path.resolve(REPO_ROOT, option("--board", loadEnv().boardDir));
  const store = option("--store", "auto");
  if (!isTaskStoreMode(store)) throw new Error(`--store must be auto|markdown|json (got "${store}")`);
  const task = option("--task", "");

  const env = envFor(path.dirname(boardDir), boardDir, store);
  const repo = new FsTaskRepository(
    env,
    new ConfigService(env),
    new AttachmentStore(env),
    new AttachmentStore(env, "resources", "resources"),
    new EventBus(),
    new RecentWrites(),
  );

  const summaries = await repo.listSummaries();
  const valid = summaries.filter((summary) => summary.valid);
  // Default to the task with the longest history — the case the format targets.
  const target =
    task ||
    valid.reduce((worst, summary) =>
      summary.valid && (!worst.valid || summary.observationCount > worst.observationCount) ? summary : worst,
    ).id;

  console.log(`\nstore=${store}  board=${boardDir}`);
  console.log(`${summaries.length} tasks (${valid.length} valid), deepest history: ${target}\n`);
  await time("listSummaries (board list)", 5, () => repo.listSummaries());
  await time(`read(${target}, 20 observations)`, 5, () => repo.read(target, 20));
  await time(`listObservations(${target}, 20)`, 5, () => repo.listObservations(target, undefined, 20));
  await time(`read(${target}, full history)`, 3, () => repo.read(target));
}

void main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
