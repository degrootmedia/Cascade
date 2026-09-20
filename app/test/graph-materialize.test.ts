/**
 * materializeGraph tests (master plan step 03 T3): every flag/text-derived
 * wire converts to nodes/edges, and normalize(materialize(x)) is stable.
 */
import { describe, it, expect } from "vitest";
import { materializeGraph, videoPairActive, tweenActive, editVideoActive, type GraphRefView } from "../src/shared/graph/materialize.js";
import { normalizeGraph } from "../src/shared/graph/normalize.js";
import { TWEEN_KEY_IMGGEN } from "../src/shared/ipc.js";
import type { Graph, ProductionShot } from "../src/shared/ipc.js";

const REFS: GraphRefView[] = [
  { id: "r1", name: "Gondola", artwork: "g.png" },
  { id: "r2", name: "Marco", media: "video", artwork: "m.png" },
];

const shot = (over: Partial<ProductionShot> = {}): ProductionShot =>
  ({ id: "s1", number: "0100", audio: "", visual: "", ...over }) as ProductionShot;

const edgeIds = (g: Graph): string[] => g.edges.map((e) => e.id);
const nodeIds = (g: Graph): string[] => g.nodes.map((n) => n.id);

function stable(g: Graph): Graph {
  const { graph, issues } = normalizeGraph(g);
  expect(issues).toEqual([]);
  return graph;
}

describe("materializeGraph basics", () => {
  it("a bare shot yields the structural nodes + composer pipe only", () => {
    const g = stable(materializeGraph(shot(), REFS));
    expect(nodeIds(g)).toEqual(["composer", "style", "brand", "output", "imagegen"]);
    expect(edgeIds(g)).toEqual(["e-cmp-img"]);
  });

  it("style flag wins over the paragraph (remembered plug)", () => {
    const withPara = stable(materializeGraph(shot({ prompt: "Style: vivid\n\nA shot" }), REFS));
    expect(edgeIds(withPara)).toContain("e-style");
    const unplugged = stable(
      materializeGraph(shot({ prompt: "Style: vivid\n\nA shot", graphStyleConnected: false }), REFS)
    );
    expect(edgeIds(unplugged)).not.toContain("e-style");
  });

  it("brand paragraph plugs the brand node (composer + video)", () => {
    const g = stable(
      materializeGraph(
        shot({ prompt: "A shot\n\nBrand identity: auto", graphVideoPrompt: "Move\n\nBrand identity: auto", graphImageToVideo: true }),
        REFS
      )
    );
    expect(edgeIds(g)).toContain("e-brand");
    expect(edgeIds(g)).toContain("e-brand-vp");
  });

  it("tags become ref nodes + ordered sockets; dangling tags become missing nodes", () => {
    const g = stable(materializeGraph(shot({ prompt: "See @[Gondola] then @[Marco] and @[Ghost]" }), REFS));
    expect(nodeIds(g)).toContain("ref:r1");
    expect(nodeIds(g)).toContain("ref:r2");
    expect(nodeIds(g)).toContain("ref:missing-2");
    expect(edgeIds(g)).toContain("e-ref:r1-composer-0");
    expect(edgeIds(g)).toContain("e-ref:r2-composer-1");
    expect(edgeIds(g)).toContain("e-ref:missing-2-composer-2");
  });
});

