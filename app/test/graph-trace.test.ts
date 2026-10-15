import { describe, it, expect } from "vitest";
import { traceChain } from "../src/shared/graph/trace.js";
import type { Graph } from "../src/shared/ipc.js";

function graph(edges: Array<[string, string, string]>): Graph {
  return {
    version: 1,
    nodes: [],
    edges: edges.map(([id, from, to]) => ({ id, from: { node: from, port: "out" }, to: { node: to, port: "in" } })),
  } as unknown as Graph;
}

describe("traceChain", () => {
  const g = graph([
    ["e1", "composer", "imagegen"],
    ["e2", "imagegen", "videogen"],
    ["e3", "videogen", "output"],
    ["e4", "style", "composer"],
    ["e5", "imagegen", "cameraGrid"],
  ]);

  it("includes transitive ancestors and descendants plus in-chain edges", () => {
    const chain = traceChain(g, "imagegen");
    expect([...chain.nodes].sort()).toEqual(["cameraGrid", "composer", "imagegen", "output", "style", "videogen"]);
    expect([...chain.edges].sort()).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });

  it("excludes sibling branches that do not touch the hovered node", () => {
    const chain = traceChain(g, "cameraGrid");
    expect(chain.nodes.has("videogen")).toBe(false);
    expect(chain.edges.has("e2")).toBe(false);
    expect(chain.nodes.has("composer")).toBe(true); // upstream through imagegen
  });

  it("is cycle-safe", () => {
    const cyc = graph([["a", "x", "y"], ["b", "y", "x"], ["c", "y", "z"]]);
    const chain = traceChain(cyc, "x");
    expect([...chain.nodes].sort()).toEqual(["x", "y", "z"]);
  });
});
