/**
 * Build a dependency/relationship graph from a set of frontmatters.
 * Edges: depends_on (self -> dep), blocks (self -> blocked), parent (child -> parent),
 * relates_to (undirected, reciprocal dedupe). Edge targets outside the node set are dropped.
 */
import {
  type Frontmatter,
  type GraphData,
  type GraphNode,
  type GraphEdge,
  normalizeId,
} from "@AiDailyTasks/shared";

export function buildGraph(frontmatters: Frontmatter[]): GraphData {
  const nodes: GraphNode[] = frontmatters.map((fm) => ({
    id: normalizeId(fm.id),
    title: fm.title,
    status: fm.status,
    category: fm.category,
    severity: fm.severity,
    project: fm.project,
    parent: fm.parent ? normalizeId(fm.parent) : null,
    umbrella: fm.children.length > 0,
  }));

  const known = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  const add = (source: string, target: string, type: GraphEdge["type"]): void => {
    if (!known.has(source) || !known.has(target) || source === target) return;
    const key =
      type === "relates_to"
        ? `relates_to:${[source, target].sort().join("|")}` // dedupe reciprocal
        : `${type}:${source}->${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source, target, type });
  };

  for (const fm of frontmatters) {
    const self = normalizeId(fm.id);
    for (const dep of fm.depends_on) add(self, normalizeId(dep), "depends_on");
    for (const b of fm.blocks) add(self, normalizeId(b), "blocks");
    for (const r of fm.relates_to) add(self, normalizeId(r), "relates_to");
    if (fm.parent) add(self, normalizeId(fm.parent), "parent");
  }

  return { nodes, edges };
}
