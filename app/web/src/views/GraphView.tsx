import { useEffect, useMemo, useRef } from "react";
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
import { Eye, EyeOff, Focus, MousePointer2, X } from "lucide-react";
import type { BoardConfig, GraphData, GraphEdge, GraphNode } from "@AiDailyTasks/shared";
import { useConfig, useGraph } from "@/api/hooks";
import { statusColor } from "@/lib/colors";
import { useTaskDrawer } from "@/lib/navigation";
import { filterTaskGraph } from "@/lib/taskGraph";

const NODE_W = 200;
const NODE_H = 72;

interface CardData {
  node: GraphNode;
  color: string;
  focused: boolean;
}

function TaskNode({ data }: NodeProps<CardData>) {
  const { node, color, focused } = data;
  return (
    <div
      className={`rounded-lg border bg-white p-2 text-left shadow-sm dark:bg-slate-900 ${
        focused ? "ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-slate-950" : ""
      }`}
      style={{ width: NODE_W, borderLeftWidth: 4, borderLeftColor: color }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-slate-500">{node.id}</span>
        {node.umbrella && (
          <span className="rounded bg-slate-200 px-1 text-[10px] text-slate-600 dark:bg-slate-700 dark:text-slate-300">
            umbrella
          </span>
        )}
      </div>
      <div className="mt-0.5 line-clamp-2 text-xs font-medium">{node.title}</div>
      <div className="mt-1 flex items-center gap-1 text-[10px] text-slate-400">
        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        {node.status}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

function edgeStyle(type: GraphEdge["type"]): Partial<Edge> {
  switch (type) {
    case "relates_to":
      return { style: { stroke: "#94a3b8", strokeDasharray: "5 5" } };
    case "parent":
      return {
        style: { stroke: "#a855f7", strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#a855f7" },
      };
    case "blocks":
      return {
        style: { stroke: "#ef4444", strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#ef4444" },
      };
    case "depends_on":
    default:
      return {
        style: { stroke: "#3b82f6", strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#3b82f6" },
      };
  }
}

function layout(
  graph: GraphData,
  config: BoardConfig | undefined,
  focusId: string | null,
): { nodes: Node<CardData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 70, marginx: 20, marginy: 20 });

  for (const node of graph.nodes) g.setNode(node.id, { width: NODE_W, height: NODE_H });
  for (const edge of graph.edges) {
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) g.setEdge(edge.source, edge.target);
  }
  dagre.layout(g);

  const nodes: Node<CardData>[] = graph.nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      id: node.id,
      type: "task",
      position: { x: (pos?.x ?? 0) - NODE_W / 2, y: (pos?.y ?? 0) - NODE_H / 2 },
      data: {
        node,
        color: statusColor(config, node.status),
        focused: node.id === focusId,
      },
    };
  });

  const edges: Edge[] = graph.edges.map((edge, index) => ({
    id: `${edge.type}-${edge.source}-${edge.target}-${index}`,
    source: edge.source,
    target: edge.target,
    type: "default",
    ...edgeStyle(edge.type),
  }));
  return { nodes, edges };
}

export function GraphView() {
  const [params, setParams] = useSearchParams();
  const project = params.get("project") ?? undefined;
  const statuses = params.getAll("status");
  const showIndependent = params.get("independent") !== "hide";
  const focusId = params.get("focus");
  const { data: config } = useConfig();
  const { data, isLoading, isError } = useGraph(project);
  const { openTask } = useTaskDrawer();
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
    },
    [],
  );

  const graph = useMemo(
    () =>
      data
        ? filterTaskGraph(data.graph, {
            statuses: params.getAll("status"),
            showIndependent,
            focusId,
          })
        : { nodes: [], edges: [] },
    [data, focusId, params, showIndependent],
  );
  const { nodes, edges } = useMemo(
    () => layout(graph, config, focusId),
    [config, focusId, graph],
  );

  const updateParam = (key: string, value?: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  if (isLoading) return <div className="p-8 text-center text-sm text-slate-500">Loading graph…</div>;
  if (isError)
    return <div className="p-8 text-center text-sm text-slate-500">Failed to load graph.</div>;

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-950">
        <span className="font-medium text-slate-700 dark:text-slate-200">
          {nodes.length} of {data?.graph.nodes.length ?? 0} tasks
        </span>
        {statuses.length > 0 && (
          <span className="rounded-full bg-blue-50 px-2 py-1 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            {statuses.length} status {statuses.length === 1 ? "filter" : "filters"} active
          </span>
        )}
        {focusId && (
          <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-1 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
            <Focus size={12} /> Focused on {focusId}
          </span>
        )}
        <span className="hidden items-center gap-1 text-slate-400 lg:inline-flex">
          <MousePointer2 size={12} /> Click to focus · double-click for details
        </span>

        <div className="ml-auto flex items-center gap-2">
          {focusId && (
            <button
              type="button"
              onClick={() => updateParam("focus")}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <X size={13} /> Clear focus
            </button>
          )}
          <button
            type="button"
            aria-pressed={!showIndependent}
            onClick={() => updateParam("independent", showIndependent ? "hide" : undefined)}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 transition ${
              showIndependent
                ? "border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                : "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
            }`}
          >
            {showIndependent ? <Eye size={13} /> : <EyeOff size={13} />}
            {showIndependent ? "Hide independent" : "Independent hidden"}
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {nodes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-slate-500">
            <p>
              {data?.graph.nodes.length
                ? "No tasks match the current graph filters."
                : "No tasks to graph."}
            </p>
            {(statuses.length > 0 || focusId || !showIndependent) && (
              <button
                type="button"
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.delete("status");
                  next.delete("focus");
                  next.delete("independent");
                  setParams(next, { replace: true });
                }}
                className="text-xs font-medium text-blue-600 underline dark:text-blue-400"
              >
                Reset graph filters
              </button>
            )}
          </div>
        ) : (
          <ReactFlow
            key={`${statuses.join(",")}:${showIndependent}:${focusId ?? "all"}`}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.2}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_event, node) => {
              if (clickTimer.current) clearTimeout(clickTimer.current);
              clickTimer.current = setTimeout(() => updateParam("focus", node.id), 220);
            }}
            onNodeDoubleClick={(_event, node) => {
              if (clickTimer.current) clearTimeout(clickTimer.current);
              clickTimer.current = null;
              openTask(node.id);
            }}
          >
            <Background />
            <Controls />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}
