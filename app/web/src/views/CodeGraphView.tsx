import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import ReactFlow, {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  type Edge,
  type Node,
  type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import dagre from "@dagrejs/dagre";
import { Network, Loader2, AlertTriangle, FolderCog } from "lucide-react";
import type {
  CodeGraphData,
  CodeGraphNode,
  CodeGraphNodeKind,
  CodeGraphRelation,
} from "@AiDailyTasks/shared";
import { useConfig, useCodeGraph, useGenerateCodeGraph } from "@/api/hooks";
import { toast } from "@/store/toast";

const NODE_W = 190;
const NODE_H = 46;

// ReactFlow + dagre choke past a few hundred nodes; cap what we render and tell the
// user. The full graph is always available via the MCP tools / full export.
const MAX_RENDER_NODES = 220;
const MAX_RENDER_EDGES = 1500;

/** Colour by node kind — one legend across built-in (files only) and graphify (symbols). */
const KIND_COLOR: Record<CodeGraphNodeKind, string> = {
  file: "#3b82f6",
  namespace: "#a855f7",
  class: "#f97316",
  function: "#22c55e",
  method: "#14b8a6",
  module: "#06b6d4",
  external: "#94a3b8",
  other: "#64748b",
};

const RELATION_COLOR: Record<CodeGraphRelation, string> = {
  imports: "#3b82f6",
  imports_from: "#3b82f6",
  calls: "#22c55e",
  contains: "#cbd5e1",
  method: "#14b8a6",
  references: "#94a3b8",
};

interface CardData {
  node: CodeGraphNode;
  color: string;
}

function GraphNodeCard({ data }: NodeProps<CardData>) {
  const { node, color } = data;
  const dim = node.kind === "external";
  return (
    <div
      className="rounded-md border bg-white px-2 py-1 text-left shadow-sm dark:bg-slate-900"
      style={{ width: NODE_W, borderLeftWidth: 4, borderLeftColor: color, opacity: dim ? 0.6 : 1 }}
      title={node.file ? `${node.file}${node.line ? `:${node.line}` : ""}` : node.label}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="truncate text-xs font-medium">{node.label}</div>
      <div className="flex items-center justify-between text-[10px] text-slate-400">
        <span className="truncate" style={{ color }}>{node.kind}</span>
        <span className="ml-1 shrink-0" title="dependents · dependencies">
          ↓{node.inDegree} ↑{node.outDegree}
        </span>
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { cg: GraphNodeCard };

function layout(nodes: CodeGraphNode[], edges: CodeGraphData["edges"]): { nodes: Node<CardData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 20, ranksep: 90, marginx: 20, marginy: 20 });

  const present = new Set(nodes.map((n) => n.id));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  const shownEdges = edges.filter((e) => present.has(e.source) && present.has(e.target));
  for (const e of shownEdges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  const rfNodes: Node<CardData>[] = nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      type: "cg",
      position: { x: (pos?.x ?? 0) - NODE_W / 2, y: (pos?.y ?? 0) - NODE_H / 2 },
      data: { node: n, color: KIND_COLOR[n.kind] ?? KIND_COLOR.other },
    };
  });

  const rfEdges: Edge[] = shownEdges.map((e, i) => {
    const color = RELATION_COLOR[e.relation] ?? "#94a3b8";
    return {
      id: `${e.source}->${e.target}-${i}`,
      source: e.source,
      target: e.target,
      type: "default",
      style: { stroke: color, strokeWidth: 1, strokeDasharray: e.relation === "contains" ? "4 4" : undefined },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
    };
  });

  return { nodes: rfNodes, edges: rfEdges };
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      {children}
    </div>
  );
}