describe("video / edit / tween / edit-video wires", () => {
  it("video pair, source pipes, and video output", () => {
    const g = stable(
      materializeGraph(
        shot({
          prompt: "A @[Gondola]",
          graphVideoPrompt: "Drift",
          graphImageToVideo: true,
          graphOutputSource: "videogen",
        }),
        REFS
      )
    );
    expect(nodeIds(g)).toContain("videoprompt");
    expect(nodeIds(g)).toContain("videogen");
    for (const id of ["e-vp-vid", "e-img-vid", "e-vid-out", "e-ref:r1-composer-0"]) {
      expect(edgeIds(g)).toContain(id);
    }
  });

  it("reference video source needs a node (tagged or placed)", () => {
    const tagged = stable(materializeGraph(shot({ prompt: "@[Gondola]", graphVideoPrompt: "x", graphVideoSourceRefId: "r1" }), REFS));
    expect(edgeIds(tagged)).toContain("e-ref-vid");
    const unplaced = materializeGraph(shot({ graphVideoPrompt: "x", graphVideoSourceRefId: "r1" }), REFS);
    // No dangling edge: the source ref has no node, so no wire (normalize-stable).
    expect(edgeIds(unplaced)).not.toContain("e-ref-vid");
    expect(normalizeGraph(unplaced).issues).toEqual([]);
  });

  it("edit chains: pairs, source pipes, style plugs, output", () => {
    const g = stable(
      materializeGraph(
        shot({
          prompt: "Base",
          graphEditNodes: [
            { id: "edit0", prompt: "Fix @[Gondola]", source: { kind: "imagegen" }, styleConnected: true },
            { id: "edit1", prompt: "More", source: { kind: "editgen", nodeId: "edit0" } },
          ],
          graphOutputSource: "editgen",
          graphOutputEditNodeId: "edit1",
        }),
        REFS
      )
    );
    for (const id of ["editprompt:edit0", "editgen:edit0", "editprompt:edit1", "editgen:edit1"]) {
      expect(nodeIds(g)).toContain(id);
    }
    for (const id of ["e-ep-edit:edit0", "e-ep-edit:edit1", "e-img-edit:edit0", "e-edit-edit:edit1", "e-style-ep:edit0", "e-ref:r1-editprompt:edit0-0", "e-edit-out"]) {
      expect(edgeIds(g)).toContain(id);
    }
  });

  it("tween keyframes in timeline order + tween output", () => {
    const g = stable(
      materializeGraph(shot({ graphTweenRefIds: [TWEEN_KEY_IMGGEN, "r1"], graphOutputSource: "tween", prompt: "@[Gondola]" }), REFS)
    );
    expect(nodeIds(g)).toContain("tween");
    expect(edgeIds(g)).toContain("e-tween-0");
    expect(edgeIds(g)).toContain("e-tween-1");
    expect(edgeIds(g)).toContain("e-tween-out");
    const e0 = g.edges.find((e) => e.id === "e-tween-0")!;
    expect(e0.from).toEqual({ node: "imagegen", port: "out" });
    expect(e0.to).toEqual({ node: "tween", port: "in-tween-0" });
  });

  it("edit-video source wires and output (fills the canvas gap)", () => {
    const g = stable(
      materializeGraph(
        shot({
          graphVideoPrompt: "x",
          graphImageToVideo: true,
          graphVideoToEditVideo: true,
          graphEditVideoPrompt: "Cut",
          graphOutputSource: "editvideo",
        }),
        REFS
      )
    );
    expect(nodeIds(g)).toContain("editvideo");
    expect(nodeIds(g)).toContain("editvideoprompt");
    expect(edgeIds(g)).toContain("e-vid-ev");
    expect(edgeIds(g)).toContain("e-evp-ev");
    expect(edgeIds(g)).toContain("e-editvideo-out");
  });

  it("reference output feed", () => {
    const g = stable(materializeGraph(shot({ prompt: "@[Gondola]", graphOutputSource: "ref", graphOutputRefId: "r1" }), REFS));
    expect(edgeIds(g)).toContain("e-ref-out");
  });
});

describe("positions and placement", () => {
  it("carries saved positions; layout-placed refs and tools gain nodes", () => {
    const g = stable(
      materializeGraph(
        shot({ graphLayout: { positions: { composer: { x: 11, y: 22 }, "ref:r2": { x: 5, y: 5 }, tween: { x: 9, y: 9 } } } }),
        REFS
      )
    );
    expect(g.nodes.find((n) => n.id === "composer")?.pos).toEqual({ x: 11, y: 22 });
    expect(nodeIds(g)).toContain("ref:r2");
    expect(nodeIds(g)).toContain("tween");
  });
});

describe("activity predicates mirror the canvas", () => {
  it("video/tween/edit-video activate on the same flags", () => {
    expect(videoPairActive(shot())).toBe(false);
    expect(videoPairActive(shot({ graphImageToVideo: true }))).toBe(true);
    expect(tweenActive(shot({ graphOutputSource: "tween" }))).toBe(true);
    expect(editVideoActive(shot({ graphOutputSource: "editvideo" }))).toBe(true);
    expect(editVideoActive(shot())).toBe(false);
  });
});

describe("idempotence", () => {
  it("materialize is deterministic and normalize-stable on a rich shot", () => {
    const s = shot({
      prompt: "Style: vivid\n\nSee @[Gondola]\n\nBrand identity: auto",
      graphVideoPrompt: "Drift @[Marco]",
      graphImageToVideo: true,
      graphEditNodes: [{ id: "edit0", prompt: "Fix", source: { kind: "ref", refId: "r1" } }],
      graphTweenRefIds: [TWEEN_KEY_IMGGEN],
      graphOutputSource: "imagegen",
    });
    const a = materializeGraph(s, REFS);
    const b = materializeGraph(s, REFS);
    expect(a).toEqual(b);
    expect(stable(a)).toEqual(a);
  });
});
