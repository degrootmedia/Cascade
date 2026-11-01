import { describe, it, expect } from "vitest";
import { planReroutes, moveReroute, removeReroute, polylineCrossing } from "../src/shared/graph/reroute.js";
import { mergeGraphLayoutPatch } from "../src/shared/graph/layout.js";

const ids = () => { let n = 0; return () => `p${++n}`; };

describe("reroute bundling", () => {
  it("bundles wires from one output through one shared point at the average", () => {
    const plan = planReroutes([
      { edgeId: "a", sourceKey: "n1|out", pos: { x: 100, y: 0 }, index: 0 },
      { edgeId: "b", sourceKey: "n1|out", pos: { x: 100, y: 60 }, index: 0 },
      { edgeId: "c", sourceKey: "n1|out", pos: { x: 100, y: 120 }, index: 0 },
    ], {}, ids());
    expect(plan.a[0]).toEqual({ id: "p1", x: 100, y: 60 });
    expect(plan.b[0].id).toBe(plan.a[0].id);
    expect(plan.c[0].id).toBe(plan.a[0].id);
  });
  it("never merges different sources", () => {
    const plan = planReroutes([
      { edgeId: "a", sourceKey: "n1|out", pos: { x: 0, y: 0 }, index: 0 },
      { edgeId: "b", sourceKey: "n2|out", pos: { x: 0, y: 10 }, index: 0 },
    ], {}, ids());
    expect(plan.a[0].id).not.toBe(plan.b[0].id);
  });
  it("drag moves and delete removes the shared point on every wire; undo-able via patch", () => {
    const plan = planReroutes([
      { edgeId: "a", sourceKey: "s", pos: { x: 0, y: 0 }, index: 0 },
      { edgeId: "b", sourceKey: "s", pos: { x: 0, y: 20 }, index: 0 },
    ], {}, ids());
    const moved = moveReroute(plan, "a", 0, { x: 5, y: 5 });
    expect(moved.b[0]).toMatchObject({ x: 5, y: 5 });
    const layout = mergeGraphLayoutPatch(undefined, { waypoints: plan });
    expect(layout.waypoints!.a[0].id).toBeTruthy();
    const gone = mergeGraphLayoutPatch(layout, { waypoints: removeReroute(plan, "b", 0) });
    expect(gone.waypoints).toBeUndefined();
  });
  it("finds a crossing", () => {
    expect(polylineCrossing([{ x: 5, y: -5 }, { x: 5, y: 5 }], [{ x: 0, y: 0 }, { x: 10, y: 0 }])).toEqual({ x: 5, y: 0 });
  });
});
