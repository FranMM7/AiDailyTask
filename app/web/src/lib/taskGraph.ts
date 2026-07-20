import type { GraphData, GraphEdge } from "@AiDailyTasks/shared";

export interface TaskGraphViewOptions {
  statuses?: readonly string[];
  showIndependent?: boolean;
  focusId?: string | null;
}

/**
 * Derive a task graph view without mutating the server response.
 * Focus follows task -> dependency and child -> parent links recursively.
 */
export function filterTaskGraph(
  graph: GraphData,
  { statuses = [], showIndependent = true, focusId = null }: TaskGraphViewOptions,
): GraphData {
  const statusSet = new Set(statuses);
  const degree = new Map(graph.nodes.map((node) => [node.id, 0]));

  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const eligible = new Set(
    graph.nodes
      .filter((node) => statusSet.size === 0 || statusSet.has(node.status))
      .filter((node) => showIndependent || (degree.get(node.id) ?? 0) > 0)
      .map((node) => node.id),
  );

  let visible = eligible;
  if (focusId && eligible.has(focusId)) {
    visible = dependencyAndParentClosure(graph.edges, focusId, eligible);
  } else if (focusId) {
    visible = new Set();
  }

  return {
    nodes: graph.nodes.filter((node) => visible.has(node.id)),
    edges: graph.edges.filter(
      (edge) => visible.has(edge.source) && visible.has(edge.target),
    ),
  };
}

function dependencyAndParentClosure(
  edges: readonly GraphEdge[],
  focusId: string,
  eligible: ReadonlySet<string>,
): Set<string> {
  const requiredBy = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== "depends_on" && edge.type !== "parent") continue;
    const targets = requiredBy.get(edge.source) ?? [];
    targets.push(edge.target);
    requiredBy.set(edge.source, targets);
  }

  const included = new Set<string>();
  const pending = [focusId];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || included.has(current) || !eligible.has(current)) continue;
    included.add(current);
    for (const target of requiredBy.get(current) ?? []) pending.push(target);
  }
  return included;
}
