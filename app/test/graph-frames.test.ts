import { describe, it, expect } from "vitest";
import { groupIntoFrame, frameSockets, translateFrame, settleMembership, deactivatedNodes, deactivatedEdgeIds, generationBlocked, nextFrameName, socketLabel } from "../src/shared/graph/frames.js";
import { mergeGraphLayoutPatch } from "../src/shared/graph/layout.js";
import { wirePath } from "../src/renderer/src/components/graph/WaypointEdge.js";

const boxes = [{ x: 0, y: 0, width: 100, height: 50 }, { x: 200, y: 0, width: 100, height: 50 }];
const edges = [
  { id: "e1", source: "ext", target: "a", targetHandle: "in" },
  { id: "e2", source: "a", target: "b" },
  { id: "e3", source: "b", sourceHandle: "out", target: "ext2" },
];

describe("frames", () => {
  it("groups, names, and lists labeled boundary sockets in stable order", () => {
    const frames = groupIntoFrame(undefined, ["a", "b"], boxes, "f1");
    expect(frames.f1.name).toBe("Frame 1");
    expect(nextFrameName(frames)).toBe("Frame 2");
    const s = frameSockets(frames.f1, edges);
    expect(s.inputs.map((x) => x.edgeId)).toEqual(["e1"]);
    expect(s.outputs.map((x) => x.label)).toEqual(["b Output"]);
  });
  it("moves as a unit and settles membership by drop", () => {
    const f = groupIntoFrame(undefined, ["a", "b"], boxes, "f1").f1;
    const t = translateFrame(f, { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } }, 10, 5);
    expect(t.positions.b).toEqual({ x: 210, y: 5 });
    const out = settleMembership({ f1: f }, "a", { x: 9999, y: 9999 });
    expect(out.f1.members).toEqual(["b"]);
    expect(settleMembership(out, "a", { x: f.x + 5, y: f.y + 5 }).f1.members).toContain("a");
  });
  it("deactivation marks nodes and boundary wires and blocks generation", () => {
    const f = { ...groupIntoFrame(undefined, ["imagegen", "b"], boxes, "f1").f1, deactivated: true };
    const layout = { frames: { f1: f } };
    expect([...deactivatedNodes(layout)]).toEqual(["imagegen", "b"]);
    expect(deactivatedEdgeIds(layout, edges).has("e3")).toBe(true);
    expect(generationBlocked(layout, "production:generateFrameNode")).toBe(true);
    expect(generationBlocked({ frames: { f1: { ...f, deactivated: false } } }, "production:generateFrameNode")).toBe(false);
  });
  it("persists frames and wire style through the layout merge; ungroup deletes", () => {
    const f = groupIntoFrame(undefined, ["a"], boxes, "f1").f1;
    let l = mergeGraphLayoutPatch(undefined, { frames: { f1: f }, wireStyle: "straight" });
    expect(l.frames!.f1.name).toBe("Frame 1");
    expect(l.wireStyle).toBe("straight");
    l = mergeGraphLayoutPatch(l, { frames: { f1: null }, wireStyle: "curved" });
    expect(l.frames).toBeUndefined();
    expect(l.wireStyle).toBeUndefined(); // absent = curved (older projects)
  });
});

describe("socket names", () => {
  it("names sockets by what they are", () => {
    expect(socketLabel("editprompt:edit0", "in", "in-ref-2")).toBe("Edit Prompt #1 Ref");
    expect(socketLabel("editgen:edit0", "in", "in-image")).toBe("Edit Image #1 Source");
  });
});

describe("wire style", () => {
  const pts = [{ x: 0, y: 0 }, { x: 50, y: 40 }, { x: 100, y: 0 }];
  it("straight uses line corners at reroute points; curved uses Bezier", () => {
    expect(wirePath(pts, "straight")).toBe("M0,0 L50,40 L100,0");
    expect(wirePath(pts)).toContain("C");
    expect(wirePath(pts)).toContain("50,40");
  });
});
