import { describe, it, expect } from "vitest";
import { waypointInsertIndex } from "../src/renderer/src/components/graph/WaypointEdge.js";
import { graphEdgesToFlow } from "../src/renderer/src/components/graphFlow.js";
import { materializeGraph } from "../src/shared/graph/materialize.js";
import type { Graph } from "../src/shared/ipc.js";

describe("waypointInsertIndex", () => {
  it("inserts on the nearest segment, keeping polyline order", () => {
    const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    expect(waypointInsertIndex(line, { x: 30, y: 5 })).toBe(0);
    const bent = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 100 }, { x: 100, y: 100 }];
    // Near the second (vertical) segment → waypoint index 1.
    expect(waypointInsertIndex(bent, { x: 55, y: 50 })).toBe(1);
    // Near the last segment → appended at the end of the waypoint list.
    expect(waypointInsertIndex(bent, { x: 90, y: 95 })).toBe(2);
  });
});

describe("graphEdgesToFlow waypoints", () => {
  it("renders every edge through the waypoint edge type with its stored points", () => {
    const graph: Graph = materializeGraph(
      {
        id: "s1", number: "0100", audio: "", visual: "", prompt: "Scene @[Gondola]",
      } as never,
      [{ id: "r1", name: "Gondola", artwork: "g.png" }]
    );
    const edgeId = graph.edges[0].id;
    const flow = graphEdgesToFlow(graph, {
      selected: new Set(),
      colors: { ref: "#111", style: "#222", brand: "#333" },
      waypoints: { [edgeId]: [{ x: 10, y: 20 }] },
    });
    const first = flow.find((e) => e.id === edgeId)!;
    expect(first.type).toBe("waypoint");
    expect((first.data as { waypoints: unknown }).waypoints).toEqual([{ x: 10, y: 20 }]);
    // Edges without stored points render straight (empty waypoint list).
    const other = flow.find((e) => e.id !== edgeId);
    if (other) expect((other.data as { waypoints: unknown }).waypoints).toEqual([]);
  });
});