export function CodeGraphView() {
  const [params] = useSearchParams();
  const project = params.get("project") ?? undefined;
  const { data: config } = useConfig();
  const projectDef = config?.projects.find((p) => p.id === project);
  const [filesOnly, setFilesOnly] = useState(false);

  const { data, isLoading, isError, refetch } = useCodeGraph(
    project && project !== "All" ? project : undefined,
  );
  const generate = useGenerateCodeGraph();

  const view = useMemo(() => {
    if (!data || data.meta.status !== "ready")
      return { nodes: [], edges: [], hiddenNodes: 0, hiddenEdges: 0 };
    let ns = filesOnly ? data.nodes.filter((n) => n.kind === "file") : data.nodes;
    const total = ns.length;
    // Keep the most-connected nodes when the graph is too big to render.
    if (ns.length > MAX_RENDER_NODES) {
      ns = [...ns]
        .sort((a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree))
        .slice(0, MAX_RENDER_NODES);
    }
    const ids = new Set(ns.map((n) => n.id));
    let es = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    const totalEdges = es.length;
    if (es.length > MAX_RENDER_EDGES) es = es.slice(0, MAX_RENDER_EDGES);
    return {
      nodes: ns,
      edges: es,
      hiddenNodes: total - ns.length,
      hiddenEdges: totalEdges - es.length,
    };
  }, [data, filesOnly]);

  const { nodes, edges } = useMemo(() => layout(view.nodes, view.edges), [view]);

  const runGenerate = () => {
    if (!project) return;
    generate.mutate(project, {
      onSuccess: () => toast("Graph generation started — this may take a while.", "success"),
    });
  };

  if (!project || project === "All")
    return (
      <Centered>
        <Network size={28} className="text-slate-400" />
        <p className="text-sm text-slate-500">
          Pick a project from the top-bar selector to view its code graph.
        </p>
      </Centered>
    );

  if (projectDef && !projectDef.root)
    return (
      <Centered>
        <FolderCog size={28} className="text-slate-400" />
        <p className="text-sm font-medium">No source path set for {projectDef.label}</p>
        <p className="max-w-md text-xs text-slate-500">
          Open <strong>Manage projects</strong> (top bar) and set this project's source path, then
          generate its code graph.
        </p>
      </Centered>
    );

  if (isError)
    return (
      <Centered>
        <AlertTriangle size={28} className="text-red-500" />
        <p className="text-sm font-medium">Couldn't load the code graph</p>
        <button type="button" onClick={() => void refetch()} className="text-xs text-blue-500 underline">
          Retry
        </button>
      </Centered>
    );

  if (isLoading || !data)
    return <Centered><p className="text-sm text-slate-500">Loading…</p></Centered>;

  const { meta } = data;

  if (meta.status === "indexing")
    return (
      <Centered>
        <Loader2 size={28} className="animate-spin text-amber-500" />
        <p className="text-sm font-medium">Indexing {projectDef?.label ?? project}…</p>
        <p className="text-xs text-slate-500">
          Building the code graph — this may take a while. It updates here automatically.
        </p>
      </Centered>
    );

  if (meta.status === "empty")
    return (
      <Centered>
        <Network size={28} className="text-slate-400" />
        <p className="text-sm font-medium">No code graph yet for {projectDef?.label ?? project}</p>
        <p className="max-w-md text-xs text-slate-500">
          Generate a dependency map of the source tree. Large codebases may take a while; you can
          keep working while it runs.
        </p>
        <button
          type="button"
          onClick={runGenerate}
          disabled={generate.isPending}
          className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Network size={15} />
          Generate graph
        </button>
      </Centered>
    );

  if (meta.status === "failed")
    return (
      <Centered>
        <AlertTriangle size={28} className="text-red-500" />
        <p className="text-sm font-medium">Graph generation failed</p>
        <p className="max-w-md text-xs text-slate-500">{meta.error ?? "Unknown error."}</p>
        <button
          type="button"
          onClick={runGenerate}
          disabled={generate.isPending}
          className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Network size={15} />
          Retry
        </button>
      </Centered>
    );

  if (nodes.length === 0)
    return (
      <Centered>
        <p className="text-sm text-slate-500">
          {filesOnly ? "No file nodes to show." : "The graph is empty."}
        </p>
        <button
          type="button"
          onClick={() => setFilesOnly(false)}
          className="text-xs text-blue-500 underline"
        >
          Show everything
        </button>
      </Centered>
    );

  const kinds = meta.nodeKinds ?? {};
  const kindsPresent = (Object.keys(kinds) as CodeGraphNodeKind[]).filter((k) => (kinds[k] ?? 0) > 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 px-4 py-2 text-xs text-slate-500 dark:border-slate-800">
        <span className="font-medium text-slate-700 dark:text-slate-200">
          {projectDef?.label ?? project}
        </span>
        <span>{meta.nodeCount} nodes</span>
        <span>·</span>
        <span>{meta.edgeCount} edges</span>
        <span>·</span>
        <span>{meta.fileCount} files</span>
        {meta.indexer && <span className="rounded bg-slate-100 px-1 dark:bg-slate-800">{meta.indexer}</span>}
        {meta.truncated && <span className="text-amber-500">· truncated</span>}
        {(view.hiddenNodes > 0 || view.hiddenEdges > 0) && (
          <span className="text-amber-500">
            · showing {view.nodes.length} most-connected of {meta.nodeCount} nodes
            {view.hiddenEdges > 0 ? ` (${view.edges.length}/${meta.edgeCount} edges)` : ""} — narrow with
            Files only, or query via MCP
          </span>
        )}

        {/* kind legend */}
        <span className="ml-2 flex flex-wrap items-center gap-2">
          {kindsPresent.map((k) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: KIND_COLOR[k] }} />
              {k} {kinds[k]}
            </span>
          ))}
        </span>

        <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={filesOnly} onChange={(e) => setFilesOnly(e.target.checked)} />
          Files only
        </label>
        <button
          type="button"
          onClick={runGenerate}
          disabled={generate.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <Network size={13} />
          Regenerate
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.05}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
