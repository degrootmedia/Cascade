import { describe, it, expect } from "vitest";
import { mergeGraphLayoutPatch, tidyGraphLayout } from "../src/shared/graph/layout.js";
import type { GraphLayout } from "../src/shared/ipc.js";

const SIZES = {
  "ref:a": { width: 200, height: 100 },
  composer: { width: 300, height: 200 },
  imagegen: { width: 300, height: 200 },
  output: { width: 300, height: 150 },
  videogen: { width: 300, height: 200 },
};

const GRAPH = {
  nodes: [{ id: "output" }, { id: "imagegen" }, { id: "composer" }, { id: "ref:a" }, { id: "videogen" }],
  edges: [
    { from: { node: "ref:a" }, to: { node: "composer" } },
    { from: { node: "composer" }, to: { node: "imagegen" } },
    { from: { node: "imagegen" }, to: { node: "output" } },
    { from: { node: "imagegen" }, to: { node: "videogen" } },
  ],
};

function overlaps(pos: Record<string, { x: number; y: number }>): boolean {
  const ids = Object.keys(pos);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = { ...pos[ids[i]], ...(SIZES[ids[i] as keyof typeof SIZES] ?? { width: 300, height: 200 }) };
      const b = { ...pos[ids[j]], ...(SIZES[ids[j] as keyof typeof SIZES] ?? { width: 300, height: 200 }) };
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) return true;
    }
  }
  return false;
}

describe("tidyGraphLayout", () => {
  it("is deterministic and overlap-free, with Frame Output rightmost", () => {
    const a = tidyGraphLayout(GRAPH, SIZES);
    const b = tidyGraphLayout(GRAPH, SIZES);
    expect(a).toEqual(b);
    // Running it on its own output changes nothing (stable).
    expect(tidyGraphLayout(GRAPH, SIZES)).toEqual(a);
    expect(overlaps(a)).toBe(false);
    const maxX = Math.max(...Object.values(a).map((p) => p.x));
    expect(a.output.x).toBe(maxX);
    expect(a["ref:a"].x).toBeLessThan(a.composer.x);
    expect(a.composer.x).toBeLessThan(a.imagegen.x);
    // Every node is placed exactly once.
    expect(Object.keys(a).sort()).toEqual(["composer", "imagegen", "output", "ref:a", "videogen"]);
  });

  it("terminates on cyclic graphs", () => {
    const cyclic = {
      nodes: [{ id: "a" }, { id: "b" }, { id: "output" }],
      edges: [
        { from: { node: "a" }, to: { node: "b" } },
        { from: { node: "b" }, to: { node: "a" } },
        { from: { node: "b" }, to: { node: "output" } },
      ],
    };
    const pos = tidyGraphLayout(cyclic, {});
    expect(Object.keys(pos)).toHaveLength(3);
    expect(pos.output.x).toBeGreaterThanOrEqual(pos.b.x);
  });
});

describe("mergeGraphLayoutPatch waypoints", () => {
  const fresh: GraphLayout = {
    positions: { a: { x: 0, y: 0 } },
    waypoints: { "e-1": [{ x: 1, y: 2 }], "e-2": [{ x: 3, y: 4 }] },
  };

  it("folds per edge, replaces lists, and deletes on an explicit empty list", () => {
    const next = mergeGraphLayoutPatch(fresh, {
      waypoints: { "e-1": [{ x: 9, y: 9 }, { x: 10, y: 10 }], "e-2": [], "e-3": [{ x: 5, y: 5 }] },
    });
    expect(next.waypoints).toEqual({ "e-1": [{ x: 9, y: 9 }, { x: 10, y: 10 }], "e-3": [{ x: 5, y: 5 }] });
    // Other sections are untouched by a waypoints-only patch.
    expect(next.positions).toEqual({ a: { x: 0, y: 0 } });
  });

  it("an absent waypoints section leaves fresh waypoints untouched", () => {
    const next = mergeGraphLayoutPatch(fresh, { positions: { b: { x: 1, y: 1 } } });
    expect(next.waypoints).toEqual(fresh.waypoints);
  });
});
