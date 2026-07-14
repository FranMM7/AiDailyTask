import { useMemo } from "react";
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
import type { BoardConfig, GraphData, GraphEdge, GraphNode } from "@AiDailyTasks/shared";
import { useConfig, useGraph } from "@/api/hooks";
import { statusColor } from "@/lib/colors";
import { useTaskDrawer } from "@/lib/navigation";

const NODE_W = 200;
const NODE_H = 72;

interface CardData {
  node: GraphNode;
  color: string;
}

function TaskNode({ data }: NodeProps<CardData>) {
  const { node, color } = data;
  return (
    <div
      className="rounded-lg border bg-white p-2 text-left shadow-sm dark:bg-slate-900"
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
      return {
        animated: false,
        style: { stroke: "#94a3b8", strokeDasharray: "5 5" },
      };
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
): { nodes: Node<CardData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 70, marginx: 20, marginy: 20 });

  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of graph.edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  const nodes: Node<CardData>[] = graph.nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      type: "task",
      position: { x: (pos?.x ?? 0) - NODE_W / 2, y: (pos?.y ?? 0) - NODE_H / 2 },
      data: { node: n, color: statusColor(config, n.status) },
    };
  });

  const edges: Edge[] = graph.edges.map((e, i) => ({
    id: `${e.type}-${e.source}-${e.target}-${i}`,
    source: e.source,
    target: e.target,
    type: "default",
    ...edgeStyle(e.type),
  }));

  return { nodes, edges };
}

export function GraphView() {
  const [params] = useSearchParams();
  const project = params.get("project") ?? undefined;
  const { data: config } = useConfig();
  const { data, isLoading, isError } = useGraph(project);
  const { openTask } = useTaskDrawer();

  const { nodes, edges } = useMemo(
    () => (data ? layout(data.graph, config) : { nodes: [], edges: [] }),
    [data, config],
  );

  if (isLoading) return <div className="p-8 text-center text-sm text-slate-500">Loading graph…</div>;
  if (isError)
    return <div className="p-8 text-center text-sm text-slate-500">Failed to load graph.</div>;
  if (nodes.length === 0)
    return <div className="p-8 text-center text-sm text-slate-500">No tasks to graph.</div>;

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_e, node) => openTask(node.id)}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
