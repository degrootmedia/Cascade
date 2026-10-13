/**
 * Stored-graph read model (Step 3): after migration the canvas reads the
 * stored graph only. A stored branch the legacy flat fields cannot express
 * must survive opening the canvas — re-deriving from flat fields would
 * flatten it away.
 */
import { describe, it, expect } from "vitest";
import { materializeGraph, storedOrMaterializedGraph, type GraphRefView } from "../src/shared/graph/materialize.js";
import { normalizeGraph } from "../src/shared/graph/normalize.js";
import type { Graph, ProductionShot } from "../src/shared/ipc.js";

const REFS: GraphRefView[] = [{ id: "r1", name: "Gondola", artwork: "g.png" }];

const shot = (over: Partial<ProductionShot> = {}): ProductionShot =>
  ({ id: "s1", number: "0100", audio: "", visual: "", ...over }) as ProductionShot;

describe("storedOrMaterializedGraph", () => {
  it("returns the stored graph when one exists, preserving branches flat fields cannot express", () => {
    const stored: Graph = {
      version: 1,
      migrated: true,
      nodes: [
        { id: "composer", kind: "composer", pos: { x: 0, y: 0 } },
        { id: "output", kind: "output", pos: { x: 10, y: 0 } },
        { id: "videogen:vid9", kind: "videogen", pos: { x: 5, y: 5 } },
      ],
      edges: [],
    };
    const out = storedOrMaterializedGraph(shot({ graph: stored }), REFS);
    expect(out.nodes.map((n) => n.id)).toContain("videogen:vid9");
    // The flat-field derivation for the same shot has no video node at all —
    // this is the branch that used to be flattened on canvas open.
    expect(materializeGraph(shot(), REFS).nodes.map((n) => n.id)).not.toContain("videogen:vid9");
  });

  it("materializes from legacy fields only when no stored graph exists", () => {
    const out = storedOrMaterializedGraph(shot(), REFS);
    expect(out.nodes.map((n) => n.id)).toEqual(["composer", "style", "brand", "output", "imagegen"]);
  });

  it("is a fixed point for a settled stored graph (second open changes nothing)", () => {
    const stored = normalizeGraph(materializeGraph(shot(), REFS)).graph;
    stored.migrated = true;
    const once = storedOrMaterializedGraph(shot({ graph: stored }), REFS);
    expect(once).toEqual(stored);
    expect(storedOrMaterializedGraph(shot({ graph: once }), REFS)).toEqual(once);
  });
});
