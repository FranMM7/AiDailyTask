/**
 * One-time audit importer (idempotent, re-runnable).
 *
 *   tsx src/tools/import-audit.ts [--dry-run] [--source <path>]
 *
 * Reads a markdown "audit" document — a status-overview table (one row per task)
 * followed by per-task detail sections, plus any sibling docs in the same folder —
 * and materializes the AiDailyTaks board: one board/C<NN>/task.md per row, sibling
 * docs copied into each task's files/ or board/_meta/unfiled/, plus _meta narrative
 * files and an import report. STRICTLY read-only on the source folder.
 *
 * Point it at your own file with --source <path> (or the AiDailyTaks_AUDIT_SOURCE
 * env var). See docs.ts / md.ts for the expected table + section shape.
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { padId, idNum } from "@AiDailyTaks/shared";
import type { Category, Frontmatter, Level, Status } from "@AiDailyTaks/shared";
import {
  parse,
  tables,
  tableRows,
  findHeading,
  taskSections,
  between,
  headingStart,
  nodeEnd,
  type Section,
} from "./md";
import {
  normalizeCategory,
  normalizeLevel,
  normalizeStatus,
  deriveDates,
  type Warning,
} from "./normalize";
import { buildRelationships, type TaskText } from "./relationships";
import { mapDocs, type DocTaskText } from "./docs";
import { buildBody, buildTaskMd } from "./render";

// Overridable via --source <path> or the AiDailyTaks_AUDIT_SOURCE env var.
// Relative paths resolve against the current working directory.
const DEFAULT_SOURCE = "import-source/audit.md";

interface Task {
  num: number;
  id: string;
  title: string;
  category: Category;
  severity: Level;
  risk: Level;
  status: Status;
  statusDetail: string;
  flags: string[];
  created?: string;
  updated?: string;
  completed?: string;
  summaryMd: string;
  scopeMd: string;
  hasDetail: boolean;
  sources: string[];
}

interface Args {
  dryRun: boolean;
  source: string;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let source = process.env.AiDailyTaks_AUDIT_SOURCE ?? DEFAULT_SOURCE;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--source") {
      const v = argv[++i];
      if (!v) throw new Error("--source requires a path");
      source = v;
    } else if (a.startsWith("--source=")) {
      source = a.slice("--source=".length);
    }
  }
  return { dryRun, source };
}

function resolveRoot(): string {
  if (process.env.AiDailyTaks_ROOT) return process.env.AiDailyTaks_ROOT;
  // app/server/src/tools -> ../../../.. = repo root
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "..");
}

/** Deterministic write sink; dry-run records the plan but writes nothing. */
class Sink {
  readonly plan: Array<{ path: string; bytes: number; kind: string }> = [];
  constructor(private readonly dry: boolean) {}

