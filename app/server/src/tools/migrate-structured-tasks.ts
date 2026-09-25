import { loadEnv } from "../env";
/**
 * Convert the board from legacy `task.md` files to the structured store
 * (`task.json` + `observations.jsonl`), in two deliberately separate runs.
 *
 *   convert          write the structured files; task.md is left untouched
 *   remove-markdown  delete task.md, but only where the structured files are
 *                    verified to contain everything the Markdown holds
 *   status           report which format each task is stored in
 *
 * Splitting conversion from removal is the whole safety model: after `convert`
 * the board is readable in both formats and the migration can simply be
 * abandoned by deleting the JSON. Nothing is deleted until you ask for it, and
 * `remove-markdown` re-verifies every task instead of trusting that the earlier
 * conversion is still current.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseTaskFile } from "../domain/task";
import {
  type StoredObservation,
  OBSERVATIONS_FILE,
  TASK_JSON_FILE,
  TASK_MARKDOWN_FILE,
  parseObservationJsonl,
  parseStructuredTask,
  renderStructuredTaskMarkdown,
  serializeObservationJsonl,
  serializeStructuredTask,
  structuredFromLegacy,
} from "../domain/structuredTask";

const TASK_ID = /^C\d+$/;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

type Command = "convert" | "remove-markdown" | "status";

interface Options {
  command: Command;
  board: string;
  /** Staging directory; when unset, `convert` writes into the board itself. */
  output: string | null;
  dryRun: boolean;
  confirmed: boolean;
}

