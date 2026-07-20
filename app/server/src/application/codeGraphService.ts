/**
 * CodeGraphService — generates and serves per-project code graphs.
 *
 * Output is written under env.graphsDir/<projectId>/ (git-ignored, exactly like board/),
 * so a project's source map never lands in this repo's history. Generation runs as a
 * background job: the HTTP route returns immediately with status "indexing" and the
 * browser is notified over the SSE bus when it flips to "ready"/"failed".
 *
 * The engine is chosen PER PROJECT (projects.json `indexer` field):
 *   • "builtin" (default) — the parser-free scanner (domain/codeGraph.ts): file nodes +
 *     import edges, no toolchain, handles C#/.NET.
 *   • "graphify" — the richer AST graph (symbols + calls) via the external graphify tool.
 * A global CODEGRAPH_INDEXER env var sets the fallback default; GRAPHIFY_COMMAND overrides
 * how graphify is invoked (default "python -m graphify"). The normalized CodeGraphData is
 * always written to graphs/<projectId>/code-graph.json regardless of engine; when graphify
 * runs it also leaves its native graphs/<projectId>/graphify-out/graph.json, which the
 * graphify passthrough (runGraphifyText) queries.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  CodeGraphData,
  CodeGraphEdge,
  CodeGraphIndexer,
  CodeGraphLang,
  CodeGraphMeta,
  CodeGraphNode,
  CodeGraphNodeKind,
  CodeGraphRelation,
} from "@AiDailyTasks/shared";
import { scanCodeGraph } from "../domain/codeGraph";
import { runGraphify } from "../domain/graphifyAdapter";
import type { ProjectsService } from "../projects";
import type { EventBus } from "../infrastructure/eventBus";
import type { Env } from "../env";
import { NotFoundError, ValidationError } from "../errors";

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

interface GraphFile {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
}

interface IndexResult extends GraphFile {
  languages: CodeGraphLang[];
  truncated: boolean;
}

export class CodeGraphService {
  /** projectIds with an in-flight generation. */
  private readonly running = new Set<string>();
  private readonly defaultIndexer: CodeGraphIndexer;
  private readonly graphifyCommand: string;

  constructor(
    private readonly env: Env,
    private readonly projects: ProjectsService,
    private readonly bus: EventBus,
  ) {
    this.defaultIndexer = process.env.CODEGRAPH_INDEXER?.trim() === "graphify" ? "graphify" : "builtin";
    this.graphifyCommand = process.env.GRAPHIFY_COMMAND?.trim() || "python -m graphify";
  }

  private indexerName(indexer: CodeGraphIndexer): string {
    return indexer === "graphify" ? "graphify" : "built-in";
  }

  /** Effective engine for a project: its own setting, else the global default. */
  private indexerFor(projectId: string): CodeGraphIndexer {
    return this.projects.get(projectId)?.indexer ?? this.defaultIndexer;
  }

  private projectDir(projectId: string): string {
    if (!SAFE_ID.test(projectId)) {
      throw new ValidationError(`Project id "${projectId}" is not a valid folder name`);
    }
    return path.join(this.env.graphsDir, projectId);
  }

  /** Kick off (or report already-running) generation. Returns the current meta immediately. */
  async generate(projectId: string): Promise<CodeGraphMeta> {
    const project = this.projects.get(projectId);
    if (!project) throw new NotFoundError(`Project "${projectId}" not found`);
    const root = project.root?.trim();
    if (!root) {
      throw new ValidationError(`Project "${projectId}" has no source path — set its root first`);
    }

    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(root);
    } catch {
      throw new ValidationError(`Source path does not exist: ${root}`);
    }
    if (!stat.isDirectory()) throw new ValidationError(`Source path is not a directory: ${root}`);

    const indexer = project.indexer ?? this.defaultIndexer;
    if (this.running.has(projectId)) return this.indexingMeta(projectId, root, indexer);

    this.running.add(projectId);
    const meta = this.indexingMeta(projectId, root, indexer);
    await this.writeMeta(projectId, meta); // persist "indexing" so a reload still shows progress
    this.bus.publish({ type: "codegraph.updated", projectId, status: "indexing" });

    // Fire-and-forget: the route does not await the scan.
    void this.run(projectId, root, indexer);
    return meta;
  }

  /** Current graph for a project (live status wins over the on-disk sidecar). */
  async getGraph(projectId: string): Promise<CodeGraphData> {
    const project = this.projects.get(projectId);
    if (!project) throw new NotFoundError(`Project "${projectId}" not found`);
    const root = project.root?.trim() ?? "";

    if (this.running.has(projectId)) {
      return {
        meta: this.indexingMeta(projectId, root, this.indexerFor(projectId)),
        nodes: [],
        edges: [],
      };
    }

    const meta = await this.readMeta(projectId);
    if (!meta) {
      return { meta: this.emptyMeta(projectId, root), nodes: [], edges: [] };
    }
    // A stale "indexing" sidecar with no live job means the server died mid-scan.
    if (meta.status === "indexing") {
      return {
        meta: { ...meta, status: "failed", error: "Indexing was interrupted — regenerate to retry" },
        nodes: [],
        edges: [],
      };
    }
    if (meta.status !== "ready") return { meta, nodes: [], edges: [] };

    const graph = await this.readGraph(projectId);
    return { meta, nodes: graph?.nodes ?? [], edges: graph?.edges ?? [] };
  }

  /**
   * Cheap, read-only capability check used to surface an optional agent hint.
   * It reads only the metadata sidecar: no graph generation, graph loading, or
   * Graphify query is performed.
   */
  async hasReadyGraphify(projectId: string): Promise<boolean> {
    if (!this.projects.get(projectId)) return false;
    if (this.indexerFor(projectId) !== "graphify" || this.running.has(projectId)) return false;
    const meta = await this.readMeta(projectId);
    return meta?.status === "ready" && meta.indexer === "graphify";
  }

  /**
   * Run a graphify subcommand (query/affected/path/explain/…) against a project's
   * graphify graph.json and return its stdout. Requires the project to have been
   * generated with the graphify indexer. Exported to the MCP layer.
   */
  async runGraphifyText(projectId: string, args: string[]): Promise<string> {
    const dir = this.projectDir(projectId);
    const graphPath = path.join(dir, "graphify-out", "graph.json");
    try {
      await fs.access(graphPath);
    } catch {
      throw new ValidationError(
        `No graphify graph for "${projectId}". Set its indexer to "graphify" and regenerate first.`,
      );
    }
    const quoted = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
    const cmd = `${this.graphifyCommand} ${quoted} --graph "${graphPath}"`;
    return new Promise<string>((resolve, reject) => {
      let out = "";
      let err = "";
      const child = spawn(cmd, { cwd: dir, shell: true });
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.stderr?.on("data", (d) => (err += d.toString()));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `graphify exited with code ${code}`)),
      );
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private emptyMeta(projectId: string, root: string): CodeGraphMeta {
    return { projectId, root, status: "empty", nodeCount: 0, edgeCount: 0, fileCount: 0, languages: [] };
  }

  private indexingMeta(projectId: string, root: string, indexer: CodeGraphIndexer): CodeGraphMeta {
    return {
      projectId,
      root,
      status: "indexing",
      nodeCount: 0,
      edgeCount: 0,
      fileCount: 0,
      languages: [],
      indexer: this.indexerName(indexer),
    };
  }

  private async run(projectId: string, root: string, indexer: CodeGraphIndexer): Promise<void> {
    const started = Date.now();
    try {
      const result =
        indexer === "graphify"
          ? await this.runGraphifyIndexer(projectId, root)
          : await this.runBuiltIn(root);

      const meta = this.readyMeta(projectId, root, result, Date.now() - started, indexer);
      await this.writeGraph(projectId, { nodes: result.nodes, edges: result.edges });
      await this.writeMeta(projectId, meta);
      this.running.delete(projectId);
      this.bus.publish({ type: "codegraph.updated", projectId, status: "ready" });
    } catch (err) {
      const meta: CodeGraphMeta = {
        ...this.emptyMeta(projectId, root),
        status: "failed",
        durationMs: Date.now() - started,
        indexer: this.indexerName(indexer),
        error: (err as Error)?.message ?? "Indexing failed",
      };
      await this.writeMeta(projectId, meta).catch(() => {});
      this.running.delete(projectId);
      this.bus.publish({ type: "codegraph.updated", projectId, status: "failed" });
    }
  }

  private readyMeta(
    projectId: string,
    root: string,
    result: IndexResult,
    durationMs: number,
    indexer: CodeGraphIndexer,
  ): CodeGraphMeta {
    const nodeKinds: Partial<Record<CodeGraphNodeKind, number>> = {};
    for (const n of result.nodes) nodeKinds[n.kind] = (nodeKinds[n.kind] ?? 0) + 1;
    const relations: Partial<Record<CodeGraphRelation, number>> = {};
    for (const e of result.edges) relations[e.relation] = (relations[e.relation] ?? 0) + 1;
    return {
      projectId,
      root,
      status: "ready",
      generatedAt: new Date().toISOString(),
      nodeCount: result.nodes.length,
      edgeCount: result.edges.length,
      fileCount: nodeKinds.file ?? 0,
      languages: result.languages,
      nodeKinds,
      relations,
      durationMs,
      truncated: result.truncated,
      indexer: this.indexerName(indexer),
    };
  }

  private async runBuiltIn(root: string): Promise<IndexResult> {
    const scan = await scanCodeGraph(root);
    return { nodes: scan.nodes, edges: scan.edges, languages: scan.languages, truncated: scan.truncated };
  }

  private async runGraphifyIndexer(projectId: string, root: string): Promise<IndexResult> {
    const dir = this.projectDir(projectId);
    const result = await runGraphify(root, dir, this.graphifyCommand);
    return { ...result, truncated: false };
  }

  private async writeGraph(projectId: string, graph: GraphFile): Promise<void> {
    const dir = this.projectDir(projectId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "code-graph.json"), `${JSON.stringify(graph)}\n`, "utf8");
  }

  private async readGraph(projectId: string): Promise<GraphFile | null> {
    try {
      const raw = await fs.readFile(path.join(this.projectDir(projectId), "code-graph.json"), "utf8");
      const parsed = JSON.parse(raw) as GraphFile;
      if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeMeta(projectId: string, meta: CodeGraphMeta): Promise<void> {
    const dir = this.projectDir(projectId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }

  private async readMeta(projectId: string): Promise<CodeGraphMeta | null> {
    try {
      const raw = await fs.readFile(path.join(this.projectDir(projectId), "meta.json"), "utf8");
      return JSON.parse(raw) as CodeGraphMeta;
    } catch {
      return null;
    }
  }
}
