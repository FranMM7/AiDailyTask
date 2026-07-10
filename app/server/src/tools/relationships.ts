/**
 * Relationship extraction + reconciliation.
 *
 * Sources, in priority order:
 *   1. the "Relationships & sequencing" table (authoritative, structured),
 *   2. tight arrows (C3 → C2) in the relationships prose,
 *   3. per-task detail bodies (parent-family verbs + relates),
 *   4. per-task Details cells (relates only).
 *
 * Directed depends_on/blocks are stored once (A depends_on B); the inverse is
 * derived. Conflicting opposite edges are dropped (first/highest-priority wins).
 */
import { normalizeId, padId } from "@AiDailyTaks/shared";
import type { Cell } from "./md";
import type { Warning } from "./normalize";

export interface Edge {
  kind: "depends_on" | "blocks" | "parent" | "relates_to";
  /** for depends_on: a depends on b. for parent: a's parent is b. */
  a: string;
  b: string;
  source: string;
}

export interface RelResult {
  depends_on: Map<string, string[]>;
  blocks: Map<string, string[]>;
  parent: Map<string, string | null>;
  children: Map<string, string[]>;
  relates_to: Map<string, string[]>;
  edges: Edge[];
  warnings: Warning[];
}

export interface TaskText {
  id: string;
  summaryText: string;
  scopeText: string;
}

const RANGE_RE = /C0*(\d+)\s*[–—-]\s*C0*(\d+)/g;
const SINGLE_RE = /C0*(\d+)/g;

/** Extract all task numbers referenced in text (expands ranges), filtered to valid ids. */
export function extractIds(text: string, valid: Set<number>): number[] {
  const nums = new Set<number>();
  for (const m of text.matchAll(RANGE_RE)) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (lo <= hi && hi - lo < 100) for (let n = lo; n <= hi; n++) nums.add(n);
  }
  for (const m of text.matchAll(SINGLE_RE)) nums.add(Number(m[1]));
  return [...nums].filter((n) => valid.has(n)).sort((x, y) => x - y);
}

