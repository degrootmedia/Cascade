/**
 * Graph-model coherence suite (master plan step 10 T1).
 *
 * The graph is the wiring authority: these tests fail if prompt-text parsing
 * is ever reintroduced as a decision source. They assert the truth table,
 * normalization invariants, materializer idempotence, render component order,
 * edge-driven reference propagation, and a save/load round-trip.
 */
import { describe, it, expect } from "vitest";
import { canConnect, nodeDecl, type ConnectEndpoint } from "../src/shared/graph/ports.js";
import { normalizeGraph } from "../src/shared/graph/normalize.js";
import { materializeGraph } from "../src/shared/graph/materialize.js";
import { renderShotPrompt, attachedRefIds } from "../src/shared/graph/render.js";
import { applyConnection, connectionToEdge, setBrandEdge, setStyleEdge } from "../src/shared/graph/connect.js";
import type { Graph, GraphMedia, GraphNodeKind, Production, ProductionShot } from "../src/shared/ipc.js";

const REFS = [
  { id: "r1", name: "Gondola", artwork: "g.png" },
  { id: "r2", name: "Marco", media: "video" as const, artwork: "m.png" },
];

const prod = (over: Partial<Production> = {}): Production =>
  ({
    meta: { id: "p1", name: "P", folder: "C:/x", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    currentStep: 3,
    styles: [{ id: "s1", index: 1, name: "Heroic", prompt: "Heroic 3D render" }],
    brand: { colors: ["#aabbcc"], font: "Baskerville" },
    characters: [{ id: "r1", name: "Gondola", key: "g" }],
    products: [],
    references: [{ id: "r2", name: "Marco", media: "video" }],
    ...over,
  }) as unknown as Production;

const shot = (over: Partial<ProductionShot> = {}): ProductionShot =>
  ({ id: "s1", number: "0100", audio: "", visual: "", ...over }) as ProductionShot;

const ep = (kind: GraphNodeKind, media: GraphMedia): ConnectEndpoint => ({ kind, port: "out", media });
const to = (kind: GraphNodeKind, port: string) => ({ kind, port });

describe("canConnect truth table", () => {
  it("image outputs feed image inputs; video outputs feed video inputs", () => {
    expect(canConnect(ep("imagegen", "image"), to("videogen", "in-image"))).toBe(true);
    expect(canConnect(ep("imagegen", "image"), to("editgen", "in-image"))).toBe(true);
    expect(canConnect(ep("imagegen", "image"), to("output", "in-out"))).toBe(true);
    expect(canConnect(ep("imagegen", "image"), to("tween", "in-tween-3"))).toBe(true);
    expect(canConnect(ep("videogen", "video"), to("output", "in-out"))).toBe(true);
    expect(canConnect(ep("videogen", "video"), to("editvideo", "in-video"))).toBe(true);
  });
  it("rejects cross-media and wrong-kind edges", () => {
    expect(canConnect(ep("videogen", "video"), to("videogen", "in-image"))).toBe(false);
    expect(canConnect(ep("videogen", "video"), to("tween", "in-tween-0"))).toBe(false);
    expect(canConnect(ep("imagegen", "image"), to("editvideo", "in-video"))).toBe(false);
    expect(canConnect(ep("brand", "text"), to("composer", "in-style"))).toBe(false);
    expect(canConnect(ep("composer", "text"), to("videogen", "in-prompt"))).toBe(false);
    expect(canConnect(ep("style", "text"), to("output", "in-out"))).toBe(false);
  });
  it("every node kind declares at least one port", () => {
    for (const k of ["composer", "style", "brand", "imagegen", "videogen", "editgen", "editvideo", "tween", "ref", "output", "videoprompt", "editprompt", "editvideoprompt"] as GraphNodeKind[]) {
      const d = nodeDecl(k);
      expect(d, k).toBeDefined();
      expect((d!.inputs.length + d!.outputs.length)).toBeGreaterThan(0);
    }
  });
});

describe("normalizeGraph invariants", () => {
  it("drops duplicate/dangling/self/undeclared edges and duplicate nodes", () => {
    const node = (id: string, kind: GraphNodeKind) => ({ id, kind, pos: { x: 0, y: 0 } });
    const g: Graph = {
      version: 1,
      nodes: [node("composer", "composer"), node("imagegen", "imagegen"), node("composer", "composer")],
      edges: [
        { id: "ok", from: { node: "composer", port: "out" }, to: { node: "imagegen", port: "in-prompt" } },
        { id: "dup", from: { node: "composer", port: "out" }, to: { node: "imagegen", port: "in-prompt" } },
        { id: "dangle", from: { node: "composer", port: "out" }, to: { node: "ghost", port: "in-prompt" } },
        { id: "self", from: { node: "composer", port: "out" }, to: { node: "composer", port: "in-ref-open" } },
        { id: "badport", from: { node: "composer", port: "out" }, to: { node: "imagegen", port: "nope" } },
      ],
    };
    const { graph, issues } = normalizeGraph(g);
    expect(graph.nodes.map((n) => n.id)).toEqual(["composer", "imagegen"]);
    expect(graph.edges.map((e) => e.id)).toEqual(["ok"]);
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });
});

describe("materializeGraph idempotence", () => {
  const fixtures: ProductionShot[] = [
    shot(),
    shot({ prompt: "Style: X\n\n@[Gondola]", graphStyleConnected: true }),
    shot({ graphVideoPrompt: "Drift", graphImageToVideo: true, graphOutputSource: "videogen" }),
    shot({
      graphEditNodes: [{ id: "edit0", prompt: "Fix", source: { kind: "imagegen" }, styleConnected: true }],
      graphTweenRefIds: ["imagegen", "r1"],
      graphOutputSource: "editgen",
      graphOutputEditNodeId: "edit0",
    }),
    shot({ graphEditVideoPrompt: "Cut", graphVideoToEditVideo: true, graphOutputSource: "editvideo", graphVideoPrompt: "x", graphImageToVideo: true }),
  ];
  it("normalize(materialize(x)) is a fixed point for every fixture", () => {
    for (const s of fixtures) {
      const once = normalizeGraph(materializeGraph(s, REFS)).graph;
      const twice = normalizeGraph(materializeGraph(s, REFS)).graph;
      expect(twice).toEqual(once);
      expect(normalizeGraph(once).graph).toEqual(once);
      expect(once.migrated).toBeUndefined();
    }
  });
});

describe("renderPrompt: component order and edge-driven references", () => {
  it("renders Style, Brand, Content in order", () => {
    const base = shot({ prompt: "Alpha @[Gondola]", graphStyleConnected: true });
    const g = setBrandEdge(materializeGraph(base, REFS), "composer", true);
    const s = { ...base, graph: g };
    expect(renderShotPrompt(prod(), s, "composer")).toBe(
      "Style: Heroic 3D render\n\nBrand identity: Color palette: #aabbcc. Font: Baskerville.\n\nAlpha @[Gondola]"
    );
  });

  it("an edge adds its ref tag; no edge drops it (never text-derived)", () => {
    const base = shot({ prompt: "Alpha", graphStyleConnected: false });
    const g0 = materializeGraph(base, REFS);
    expect(renderShotPrompt(prod(), { ...base, graph: g0 }, "composer")).toBe("Alpha");
    const op = connectionToEdge({ source: "ref:r1", target: "composer", targetHandle: "in-ref-open" }, g0)!;
    const connected = applyConnection(g0, op);
    expect(renderShotPrompt(prod(), { ...base, graph: connected }, "composer")).toBe("Alpha\n\n@[Gondola]");
    expect(attachedRefIds({ ...base, graph: connected } as ProductionShot, "composer")).toEqual(["r1"]);
  });
});

describe("edge authority vs stored text (regression guard)", () => {
  // Build the graph from a CLEAN shot (no text signals), then mutate the
  // stored text — so the graph, not the text, is what decides.
  const cleanGraph = (): ProductionShot => {
    const { graph } = normalizeGraph(materializeGraph(shot({ prompt: "Alpha" }), REFS));
    graph.migrated = true;
    return { ...shot({ prompt: "Alpha" }), graph };
  };

  it("a stored Style paragraph with no edge never injects the library Style section", () => {
    const base = cleanGraph();
    const s = { ...base, prompt: "Style: sneaky pasted look\n\nAlpha" };
    const out = renderShotPrompt(prod(), s, "composer");
    expect(out).not.toContain("Style: Heroic 3D render"); // library text is edge-only
    expect(out).toContain("sneaky pasted look"); // detached prose is the user's own
  });

  it("a stored Brand paragraph with no edge is stripped, never replaced by the clause", () => {
    const base = cleanGraph();
    const s = { ...base, prompt: "Alpha\n\nBrand identity: pasted copy" };
    const out = renderShotPrompt(prod(), s, "composer");
    expect(out).not.toContain("Brand identity: pasted copy");
    expect(out).not.toContain("Color palette: #aabbcc");
  });

  it("a manually typed ref tag with no edge is dropped from a graph shot's render", () => {
    const base = cleanGraph();
    const s = { ...base, prompt: "Alpha @[Gondola]" };
    expect(renderShotPrompt(prod(), s, "composer")).toBe("Alpha");
  });

  it("an edge renders its section/tag even when the stored text has none", () => {
    const base = cleanGraph();
    const g = setBrandEdge(setStyleEdge(base.graph!, "composer", true), "composer", true);
    const op = connectionToEdge({ source: "ref:r1", target: "composer", targetHandle: "in-ref-open" }, g)!;
    const s = { ...base, prompt: "Alpha", graph: applyConnection(g, op) };
    expect(renderShotPrompt(prod(), s, "composer")).toBe(
      "Style: Heroic 3D render\n\nBrand identity: Color palette: #aabbcc. Font: Baskerville.\n\nAlpha\n\n@[Gondola]"
    );  });
});

describe("round-trip: graph survives JSON save/load and renders identically", () => {
  it("serialize → deserialize → render is unchanged", () => {
    const base = shot({ prompt: "Alpha @[Gondola]", graphStyleConnected: true, graphVideoPrompt: "Drift", graphImageToVideo: true });
    const g = setBrandEdge(materializeGraph(base, REFS), "composer", true);
    const s = { ...base, graph: g };
    const p = prod();
    const before = renderShotPrompt(p, s, "composer");
    const reloaded = JSON.parse(JSON.stringify(s)) as ProductionShot;
    expect(reloaded.graph).toEqual(g);
    expect(renderShotPrompt(p, reloaded, "composer")).toBe(before);
  });
});

/** Attach a fresh materialized graph to a shot (the migration's result). */
function graphed(s: ProductionShot): ProductionShot {
  const { graph } = normalizeGraph(materializeGraph(s, REFS));
  graph.migrated = true;
  return { ...s, graph };
}
