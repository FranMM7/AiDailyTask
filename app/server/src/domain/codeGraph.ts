/**
 * Built-in code-graph indexer.
 *
 * Scans a project's source tree and produces a normalized module-dependency graph
 * (the shape in @AiDailyTasks/shared): one node per source file, one edge per
 * resolved import / require / `using`. It is intentionally parser-free — it reads
 * the top of each file and extracts dependencies with per-language regexes, so it
 * needs no external toolchain and works across JS/TS, Python and C# (.NET) alike.
 *
 * This is the DEFAULT indexer. An external indexer (e.g. "graphify") can replace it
 * by emitting the same normalized JSON — see CodeGraphService.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type {
  CodeGraphEdge,
  CodeGraphNode,
  CodeGraphLang,
} from "@AiDailyTasks/shared";

/** Directories never worth walking (generated output, VCS, deps, caches). */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "bin", "obj",
  ".vs", ".vscode", ".idea", "coverage", "__pycache__", ".venv", "venv",
  ".mypy_cache", ".pytest_cache", ".next", ".nuxt", ".turbo", "target",
  ".gradle", ".cache", ".parcel-cache", ".angular",
]);

const EXT_LANG: Record<string, CodeGraphLang> = {
  ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
  ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".py": "py",
  ".cs": "cs",
};

/** JS/TS extensions tried when resolving an extensionless relative import. */
const JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip files larger than 2 MB
const READ_HEAD_CHARS = 300_000; // imports live at the top; cap regex work
const READ_CONCURRENCY = 24;

export interface ScanResult {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  languages: CodeGraphLang[];
  truncated: boolean;
}

interface FileEntry {
  abs: string;
  /** project-relative POSIX path */
  rel: string;
  lang: CodeGraphLang;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Recursively collect supported source files, honoring IGNORED_DIRS and the file cap. */
async function collectFiles(root: string): Promise<{ files: FileEntry[]; truncated: boolean }> {
  const files: FileEntry[] = [];
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const entry of entries) {
      if (truncated) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          // allow non-ignored dot dirs? skip hidden dirs by default to stay quiet
          continue;
        }
        await walk(abs);
      } else if (entry.isFile()) {
        const lang = EXT_LANG[path.extname(entry.name).toLowerCase()];
        if (!lang) continue;
        files.push({ abs, rel: toPosix(path.relative(root, abs)), lang });
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
      }
    }
  }

  await walk(root);
  return { files, truncated };
}

async function readHead(abs: string): Promise<string | null> {
  try {
    const stat = await fs.stat(abs);
    if (stat.size > MAX_FILE_BYTES) return null;
    const content = await fs.readFile(abs, "utf8");
    return content.length > READ_HEAD_CHARS ? content.slice(0, READ_HEAD_CHARS) : content;
  } catch {
    return null;
  }
}

/** Run `fn` over items with bounded concurrency. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

// ── Per-language dependency extraction ────────────────────────────────────────

/** Collect import/require/dynamic-import specifiers from JS/TS source. */
function jsSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const patterns = [
    // import ... from 'x'  |  import 'x'
    /import\s+(?:[^'"();]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
    // export ... from 'x'
    /export\s+[^'"();]*?\sfrom\s+['"]([^'"]+)['"]/g,
    // require('x')
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    // dynamic import('x')
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) specs.push(m[1]);
  }
  return specs;
}

/** Collect module specifiers from Python `import`/`from ... import`. */
function pySpecifiers(src: string): string[] {
  const specs: string[] = [];
  // from <mod> import ...   (mod may be relative, e.g. ".", "..pkg.sub")
  const fromRe = /^\s*from\s+(\.*[\w.]*)\s+import\s+/gm;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src)) !== null) {
    if (m[1]) specs.push(m[1]);
  }
  // import a.b.c, d.e as f
  const importRe = /^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/gm;
  while ((m = importRe.exec(src)) !== null) {
    for (const part of m[1].split(",")) {
      const mod = part.trim().split(/\s+as\s+/)[0].trim();
      if (mod) specs.push(mod);
    }
  }
  return specs;
}

// ── Resolvers (specifier -> existing file id, or null for external/unresolved) ──