const USAGE = `Usage: migrate-structured-tasks <command> [options]

Commands:
  convert           Write task.json + observations.jsonl for every task.
  remove-markdown   Delete legacy task.md files that are fully represented by
                    the structured files. Requires --yes to actually delete.
  status            Report the storage format of every task.

Options:
  --board <dir>     Board directory (default: board), relative to the repo root.
  --output <dir>    convert only: write to this staging directory instead of
                    converting the board in place. Never modifies --board.
  --dry-run         Verify and report; write and delete nothing.
  --yes             remove-markdown only: confirm the deletion.

  --input <dir>     Deprecated alias for --board.
`;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseOptions(): Options {
  const positional = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const previous = positional ? process.argv[process.argv.indexOf(positional) - 1] : undefined;
  // A bare word is the command unless it is the value of the preceding flag.
  const command = positional && !previous?.startsWith("--") ? positional : undefined;
  if (command !== undefined && command !== "convert" && command !== "remove-markdown" && command !== "status") {
    throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
  const output = option("--output") ?? null;
  return {
    // Retain the original flag-only invocation (--input/--output), which meant
    // "stage a conversion", so documented commands keep working.
    command: command ?? (output ? "convert" : "status"),
    board: option("--board") ?? option("--input") ?? loadEnv().boardDir,
    output,
    dryRun: process.argv.includes("--dry-run"),
    confirmed: process.argv.includes("--yes"),
  };
}

async function taskIds(boardDir: string): Promise<string[]> {
  const entries = await fs.readdir(boardDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && TASK_ID.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Write via a temp sibling + rename so a reader never sees a partial file. */
async function atomicWrite(file: string, contents: string): Promise<void> {
  const tmp = `${file}.tmp-migrate`;
  await fs.writeFile(tmp, contents, "utf8");
  await fs.rename(tmp, file);
}

// ── convert ──────────────────────────────────────────────────────────────────
async function convert(options: Options): Promise<number> {
  const source = path.resolve(REPO_ROOT, options.board);
  const destination = options.output ? path.resolve(REPO_ROOT, options.output) : source;
  const inPlace = destination === source;

  const ids = await taskIds(source);
  const failures: string[] = [];
  let converted = 0;
  let skipped = 0;
  let observations = 0;

  for (const id of ids) {
    try {
      const legacy = await readIfPresent(path.join(source, id, TASK_MARKDOWN_FILE));
      if (legacy === null) {
        // Already structured (or created after the cutover): nothing to convert.
        skipped += 1;
        continue;
      }
      const parsed = parseTaskFile(legacy);
      if (!parsed.ok) throw new Error(parsed.error);
      const structured = structuredFromLegacy(parsed);

      // Round-trip before writing: parse what we serialized, and re-parse the
      // Markdown export of that, so a task can never be written in a shape the
      // reader would reject.
      const verifiedTask = parseStructuredTask(serializeStructuredTask(structured.task));
      const verifiedObservations = parseObservationJsonl(serializeObservationJsonl(structured.observations));
      const rendered = parseTaskFile(renderStructuredTaskMarkdown(verifiedTask, verifiedObservations));
      if (!rendered.ok) throw new Error(`Rendered Markdown is invalid: ${rendered.error}`);
      if (
        rendered.frontmatter.id !== parsed.frontmatter.id ||
        verifiedObservations.length !== structured.observations.length
      ) {
        throw new Error("Round-trip validation changed the task id or observation count.");
      }

      observations += structured.observations.length;
      converted += 1;
      if (!options.dryRun) {
        const target = path.join(destination, id);
        await fs.mkdir(target, { recursive: true });
        await atomicWrite(path.join(target, TASK_JSON_FILE), serializeStructuredTask(structured.task));
        await atomicWrite(path.join(target, OBSERVATIONS_FILE), serializeObservationJsonl(structured.observations));
      }
    } catch (error) {
      failures.push(`${id}: ${(error as Error).message}`);
    }
  }

  report({
    command: "convert",
    board: source,
    output: destination,
    inPlace,
    dryRun: options.dryRun,
    tasks: ids.length,
    converted,
    alreadyStructured: skipped,
    observations,
    failures,
  });

  if (inPlace && !options.dryRun && converted > 0 && failures.length === 0) {
    console.error(
      `\nConverted ${converted} task(s) in place. task.json is now the source of truth for them;\n` +
        `the task.md files are stale copies that are no longer read. Remove them with:\n` +
        `  npm run migrate:structured -- remove-markdown --dry-run\n` +
        `  npm run migrate:structured -- remove-markdown --yes`,
    );
  }
  return failures.length;
}

// ── remove-markdown ──────────────────────────────────────────────────────────
/**
 * A task.md may only be deleted when every observation it holds is already in
 * observations.jsonl. The structured side is allowed to have moved ahead (the
 * server may have written to it since), but it may never have less.
 */
function verifyRemovable(
  legacy: string,
  taskJson: string | null,
  observationsJsonl: string | null,
): string | null {
  if (taskJson === null) return `${TASK_JSON_FILE} is missing — run convert first`;
  const parsedLegacy = parseTaskFile(legacy);
  if (!parsedLegacy.ok) return `${TASK_MARKDOWN_FILE} does not parse: ${parsedLegacy.error}`;

  let structured;
  let stored: StoredObservation[];
  try {
    structured = parseStructuredTask(taskJson);
    stored = parseObservationJsonl(observationsJsonl ?? "");
  } catch (err) {
    return `structured files are invalid: ${(err as Error).message}`;
  }

  if (structured.frontmatter.id !== parsedLegacy.frontmatter.id) {
    return `id mismatch: ${TASK_MARKDOWN_FILE} says ${parsedLegacy.frontmatter.id}, ${TASK_JSON_FILE} says ${structured.frontmatter.id}`;
  }

  const key = (o: { at: string; author: string; markdown: string }) => `${o.at} ${o.author} ${o.markdown}`;
  const present = new Set(stored.map(key));
  const legacyObservations = structuredFromLegacy(parsedLegacy).observations;
  const missing = legacyObservations.filter((observation) => !present.has(key(observation)));
  if (missing.length > 0) {
    return `${missing.length} observation(s) in ${TASK_MARKDOWN_FILE} are not in ${OBSERVATIONS_FILE} (first: ${missing[0].at})`;
  }
  return null;
}

async function removeMarkdown(options: Options): Promise<number> {
  const board = path.resolve(REPO_ROOT, options.board);
  const ids = await taskIds(board);
  const removed: string[] = [];
  const blocked: string[] = [];
  let alreadyGone = 0;

  for (const id of ids) {
    const dir = path.join(board, id);
    const legacy = await readIfPresent(path.join(dir, TASK_MARKDOWN_FILE));
    if (legacy === null) {
      alreadyGone += 1;
      continue;
    }
    const problem = verifyRemovable(
      legacy,
      await readIfPresent(path.join(dir, TASK_JSON_FILE)),
      await readIfPresent(path.join(dir, OBSERVATIONS_FILE)),
    );
    if (problem !== null) {
      blocked.push(`${id}: ${problem}`);
      continue;
    }
    removed.push(id);
    if (!options.dryRun && options.confirmed) {
      await fs.rm(path.join(dir, TASK_MARKDOWN_FILE));
    }
  }

  const applied = !options.dryRun && options.confirmed;
  report({
    command: "remove-markdown",
    board,
    dryRun: options.dryRun,
    applied,
    tasks: ids.length,
    removable: removed.length,
    removed: applied ? removed.length : 0,
    alreadyStructuredOnly: alreadyGone,
    blocked,
  });

  if (!applied && removed.length > 0) {
    console.error(
      `\nNothing was deleted. Re-run with --yes to remove ${removed.length} task.md file(s):\n` +
        `  npm run migrate:structured -- remove-markdown --yes`,
    );
  }
  if (blocked.length > 0) {
    console.error(`\n${blocked.length} task(s) were kept because verification failed; see "blocked" above.`);
  }
  return blocked.length;
}

// ── status ───────────────────────────────────────────────────────────────────
async function status(options: Options): Promise<number> {
  const board = path.resolve(REPO_ROOT, options.board);
  const ids = await taskIds(board);
  const markdownOnly: string[] = [];
  const structuredOnly: string[] = [];
  const both: string[] = [];
  const empty: string[] = [];

  for (const id of ids) {
    const dir = path.join(board, id);
    const hasMarkdown = (await readIfPresent(path.join(dir, TASK_MARKDOWN_FILE))) !== null;
    const hasJson = (await readIfPresent(path.join(dir, TASK_JSON_FILE))) !== null;
    if (hasMarkdown && hasJson) both.push(id);
    else if (hasJson) structuredOnly.push(id);
    else if (hasMarkdown) markdownOnly.push(id);
    else empty.push(id);
  }

  report({
    command: "status",
    board,
    tasks: ids.length,
    structuredOnly: structuredOnly.length,
    markdownOnly: markdownOnly.length,
    // Converted but not yet cleaned up: task.json wins, task.md is a stale copy.
    bothPresent: both.length,
    missingBoth: empty,
    migrationComplete: markdownOnly.length === 0 && both.length === 0 && ids.length > 0,
  });
  return empty.length;
}

function report(payload: Record<string, unknown>): void {
  console.log(JSON.stringify(payload, null, 2));
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const options = parseOptions();
  if (options.output && options.command !== "convert") {
    throw new Error("--output only applies to the convert command.");
  }
  const problems =
    options.command === "convert"
      ? await convert(options)
      : options.command === "remove-markdown"
        ? await removeMarkdown(options)
        : await status(options);
  if (problems > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
