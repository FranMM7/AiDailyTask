/**
 * Sibling-doc mapping (pure logic; the CLI performs the actual copies).
 *
 * 1. explicit  — a task's Details cell / detail body references `Docs/<name>.md`
 * 2. filename  — a doc whose name starts with the task id, e.g. `C05-<slug>.md`
 * 3. unfiled   — every other .md doc → board/_meta/unfiled/
 * 4. skipped   — non-markdown (e.g. a build script left alongside the docs)
 */
export interface DocMapping {
  mapped: Array<{ name: string; taskNum: number; method: "explicit" | "filename" }>;
  unfiled: string[];
  skipped: Array<{ name: string; reason: string }>;
  /** taskNum → doc names whose `Docs/<name>` refs should be rewritten to `files/<name>`. */
  rewriteByTask: Map<number, Set<string>>;
}

export interface DocTaskText {
  num: number;
  summaryText: string;
  scopeText: string;
}

const DOCREF_RE = /Docs\/([A-Za-z0-9._-]+\.md)/g;

export function mapDocs(
  fileNames: string[],
  tasks: DocTaskText[],
  auditSourceName: string,
  validNums: Set<number>,
): DocMapping {
  const files = new Set(fileNames);
  const assigned = new Map<string, { taskNum: number; method: "explicit" | "filename" }>();
  const rewriteByTask = new Map<number, Set<string>>();
  const skipped: Array<{ name: string; reason: string }> = [];

  const addRewrite = (taskNum: number, name: string) => {
    if (!rewriteByTask.has(taskNum)) rewriteByTask.set(taskNum, new Set());
    rewriteByTask.get(taskNum)!.add(name);
  };

  // 1. explicit references
  for (const t of tasks) {
    const text = `${t.summaryText}\n${t.scopeText}`;
    for (const m of text.matchAll(DOCREF_RE)) {
      const name = m[1];
      if (!files.has(name)) continue;
      const owner = assigned.get(name);
      if (!owner) {
        assigned.set(name, { taskNum: t.num, method: "explicit" });
        addRewrite(t.num, name);
      } else if (owner.taskNum === t.num) {
        addRewrite(t.num, name);
      }
    }
  }

  // 2. filename heuristic for the rest
  for (const name of fileNames) {
    if (name === auditSourceName) continue;
    if (!name.toLowerCase().endsWith(".md")) {
      skipped.push({ name, reason: "not a markdown doc (script/other) — left in place" });
      continue;
    }
    if (assigned.has(name)) continue;
    let num = NaN;
    const c = /^C(\d+)-/i.exec(name);
    if (c) num = Number(c[1]);
    if (!Number.isNaN(num) && validNums.has(num)) {
      assigned.set(name, { taskNum: num, method: "filename" });
    }
  }

  // 3. unfiled = remaining .md docs (excluding the audit source itself)
  const unfiled: string[] = [];
  for (const name of fileNames) {
    if (name === auditSourceName) continue;
    if (!name.toLowerCase().endsWith(".md")) continue; // already in skipped
    if (assigned.has(name)) continue;
    unfiled.push(name);
  }

  const mapped = [...assigned.entries()].map(([name, v]) => ({ name, taskNum: v.taskNum, method: v.method }));
  mapped.sort((a, b) => a.taskNum - b.taskNum || a.name.localeCompare(b.name));
  unfiled.sort();
  skipped.sort((a, b) => a.name.localeCompare(b.name));

  return { mapped, unfiled, skipped, rewriteByTask };
}