function resolveJs(importerRel: string, spec: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith(".")) return null; // bare specifier = external package
  const baseDir = path.posix.dirname(importerRel);
  const candidate = path.posix.normalize(path.posix.join(baseDir, spec));
  if (fileSet.has(candidate)) return candidate;
  // ESM-style "./x.js" often maps to x.ts on disk
  const extMatch = candidate.match(/\.(js|jsx|mjs|cjs)$/);
  if (extMatch) {
    const stem = candidate.slice(0, -extMatch[0].length);
    for (const ext of JS_EXTS) if (fileSet.has(stem + ext)) return stem + ext;
  }
  for (const ext of JS_EXTS) if (fileSet.has(candidate + ext)) return candidate + ext;
  for (const ext of JS_EXTS) if (fileSet.has(`${candidate}/index${ext}`)) return `${candidate}/index${ext}`;
  return null;
}

function resolvePyFile(candidate: string, fileSet: Set<string>): string | null {
  const c = candidate.replace(/^\.\//, "");
  if (fileSet.has(`${c}.py`)) return `${c}.py`;
  if (fileSet.has(`${c}/__init__.py`)) return `${c}/__init__.py`;
  return null;
}

function resolvePy(importerRel: string, spec: string, fileSet: Set<string>): string | null {
  if (spec.startsWith(".")) {
    const dots = spec.match(/^\.*/)![0].length;
    const rest = spec.slice(dots).split(".").filter(Boolean);
    let dir = path.posix.dirname(importerRel);
    for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
    const candidate = path.posix.normalize([dir, ...rest].filter((s) => s && s !== ".").join("/"));
    return resolvePyFile(candidate, fileSet);
  }
  const parts = spec.split(".").filter(Boolean);
  // absolute-from-root, then try progressively shorter module tails (src/ layouts vary)
  for (let i = 0; i < parts.length; i++) {
    const hit = resolvePyFile(parts.slice(i).join("/"), fileSet);
    if (hit) return hit;
  }
  return null;
}

// ── C# (.NET): namespace-based resolution ─────────────────────────────────────

function csNamespaces(src: string): string[] {
  const out: string[] = [];
  const re = /\bnamespace\s+([A-Za-z_][\w.]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

function csUsings(src: string): string[] {
  const out: string[] = [];
  // `using X.Y.Z;` — excludes `using static ...` and `using Alias = ...;`
  const re = /^\s*using\s+(?!static\b)([A-Za-z_][\w.]*)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

/**
 * Scan `root` and build the normalized code graph. Never throws for individual
 * unreadable files; only a completely unreadable root surfaces as an empty graph.
 */
export async function scanCodeGraph(root: string): Promise<ScanResult> {
  const { files, truncated } = await collectFiles(root);
  const fileSet = new Set(files.map((f) => f.rel));

  const sources = await mapLimit(files, READ_CONCURRENCY, async (f) => ({
    file: f,
    src: (await readHead(f.abs)) ?? "",
  }));

  // First pass for C#: map declared namespace -> file ids.
  const nsToFiles = new Map<string, string[]>();
  for (const { file, src } of sources) {
    if (file.lang !== "cs" || !src) continue;
    for (const ns of csNamespaces(src)) {
      const arr = nsToFiles.get(ns) ?? [];
      arr.push(file.rel);
      nsToFiles.set(ns, arr);
    }
  }

  const edgeSet = new Set<string>();
  const edges: CodeGraphEdge[] = [];
  const addEdge = (source: string, target: string): void => {
    if (source === target) return;
    const key = `${source} ${target}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ source, target, relation: "imports" });
  };

  for (const { file, src } of sources) {
    if (!src) continue;
    if (file.lang === "cs") {
      for (const ns of csUsings(src)) {
        const targets = nsToFiles.get(ns);
        if (!targets) continue; // using an external/framework namespace
        for (const t of targets) addEdge(file.rel, t);
      }
    } else if (file.lang === "py") {
      for (const spec of pySpecifiers(src)) {
        const t = resolvePy(file.rel, spec, fileSet);
        if (t) addEdge(file.rel, t);
      }
    } else {
      for (const spec of jsSpecifiers(src)) {
        const t = resolveJs(file.rel, spec, fileSet);
        if (t) addEdge(file.rel, t);
      }
    }
  }

  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const e of edges) {
    outDegree.set(e.source, (outDegree.get(e.source) ?? 0) + 1);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  const nodes: CodeGraphNode[] = files.map((f) => {
    const slash = f.rel.indexOf("/");
    return {
      id: f.rel,
      label: path.posix.basename(f.rel),
      kind: "file" as const,
      file: f.rel,
      group: slash === -1 ? "." : f.rel.slice(0, slash),
      lang: f.lang,
      inDegree: inDegree.get(f.rel) ?? 0,
      outDegree: outDegree.get(f.rel) ?? 0,
    };
  });

  const languages = [...new Set(files.map((f) => f.lang))].sort();
  return { nodes, edges, languages, truncated };
}
