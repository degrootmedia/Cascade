/**
 * The "trace this path" helper (node-view F5): for a hovered node, the full
 * upstream producers and downstream consumers (transitively), so the view
 * can highlight that chain and dim everything else. Pure and cycle-safe —
 * the canonical graph should be acyclic, but a malformed stored graph must
 * never hang a hover.
 */
import type { Graph } from "../ipc.js";

export interface TraceChain {
  /** Hovered node + every transitive ancestor and descendant. */
  nodes: ReadonlySet<string>;
  /** Stored edges entirely inside the traced node set. */
  edges: ReadonlySet<string>;
}

export function traceChain(graph: Graph, nodeId: string): TraceChain {
  const upstream = new Map<string, string[]>();
  const downstream = new Map<string, string[]>();
  for (const e of graph.edges) {
    const from = e.from.node;
    const to = e.to.node;
    downstream.set(from, [...(downstream.get(from) ?? []), to]);
    upstream.set(to, [...(upstream.get(to) ?? []), from]);
  }
  const nodes = new Set<string>([nodeId]);
  const walk = (map: Map<string, string[]>, start: string) => {
    // Expansion is tracked per walk: a node already collected by the other
    // direction still needs expanding here (and cycles must terminate).
    const expanded = new Set<string>([start]);
    const stack = [start];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const next of map.get(cur) ?? []) {
        nodes.add(next);
        if (expanded.has(next)) continue;
        expanded.add(next);
        stack.push(next);
      }
    }
  };
  walk(upstream, nodeId);
  walk(downstream, nodeId);
  const edges = new Set<string>();
  for (const e of graph.edges) {
    if (nodes.has(e.from.node) && nodes.has(e.to.node)) edges.add(e.id);
  }
  return { nodes, edges };
}
