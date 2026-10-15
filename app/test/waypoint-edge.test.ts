import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ReactFlowProvider, Position } from "@xyflow/react";
import { waypointInsertIndex, WaypointContext, WaypointEdge, type WaypointHandlers } from "../src/renderer/src/components/graph/WaypointEdge.js";
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

/**
 * Waypoint selection (the canvas's Delete-key target). The modal-level path
 * can't be exercised under jsdom — ReactFlow never renders edges without
 * measured handles — so the selectable surface is covered at the component
 * seam: pointerdown selects, the selected dot is marked, and the legacy
 * double-click delete still fires.
 */
describe("WaypointEdge selection", () => {
  it("pointerdown on a dot selects it; selected renders marked; double-click removes", async () => {
    const calls: string[] = [];
    const handlers: WaypointHandlers = {
      add: () => {},
      move: () => {},
      remove: (edgeId, index) => calls.push(`remove:${edgeId}:${index}`),
      select: (edgeId, index) => calls.push(`select:${edgeId}:${index}`),
      selected: null,
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const tree = (h: WaypointHandlers) =>
      createElement(ReactFlowProvider, null,
        createElement(WaypointContext.Provider, { value: h },
          createElement("svg", null,
            createElement(WaypointEdge, {
              id: "e1",
              sourceX: 0, sourceY: 0, targetX: 200, targetY: 0,
              sourcePosition: Position.Right, targetPosition: Position.Left,
              data: { waypoints: [{ x: 100, y: 40 }] },
            } as never))));
    act(() => { root.render(tree(handlers)); });
    const dot = host.querySelector(".prod-waypoint-dot");
    expect(dot, "waypoint dot rendered").toBeTruthy();
    expect(dot!.classList.contains("selected")).toBe(false);
    act(() => {
      dot!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    });
    expect(calls).toContain("select:e1:0");
    act(() => { root.render(tree({ ...handlers, selected: { edgeId: "e1", index: 0 } })); });
    expect(host.querySelector(".prod-waypoint-dot")!.classList.contains("selected")).toBe(true);
    act(() => { host.querySelector(".prod-waypoint-dot")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); });
    expect(calls).toContain("remove:e1:0");
    act(() => { root.unmount(); });
    host.remove();
  });
});
