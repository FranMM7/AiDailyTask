/**
 * Graphify adapter — runs the external "graphify" indexer
 * (github.com/safishamsi/graphify) and normalizes its native graph.json into our
 * shared CodeGraph* shape.
 *
 * We invoke it in offline AST mode (`extract <root> --code-only --no-cluster`), which
 * needs no API key. Graphify writes `<out>/graphify-out/graph.json`; we translate that:
 *   • absolute `source_file` paths → project-relative `file` (paths never leak to the UI/MCP);
 *   • node `type`/`metadata`/`label` → our node `kind` (namespace/class/function/method/file);
 *   • dangling edge targets (framework/3rd-party refs like `system`, `os`) → synthesized
 *     `external` nodes, so every edge endpoint resolves.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  CodeGraphEdge,
  CodeGraphLang,
  CodeGraphNode,
  CodeGraphNodeKind,
  CodeGraphRelation,
} from "@AiDailyTasks/shared";

interface RawNode {
  id: string;
  label?: string;
  source_file?: string;
  source_location?: string;
  type?: string;
  file_type?: string;
  metadata?: Record<string, unknown>;
}
interface RawEdge {
  source: string;
  target: string;
  relation?: string;
}
interface RawGraph {
  nodes?: RawNode[];
  edges?: RawEdge[];
}

export interface GraphifyResult {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  languages: CodeGraphLang[];
}

const EXT_LANG: Record<string, CodeGraphLang> = {
  ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
  ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".py": "py",
  ".cs": "cs",
  ".go": "go",
  ".java": "java",
  ".rb": "rb",
  ".rs": "rs",
  ".php": "php",
};

const RELATION_MAP: Record<string, CodeGraphRelation> = {
  contains: "contains",
  imports: "imports",
  imports_from: "imports_from",
  calls: "calls",
  method: "method",
  references: "references",
};

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Run graphify's extractor, then read + normalize its graph.json. */
export async function runGraphify(
  root: string,
  outDir: string,
  command: string,
): Promise<GraphifyResult> {
  await fs.mkdir(outDir, { recursive: true });
  const cmd =
    `${command} extract "${root}" --code-only --no-cluster --out "${outDir}"`;
  await new Promise<void>((resolve, reject) => {
    let err = "";
    const child = spawn(cmd, { cwd: root, shell: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      // Surface graphify's own message (e.g. missing API key, command not found).
      const tail = err.trim().split(/\r?\n/).slice(-3).join(" ").trim();
      reject(new Error(`graphify extract exited with code ${code}${tail ? `: ${tail}` : ""}`));
    });
  });

  const graphPath = path.join(outDir, "graphify-out", "graph.json");
  let raw: RawGraph;
  try {
    raw = JSON.parse(await fs.readFile(graphPath, "utf8")) as RawGraph;
  } catch (err) {
    throw new Error(`graphify produced no readable graph.json: ${(err as Error).message}`);
  }
  return normalizeGraphify(raw, root);
}

/** Translate a graphify graph.json (already loaded) into our shared shape. Exported for tests. */
export function normalizeGraphify(raw: RawGraph, root: string): GraphifyResult {
  const rootAbs = path.resolve(root);
  const relFile = (abs: string | undefined): string | undefined => {
    if (!abs) return undefined;
    const rel = path.relative(rootAbs, path.resolve(abs));
    if (rel.startsWith("..") || path.isAbsolute(rel)) return toPosix(abs); // out of tree
    return toPosix(rel);
  };
  const parseLine = (loc: string | undefined): number | undefined => {
    const m = /^L?(\d+)/.exec(loc ?? "");
    return m ? Number(m[1]) : undefined;
  };
  const topGroup = (file: string | undefined): string => {
    if (!file) return "(external)";
    const slash = file.indexOf("/");
    return slash === -1 ? "." : file.slice(0, slash);
  };
  const langOf = (file: string | undefined): CodeGraphLang | undefined =>
    file ? EXT_LANG[path.extname(file).toLowerCase()] ?? "other" : undefined;

  const inferKind = (n: RawNode): CodeGraphNodeKind => {
    const meta = n.metadata ?? {};
    const kindMeta = String(meta.kind ?? "");
    if (n.type === "namespace" || kindMeta.includes("namespace")) return "namespace";
    const label = n.label ?? "";
    const base = n.source_file ? path.basename(n.source_file) : "";
    if (base && label === base) return "file";
    if (label.endsWith("()")) return label.startsWith(".") ? "method" : "function";
    if (meta.scope_chain !== undefined || meta.namespace !== undefined) return "class";
    return "other";
  };

  const nodes = new Map<string, CodeGraphNode>();
  for (const rn of raw.nodes ?? []) {
    if (!rn.id || nodes.has(rn.id)) continue;
    const file = relFile(rn.source_file);
    nodes.set(rn.id, {
      id: rn.id,
      label: rn.label ?? rn.id,
      kind: inferKind(rn),
      file,
      line: parseLine(rn.source_location),
      group: topGroup(file),
      lang: langOf(file),
      inDegree: 0,
      outDegree: 0,
    });
  }

  const edgeSeen = new Set<string>();
  const edges: CodeGraphEdge[] = [];
  const ensureExternal = (id: string): void => {
    if (nodes.has(id)) return;
    nodes.set(id, {
      id,
      label: id,
      kind: "external",
      group: "(external)",
      inDegree: 0,
      outDegree: 0,
    });
  };

  for (const re of raw.edges ?? []) {
    if (!re.source || !re.target) continue;
    ensureExternal(re.source);
    ensureExternal(re.target);
    const relation = RELATION_MAP[re.relation ?? ""] ?? "references";
    const key = `${re.source}|${re.target}|${relation}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    edges.push({ source: re.source, target: re.target, relation });
  }

  for (const e of edges) {
    const s = nodes.get(e.source);
    const t = nodes.get(e.target);
    if (s) s.outDegree++;
    if (t) t.inDegree++;
  }

  const languages = [
    ...new Set(
      [...nodes.values()].map((n) => n.lang).filter((l): l is CodeGraphLang => !!l),
    ),
  ].sort();

  return { nodes: [...nodes.values()], edges, languages };
}