  async write(path: string, content: string, kind = "file"): Promise<void> {
    this.plan.push({ path, bytes: Buffer.byteLength(content, "utf8"), kind });
    if (this.dry) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  async ensureDir(path: string): Promise<void> {
    this.plan.push({ path, bytes: 0, kind: "dir" });
    if (this.dry) return;
    await mkdir(path, { recursive: true });
  }

  async copy(srcPath: string, destPath: string): Promise<void> {
    const content = await readFile(srcPath, "utf8"); // read-only on source
    await this.write(destPath, content, "copy");
  }
}

function rewriteDocRefs(text: string, docNames: Set<string> | undefined): string {
  if (!docNames) return text;
  let out = text;
  for (const name of docNames) out = out.split(`Docs/${name}`).join(`files/${name}`);
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveRoot();
  const boardDir = join(root, "board");
  const metaDir = join(boardDir, "_meta");
  const docsDir = dirname(args.source);
  const auditName = basename(args.source);

  const raw = await readFile(args.source, "utf8");
  const root_ast = parse(raw);
  const warnings: Warning[] = [];

  // ── status-overview table ─────────────────────────────────────────────────
  const allTables = tables(root_ast);
  if (allTables.length === 0) throw new Error("no tables found in source");
  const statusTable = allTables[0];
  const statusRows = tableRows(raw, statusTable);
  const relTable = allTables[1] ? tableRows(raw, allTables[1]) : undefined;

  const deviations: string[] = [];
  const dataRows = statusRows.slice(1);
  if (dataRows.length !== 56) deviations.push(`expected 56 data rows, found ${dataRows.length}`);
  for (const [i, row] of dataRows.entries()) {
    if (row.length !== 7) deviations.push(`row ${i + 1} has ${row.length} cells (expected 7)`);
  }

  // ── detail sections ─────────────────────────────────────────────────────────
  const sections = taskSections(raw, root_ast);
  const sectionByNum = new Map<number, Section>();
  const contByNum = new Map<number, Section>();
  for (const s of sections) {
    if (Number.isNaN(s.num)) continue;
    if (s.cont) contByNum.set(s.num, s);
    else if (!sectionByNum.has(s.num)) sectionByNum.set(s.num, s);
  }

  // ── build tasks ────────────────────────────────────────────────────────────
  const tasks: Task[] = [];
  for (const row of dataRows) {
    if (row.length < 7) continue;
    const rawId = row[0].text.trim();
    const num = idNum(rawId);
    if (Number.isNaN(num)) {
      warnings.push({ id: rawId || "?", field: "id", message: `unparseable id "${rawId}" — row skipped` });
      continue;
    }
    const id = padId(num);
    const category = normalizeCategory(row[2].text, id, warnings);
    const severity = normalizeLevel(row[3].text, id, "severity", warnings);
    const risk = normalizeLevel(row[4].text, id, "risk", warnings);
    const st = normalizeStatus(row[5].text, id, warnings);

    const section = sectionByNum.get(num);
    const cont = contByNum.get(num);
    let scopeMd: string;
    if (section) {
      scopeMd = section.bodyRaw;
      if (cont) scopeMd += `\n\n### Continued — ${cont.title}\n\n${cont.bodyRaw}`;
    } else {
      scopeMd = ""; // placeholder applied in buildBody
    }

    const dates = deriveDates(row[5].text, row[6].text, scopeMd, st.status);

    tasks.push({
      num,
      id,
      title: row[1].text.trim(),
      category,
      severity,
      risk,
      status: st.status,
      statusDetail: st.statusDetail,
      flags: st.flags,
      created: dates.created,
      updated: dates.updated,
      completed: dates.completed,
      summaryMd: row[6].raw,
      scopeMd,
      hasDetail: Boolean(section),
      sources: [],
    });
  }
  tasks.sort((a, b) => a.num - b.num);

  const validNums = new Set(tasks.map((t) => t.num));

  // ── relationships ────────────────────────────────────────────────────────────
  const relTexts: TaskText[] = tasks.map((t) => ({ id: t.id, summaryText: t.summaryMd, scopeText: t.scopeMd }));
  const relSectionText = (() => {
    const rel = findHeading(root_ast, "Relationships");
    const rt = findHeading(root_ast, "Runtime evidence");
    return rel ? between(raw, rel, rt) : "";
  })();
  const rel = buildRelationships(relTable, relSectionText, relTexts, validNums);
  warnings.push(...rel.warnings);

  // ── sibling docs ────────────────────────────────────────────────────────────
  const dirEntries = await readdir(docsDir, { withFileTypes: true });
  const fileNames = dirEntries.filter((e) => e.isFile()).map((e) => e.name);
  const docTasks: DocTaskText[] = tasks.map((t) => ({ num: t.num, summaryText: t.summaryMd, scopeText: t.scopeMd }));
  const docs = mapDocs(fileNames, docTasks, auditName, validNums);

  // apply mapped-doc sources + doc-ref rewrites
  const taskByNum = new Map(tasks.map((t) => [t.num, t]));
  for (const m of docs.mapped) {
    const t = taskByNum.get(m.taskNum);
    if (t) t.sources.push(`files/${m.name}`);
  }
  for (const t of tasks) {
    const rewrite = docs.rewriteByTask.get(t.num);
    t.summaryMd = rewriteDocRefs(t.summaryMd, rewrite);
    t.scopeMd = rewriteDocRefs(t.scopeMd, rewrite);
    t.sources = [...new Set(t.sources)].sort();
  }

  // ── write everything ───────────────────────────────────────────────────────
  const sink = new Sink(args.dryRun);

  for (const t of tasks) {
    const migrationTs = `${t.updated ?? t.created ?? "1970-01-01"}T00:00:00Z`;
    const fm: Frontmatter = {
      id: t.id,
      title: t.title,
      project: "Sample",
      category: t.category,
      severity: t.severity,
      risk: t.risk,
      status: t.status,
      status_detail: t.statusDetail,
      ...(t.created ? { created: t.created } : {}),
      ...(t.updated ? { updated: t.updated } : {}),
      ...(t.status === "Completed" && t.completed ? { completed: t.completed } : {}),
      archived: false,
      tags: [],
      depends_on: rel.depends_on.get(t.id) ?? [],
      blocks: rel.blocks.get(t.id) ?? [],
      relates_to: rel.relates_to.get(t.id) ?? [],
      parent: rel.parent.get(t.id) ?? null,
      children: rel.children.get(t.id) ?? [],
      sources: t.sources,
    };
    const body = buildBody({ summaryMd: t.summaryMd, scopeMd: t.scopeMd, migrationTs });
    const md = buildTaskMd(fm, body);
    const taskDir = join(boardDir, t.id);
    await sink.write(join(taskDir, "task.md"), md, "task");
    await sink.ensureDir(join(taskDir, "files"));
  }

  // copy mapped docs into each task's files/
  for (const m of docs.mapped) {
    const destId = padId(m.taskNum);
    await sink.copy(join(docsDir, m.name), join(boardDir, destId, "files", m.name));
  }
  // unfiled docs
  for (const name of docs.unfiled) {
    await sink.copy(join(docsDir, name), join(metaDir, "unfiled", name));
  }

  // ── meta narrative files ───────────────────────────────────────────────────
  const statusHeading = findHeading(root_ast, "Status overview");
  const relHeading = findHeading(root_ast, "Relationships");
  const runtimeHeading = findHeading(root_ast, "Runtime evidence");
  const firstTaskHeading = findHeading(root_ast, "C1 ");

  const preamble = statusHeading ? raw.slice(0, headingStart(statusHeading)).trimEnd() : "";
  const legend =
    statusHeading && relHeading
      ? raw.slice(nodeEnd(statusTable), headingStart(relHeading)).replace(/\n*-{3,}\s*$/g, "").trim()
      : "";
  await sink.write(
    join(metaDir, "overview.md"),
    `${preamble}\n\n## Legend\n\n${legend}\n`,
    "meta",
  );
  if (relHeading) {
    await sink.write(join(metaDir, "relationships.md"), `${between(raw, relHeading, runtimeHeading)}\n`, "meta");
  }
  if (runtimeHeading) {
    await sink.write(join(metaDir, "runtime-evidence.md"), `${between(raw, runtimeHeading, firstTaskHeading)}\n`, "meta");
  }
  await sink.write(join(metaDir, "audit-source.md"), raw, "meta");

  // ── report ──────────────────────────────────────────────────────────────────
  const rowsWithoutDetail = tasks.filter((t) => !t.hasDetail).map((t) => t.id);
  const reportJson: ReportShape = {
    generatedFrom: args.source,
    dryRun: args.dryRun,
    taskCount: tasks.length,
    taskIds: tasks.map((t) => t.id),
    rowsWithoutDetail,
    validation: {
      expectedRows: 56,
      actualRows: dataRows.length,
      expectedColumns: 7,
      deviations,
    },
    relationships: {
      edgeCount: rel.edges.length,
      edges: rel.edges,
    },
    docs: {
      mapped: docs.mapped.map((m) => ({ name: m.name, taskId: padId(m.taskNum), method: m.method })),
      unfiled: docs.unfiled,
      skipped: docs.skipped,
    },
    warnings,
  };
  await sink.write(join(metaDir, "import-report.json"), `${JSON.stringify(reportJson, null, 2)}\n`, "report");
  await sink.write(join(metaDir, "import-report.md"), renderReportMd(reportJson), "report");

  // ── console summary ──────────────────────────────────────────────────────────
  const line = (s: string) => process.stdout.write(`${s}\n`);
  line(`${args.dryRun ? "[DRY RUN] " : ""}AiDailyTaks audit import`);
  line(`  source : ${args.source}`);
  line(`  board  : ${boardDir}`);
  line(`  tasks  : ${tasks.length} (expected 56)`);
  line(`  rows without detail section: ${rowsWithoutDetail.length ? rowsWithoutDetail.join(", ") : "none"}`);
  line(`  relationship edges: ${rel.edges.length}`);
  line(`  docs mapped: ${docs.mapped.length} · unfiled: ${docs.unfiled.length} · skipped: ${docs.skipped.length}`);
  if (docs.skipped.length) for (const s of docs.skipped) line(`    skip ${s.name}: ${s.reason}`);
  line(`  warnings: ${warnings.length}`);
  if (deviations.length) for (const d of deviations) line(`  DEVIATION: ${d}`);
  line(`  files ${args.dryRun ? "planned" : "written"}: ${sink.plan.filter((p) => p.kind !== "dir").length}`);
  if (args.dryRun) {
    line("");
    line("  Planned writes:");
    for (const p of sink.plan) line(`    ${p.kind === "dir" ? "[dir] " : ""}${p.path}${p.kind === "dir" ? "" : ` (${p.bytes} B)`}`);
  }
}

interface ReportShape {
  generatedFrom: string;
  dryRun: boolean;
  taskCount: number;
  taskIds: string[];
  rowsWithoutDetail: string[];
  validation: { expectedRows: number; actualRows: number; expectedColumns: number; deviations: string[] };
  relationships: { edgeCount: number; edges: Array<{ kind: string; a: string; b: string; source: string }> };
  docs: {
    mapped: Array<{ name: string; taskId: string; method: string }>;
    unfiled: string[];
    skipped: Array<{ name: string; reason: string }>;
  };
  warnings: Warning[];
}

function renderReportMd(r: ReportShape): string {
  const lines: string[] = [];
  lines.push("# AiDailyTaks import report", "");
  lines.push(`- Source: \`${r.generatedFrom}\``);
  lines.push(`- Dry run: ${r.dryRun}`);
  lines.push(`- Tasks created: **${r.taskCount}** (expected 56)`);
  lines.push(
    `- Validation: ${r.validation.actualRows}/${r.validation.expectedRows} rows × ${r.validation.expectedColumns} cols` +
      (r.validation.deviations.length ? ` — DEVIATIONS: ${r.validation.deviations.join("; ")}` : " — OK"),
  );
  lines.push("");
  lines.push("## Rows without a detail section", "");
  lines.push(r.rowsWithoutDetail.length ? r.rowsWithoutDetail.join(", ") : "_none_", "");
  lines.push(`## Relationship edges (${r.relationships.edgeCount})`, "");
  lines.push("| kind | a | b | provenance |", "|------|---|---|------------|");
  for (const e of r.relationships.edges) lines.push(`| ${e.kind} | ${e.a} | ${e.b} | ${e.source} |`);
  lines.push("");
  lines.push("## Docs mapped", "");
  lines.push("| doc | task | method |", "|-----|------|--------|");
  for (const m of r.docs.mapped) lines.push(`| ${m.name} | ${m.taskId} | ${m.method} |`);
  lines.push("");
  lines.push("## Docs unfiled (board/_meta/unfiled/)", "");
  lines.push(r.docs.unfiled.length ? r.docs.unfiled.map((n) => `- ${n}`).join("\n") : "_none_", "");
  lines.push("## Docs skipped", "");
  lines.push(r.docs.skipped.length ? r.docs.skipped.map((s) => `- ${s.name} — ${s.reason}`).join("\n") : "_none_", "");
  lines.push("## Normalization warnings", "");
  lines.push(
    r.warnings.length ? r.warnings.map((w) => `- [${w.id}] ${w.field}: ${w.message}`).join("\n") : "_none_",
    "",
  );
  return `${lines.join("\n")}\n`;
}

main().catch((err) => {
  process.stderr.write(`import-audit failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
