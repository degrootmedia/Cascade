/**
 * graphEdgesToFlow + promptSockets tests (master plan step 03 T5a): the
 * adapter reproduces the canvas edge objects byte-for-byte (ids, handles,
 * strokes, deletable flags) from stored edges, and the unified socket builder
 * matches the legacy geometry.
 */
import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";
import { edgeDeletable, edgeStroke, graphEdgesToFlow, promptSockets } from "../src/renderer/src/components/graphFlow.js";
import { materializeGraph } from "../src/shared/graph/materialize.js";
import type { ProductionShot } from "../src/shared/ipc.js";

const COLORS = { ref: "var(--graph-socket-ref)", style: "var(--graph-socket-style)", brand: "var(--graph-socket-brand)" };

const REFS = [
  { id: "r1", name: "Gondola", artwork: "g.png" },
  { id: "r2", name: "Marco", media: "video" as const, artwork: "m.png" },
];

const shot = (over: Partial<ProductionShot> = {}): ProductionShot =>
  ({ id: "s1", number: "0100", audio: "", visual: "", ...over }) as ProductionShot;

describe("graphEdgesToFlow reproduces the canvas picture", () => {
  it("rich fixture matches the legacy derivation literally", () => {
    const g = materializeGraph(
      shot({
        prompt: "Style: vivid\n\nHold @[Gondola]\n\nBrand identity: auto",
        graphVideoPrompt: "Drift @[Marco]",
        graphVideoStyleConnected: true,
        graphImageToVideo: true,
        graphEditNodes: [{ id: "edit0", prompt: "Fix", source: { kind: "imagegen" } }],
        graphTweenRefIds: ["imagegen"],
        graphOutputSource: "imagegen",
      }),
      REFS
    );
    const flow = graphEdgesToFlow(g, { selected: new Set(["e-style"]), colors: COLORS });
    const ref = (id: string, source: string, target: string, targetHandle: string, selected = false): Edge => ({
      id, source, target, targetHandle, style: { stroke: COLORS.ref }, reconnectable: false, selected,
    });
    const fixed = (id: string, source: string, target: string, targetHandle: string, stroke?: string): Edge => ({
      id, source, target, targetHandle,
      ...(stroke ? { style: { stroke } } : {}),
      deletable: false, reconnectable: false, selected: id === "e-style",
    });
    expect(flow).toEqual([
      ref("e-ref:r1-composer-0", "ref:r1", "composer", "in-ref-0"),
      ref("e-ref:r2-videoprompt-0", "ref:r2", "videoprompt", "in-ref-0"),
      fixed("e-style", "style", "composer", "in-style", COLORS.style),
      fixed("e-style-vp", "style", "videoprompt", "in-style", COLORS.style),
      fixed("e-brand", "brand", "composer", "in-brand", COLORS.brand),
      fixed("e-cmp-img", "composer", "imagegen", "in-prompt"),
      fixed("e-vp-vid", "videoprompt", "videogen", "in-prompt"),
      fixed("e-ep-edit:edit0", "editprompt:edit0", "editgen:edit0", "in-prompt"),
      fixed("e-img-vid", "imagegen", "videogen", "in-image", COLORS.ref),
      fixed("e-img-edit:edit0", "imagegen", "editgen:edit0", "in-image", COLORS.ref),
      fixed("e-tween-0", "imagegen", "tween", "in-tween-0", COLORS.ref),
      fixed("e-img-out", "imagegen", "output", "in-out"),
    ]);
  });

  it("only ref→prompt edges stay keyboard-deletable", () => {
    expect(edgeDeletable("ref:r1", "composer")).toBe(true);
    expect(edgeDeletable("ref:r1", "editprompt:edit0")).toBe(true);
    expect(edgeDeletable("ref:r1", "videogen")).toBe(false);
    expect(edgeDeletable("ref:r1", "tween")).toBe(false);
    expect(edgeDeletable("ref:r1", "output")).toBe(false);
    expect(edgeDeletable("imagegen", "output")).toBe(false);
    expect(edgeDeletable("style", "composer")).toBe(false);
  });

  it("stroke colors follow port semantics", () => {
    expect(edgeStroke("style", "in-style", COLORS)).toBe(COLORS.style);
    expect(edgeStroke("brand", "in-brand", COLORS)).toBe(COLORS.brand);
    expect(edgeStroke("ref:r1", "output", COLORS)).toBe(COLORS.ref);
    expect(edgeStroke("imagegen", "in-image", COLORS)).toBe(COLORS.ref);
    expect(edgeStroke("videogen", "in-video", COLORS)).toBe(COLORS.ref);
    expect(edgeStroke("imagegen", "in-tween-2", COLORS)).toBe(COLORS.ref);
    expect(edgeStroke("composer", "in-prompt", COLORS)).toBeUndefined();
    expect(edgeStroke("imagegen", "in-out", COLORS)).toBeUndefined();
  });
});

describe("promptSockets unifies the two legacy builders", () => {
  it("matches the legacy geometry (style / refs / open / brand)", () => {
    const sockets = promptSockets(["in-ref-0", "in-ref-1"], "in-ref-open");
    expect(sockets.map((s) => [s.id, s.kind, s.open])).toEqual([
      ["in-style", "style", false],
      ["in-ref-0", "ref", false],
      ["in-ref-1", "ref", false],
      ["in-ref-open", "ref", true],
      ["in-brand", "brand", false],
    ]);
    const n = 3;
    const total = n + 2;
    expect(sockets[0].top).toBe((1 / (total + 1)) * 100);
    expect(sockets[1].top).toBe((2 / (total + 1)) * 100);
    expect(sockets[3].top).toBe(((n + 1) / (total + 1)) * 100);
    expect(sockets[4].top).toBe((total / (total + 1)) * 100);
  });
});
