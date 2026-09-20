/**
 * Graph invariants (master plan step 03): unique node ids, edges that
 * reference declared ports on real nodes, no duplicates or self-loops.
 * Pure — no shot/production I/O. Materialized and migrated graphs pass
 * through here; the renderer treats a normalized graph as renderable.
 */
import type { Graph, GraphEdge, GraphNode } from "../ipc.js";
import { nodeDecl, portDecl } from "./ports.js";

export interface NormalizedGraph {
  graph: Graph;
  /** Human-readable notes for everything dropped or repaired. */
  issues: string[];
}

function edgeKey(e: GraphEdge): string {
  return `${e.from.node}:${e.from.port}>${e.to.node}:${e.to.port}`;
}

/** Enforce graph invariants, dropping what cannot be repaired. Never throws. */
export function normalizeGraph(graph: Graph): NormalizedGraph {
  const issues: string[] = [];
  const seenNodes = new Set<string>();
  const nodes: GraphNode[] = [];
  for (const n of graph.nodes) {
    if (!n || typeof n.id !== "string" || n.id.length === 0) {
      issues.push("dropped a node with a missing id");
      continue;
    }
    if (seenNodes.has(n.id)) {
      issues.push(`dropped duplicate node "${n.id}"`);
      continue;
    }
    seenNodes.add(n.id);
    if (!nodeDecl(n.kind)) {
      issues.push(`kept node "${n.id}" with unknown kind "${n.kind}" (edges to it are still validated)`);
    }
    nodes.push(n);
  }
  const seenEdges = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const e of graph.edges) {
    if (!e || typeof e.id !== "string") {
      issues.push("dropped an edge with a missing id");
      continue;
    }
    const fromNode = nodes.find((n) => n.id === e.from?.node);
    const toNode = nodes.find((n) => n.id === e.to?.node);
    if (!fromNode || !toNode) {
      issues.push(`dropped dangling edge "${e.id}"`);
      continue;
    }
    if (e.from.node === e.to.node) {
      issues.push(`dropped self-loop edge "${e.id}"`);
      continue;
    }
    if (!portDecl(fromNode.kind, "out", e.from.port) || !portDecl(toNode.kind, "in", e.to.port)) {
      issues.push(`dropped edge "${e.id}" touching an undeclared port`);
      continue;
    }
    const key = edgeKey(e);
    if (seenEdges.has(key)) {
      issues.push(`dropped duplicate edge "${e.id}"`);
      continue;
    }
    seenEdges.add(key);
    edges.push(e);
  }
  return { graph: { version: 1, nodes, edges, migrated: graph.migrated }, issues };
}