export function buildRelationships(
  relTable: Cell[][] | undefined,
  zone1Text: string,
  tasks: TaskText[],
  validNums: Set<number>,
): RelResult {
  const warnings: Warning[] = [];
  const edges: Edge[] = [];
  const dep = new Set<string>(); // "A|B" => A depends_on B
  const parentMap = new Map<string, string>();
  const relates = new Set<string>(); // "min|max"

  const norm = (n: number) => padId(n);

  function addDep(aNum: number, bNum: number, source: string): void {
    if (!validNums.has(aNum) || !validNums.has(bNum) || aNum === bNum) return;
    const a = norm(aNum);
    const b = norm(bNum);
    if (dep.has(`${b}|${a}`)) {
      warnings.push({ id: a, field: "depends_on", message: `conflict: ${a}→${b} dropped (${b}→${a} already set) [${source}]` });
      return;
    }
    if (dep.has(`${a}|${b}`)) return;
    dep.add(`${a}|${b}`);
    edges.push({ kind: "depends_on", a, b, source });
  }

  const addBlock = (aNum: number, bNum: number, source: string) => addDep(bNum, aNum, source);

  function addRelates(aNum: number, bNum: number, source: string): void {
    if (!validNums.has(aNum) || !validNums.has(bNum) || aNum === bNum) return;
    const a = norm(aNum);
    const b = norm(bNum);
    const key = idNumOf(a) < idNumOf(b) ? `${a}|${b}` : `${b}|${a}`;
    if (relates.has(key)) return;
    relates.add(key);
    edges.push({ kind: "relates_to", a, b, source });
  }

  function ancestors(id: string): Set<string> {
    const seen = new Set<string>();
    let cur = parentMap.get(id);
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      cur = parentMap.get(cur);
    }
    return seen;
  }

  function addParent(childNum: number, parentNum: number, source: string, relatesToo: boolean): void {
    if (!validNums.has(childNum) || !validNums.has(parentNum) || childNum === parentNum) return;
    const child = norm(childNum);
    const parent = norm(parentNum);
    if (ancestors(parent).has(child)) {
      warnings.push({ id: child, field: "parent", message: `cycle: ${child}→parent ${parent} dropped [${source}]` });
      return;
    }
    const existing = parentMap.get(child);
    if (existing && existing !== parent) {
      warnings.push({ id: child, field: "parent", message: `conflict: parent ${parent} ignored, kept ${existing} [${source}]` });
      return;
    }
    if (!existing) {
      parentMap.set(child, parent);
      edges.push({ kind: "parent", a: child, b: parent, source });
    }
    if (relatesToo) addRelates(childNum, parentNum, source);
  }

  // ── verb scanning ─────────────────────────────────────────────────────────
  interface ScanOpts {
    depsBlocks: boolean;
    parentFamily: boolean;
    relates: boolean;
  }

  function scanVerbs(subjectNum: number, text: string, source: string, opts: ScanOpts): void {
    if (opts.depsBlocks) {
      for (const m of text.matchAll(/\b(?:slice of|after|unlocked by|depends on|consumes)\s+(?:the\s+)?C0*(\d+)/gi))
        addDep(subjectNum, Number(m[1]), source);
      for (const m of text.matchAll(/\b(?:enables|unlocks|sets up|before)\s+(?:the\s+)?C0*(\d+)/gi))
        addBlock(subjectNum, Number(m[1]), source);
    }
    if (opts.parentFamily) {
      for (const m of text.matchAll(/\bsubsumes\s+(?:the\s+)?C0*(\d+)/gi))
        addParent(Number(m[1]), subjectNum, source, true);
      for (const m of matchesWithGuard(text, /\babsorbs\s+(?:the\s+)?(?:former\s+)?C0*(\d+)/gi))
        addParent(Number(m[1]), subjectNum, source, true);
      for (const m of matchesWithGuard(text, /\b(?:folded into|subsumed by|split from|spun out of|remainder of)\s+C0*(\d+)/gi))
        addParent(subjectNum, Number(m[1]), source, true);
      for (const m of text.matchAll(/\bsplit out (?:as|into)\s+C0*(\d+)/gi))
        addParent(Number(m[1]), subjectNum, source, true);
    }
    if (opts.relates) {
      const re = /\b(?:relates?(?:\s+to)?|side-effect of|same\s+\w+\s+(?:class|family)\s+as)\b([^.]*)/gi;
      for (const m of text.matchAll(re)) {
        for (const n of extractIds(m[1], validNums)) addRelates(subjectNum, n, source);
      }
    }
  }

  /**
   * matchAll but drops matches whose context makes them spurious:
   *  - "absorbs former C40"  → the OLD C40 scope, not the current task
   *  - "Batch 4 … folded into C26" → a sub-batch was folded, not the task
   */
  function* matchesWithGuard(text: string, re: RegExp): Generator<RegExpMatchArray> {
    for (const m of text.matchAll(re)) {
      const idx = m.index ?? 0;
      const before = text.slice(Math.max(0, idx - 40), idx);
      const after = text.slice(idx + m[0].length, idx + m[0].length + 40);
      if (/\bformer\b/i.test(m[0]) || /\bformer\b/i.test(before)) continue;
      if (/\bBatch\b/i.test(before) || /\bBatch\b/i.test(after)) continue;
      yield m;
    }
  }

  // ── 1. relationships table ──────────────────────────────────────────────────
  if (relTable && relTable.length > 1) {
    for (const row of relTable.slice(1)) {
      const idText = row[0]?.text ?? "";
      const relText = row[1]?.text ?? "";
      const impText = row[2]?.text ?? "";
      const subjects = extractIds(idText, validNums);
      const combined = `${relText}\n${impText}`;
      const umbrella = /umbrella|phases|remainders/i.test(relText);
      for (const subj of subjects) {
        if (umbrella) {
          for (const t of extractIds(relText, validNums)) if (t !== subj) addParent(t, subj, "rel-table:umbrella", false);
        }
        scanVerbs(subj, combined, `rel-table:C${subj}`, { depsBlocks: true, parentFamily: true, relates: true });
      }
    }
  }

  // ── 2. zone-1 prose tight arrows ─────────────────────────────────────────────
  for (const m of zone1Text.matchAll(/C0*(\d+)\s*(?:→|->)\s*C0*(\d+)/g))
    addDep(Number(m[1]), Number(m[2]), "zone1-arrow");

  // ── 3 + 4. per-task inline ───────────────────────────────────────────────────
  // Parent-family verbs are read from the STATUS cell (clean structural prose
  // like "split out as C46"); detail bodies are scanned for relates only,
  // because bodies carry parenthetical asides ("(subsumed by C1)") and
  // sub-batch notes ("Batch 4 … folded into C26") that would mis-parent.
  for (const t of tasks) {
    const num = idNumOf(t.id);
    if (Number.isNaN(num)) continue;
    scanVerbs(num, t.summaryText, `cell:${t.id}`, { depsBlocks: false, parentFamily: true, relates: true });
    scanVerbs(num, t.scopeText, `body:${t.id}`, { depsBlocks: false, parentFamily: false, relates: true });
  }

  // ── assemble per-task maps ────────────────────────────────────────────────────
  const ids = [...validNums].sort((a, b) => a - b).map(norm);
  const depends_on = new Map<string, string[]>();
  const blocks = new Map<string, string[]>();
  const parent = new Map<string, string | null>();
  const children = new Map<string, string[]>();
  const relates_to = new Map<string, string[]>();

  for (const id of ids) {
    depends_on.set(id, []);
    blocks.set(id, []);
    parent.set(id, parentMap.get(id) ?? null);
    children.set(id, []);
    relates_to.set(id, []);
  }
  for (const key of dep) {
    const [a, b] = key.split("|");
    depends_on.get(a)!.push(b);
    blocks.get(b)!.push(a);
  }
  for (const [child, par] of parentMap) children.get(par)?.push(child);
  for (const key of relates) {
    const [a, b] = key.split("|");
    relates_to.get(a)!.push(b);
    relates_to.get(b)!.push(a);
  }

  const sortIds = (arr: string[]) => [...new Set(arr)].sort((x, y) => idNumOf(x) - idNumOf(y));
  for (const id of ids) {
    depends_on.set(id, sortIds(depends_on.get(id)!));
    blocks.set(id, sortIds(blocks.get(id)!));
    children.set(id, sortIds(children.get(id)!));
    relates_to.set(id, sortIds(relates_to.get(id)!));
  }

  return { depends_on, blocks, parent, children, relates_to, edges, warnings };
}

function idNumOf(id: string): number {
  const m = /^C0*(\d+)$/.exec(normalizeId(id));
  return m ? Number(m[1]) : NaN;
}
