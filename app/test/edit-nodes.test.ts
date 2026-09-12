/**
 * Multiple daisy-chainable edit-image nodes: legacy migration, per-node
 * accessors, source-chain helpers, and the cycle guard.
 */
import { describe, it, expect, vi } from "vitest";
import type { ProductionShot } from "../src/shared/ipc.js";
import { TWEEN_KEY_EDITGEN, editNodeKeyframe, parseEditNodeKeyframe, isTweenGenKeyframe } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import {
  migrateEditNodes,
  getEditNode,
  editNodeSelection,
  findEditGen,
  editNodeDependsOn,
  chainSourceForEdit,
  newEditNode,
  recordGraphEditGen,
} from "../src/main/pipeline.js";

function makeShot(overrides: Partial<ProductionShot> = {}): ProductionShot {
  return { id: "shot1", number: "0100", audio: "", visual: "Hero walks", ...overrides };
}

describe("migrateEditNodes", () => {
  it("folds the legacy single edit node into edit0 and rewrites the tween sentinel", () => {
    const shot = makeShot({
      graphEditPrompt: "make it night",
      graphEditGens: [{ path: "edit.jpg", prompt: "p", model: "m", at: "" }],
      graphEditGenIndex: 0,
      graphEditImageSource: true,
      graphEditStyleConnected: true,
      graphOutputSource: "editgen",
      graphEditToVideo: true,
      graphTweenRefIds: [TWEEN_KEY_EDITGEN, "ref-a"],
      graphTweenBlocks: [
        { id: "tw0", startRefId: TWEEN_KEY_EDITGEN, endRefId: "ref-a", prompt: "turn", startSec: 0, durationSec: 2 },
      ],
    });
    expect(migrateEditNodes(shot)).toBe(true);
    expect(shot.graphEditNodes).toEqual([
      { id: "edit0", prompt: "make it night", gens: [{ path: "edit.jpg", prompt: "p", model: "m", at: "" }], genIndex: 0, source: { kind: "imagegen" }, styleConnected: true },
    ]);
    expect(shot.graphOutputEditNodeId).toBe("edit0");
    expect(shot.graphVideoSourceEditNodeId).toBe("edit0");
    expect(shot.graphTweenRefIds).toEqual([editNodeKeyframe("edit0"), "ref-a"]);
    expect(shot.graphTweenBlocks?.[0].startRefId).toBe(editNodeKeyframe("edit0"));
    // Legacy fields are gone; the classic popup draft stays.
    expect(shot.graphEditGens).toBeUndefined();
    expect(shot.graphEditImageSource).toBeUndefined();
    expect(shot.graphEditPrompt).toBe("make it night");
    // Idempotent.
    expect(migrateEditNodes(shot)).toBe(false);
  });

  it("creates edit0 when only a legacy tween keyframe references the edit node", () => {
    const shot = makeShot({ graphTweenRefIds: [TWEEN_KEY_EDITGEN, "ref-a"] });
    expect(migrateEditNodes(shot)).toBe(true);
    expect(shot.graphEditNodes?.[0].id).toBe("edit0");
    expect(shot.graphTweenRefIds?.[0]).toBe(editNodeKeyframe("edit0"));
  });

  it("does nothing for a shot with no edit usage", () => {
    const shot = makeShot();
    expect(migrateEditNodes(shot)).toBe(false);
    expect(shot.graphEditNodes).toBeUndefined();
  });

  it("round-trips the keyframe sentinel helpers", () => {
    expect(editNodeKeyframe("edit3")).toBe("editgen:edit3");
    expect(parseEditNodeKeyframe("editgen:edit3")).toBe("edit3");
    expect(parseEditNodeKeyframe(TWEEN_KEY_EDITGEN)).toBe("edit0");
    expect(parseEditNodeKeyframe("ref-abc")).toBeNull();
    expect(isTweenGenKeyframe("editgen:edit2")).toBe(true);
    expect(isTweenGenKeyframe(TWEEN_KEY_EDITGEN)).toBe(true);
    expect(isTweenGenKeyframe("editgen")).toBe(true);
    expect(isTweenGenKeyframe("ref-abc")).toBe(false);
  });
});

describe("edit node accessors", () => {
  const nodes = [
    { id: "edit0", prompt: "a", gens: [{ path: "a.jpg", prompt: "", model: "", at: "" }], genIndex: 0 },
    { id: "edit1", prompt: "b", gens: [{ path: "b.jpg", prompt: "", model: "", at: "" }], genIndex: 0 },
  ];

  it("finds by id and falls back to the first node", () => {
    const shot = makeShot({ graphEditNodes: nodes });
    expect(getEditNode(shot, "edit1")?.prompt).toBe("b");
    expect(getEditNode(shot)?.id).toBe("edit0");
    expect(getEditNode(shot, "missing")).toBeUndefined();
  });

  it("resolves a node's selected generation and the node owning a path", () => {
    const shot = makeShot({ graphEditNodes: nodes });
    expect(editNodeSelection(shot, "edit1")?.path).toBe("b.jpg");
    expect(findEditGen(shot, "a.jpg")?.node.id).toBe("edit0");
    expect(findEditGen(shot, "nope.jpg")).toBeNull();
  });

  it("detects source-chain cycles", () => {
    const shot = makeShot({
      graphEditNodes: [
        { id: "edit0", prompt: "" },
        { id: "edit1", prompt: "", source: { kind: "editgen", nodeId: "edit0" } },
        { id: "edit2", prompt: "", source: { kind: "editgen", nodeId: "edit1" } },
      ],
    });
    expect(editNodeDependsOn(shot, "edit1", "edit0")).toBe(true);
    expect(editNodeDependsOn(shot, "edit2", "edit0")).toBe(true);
    expect(editNodeDependsOn(shot, "edit0", "edit1")).toBe(false);
  });
});

describe("chainSourceForEdit", () => {
  it("chains from the output edit node", () => {
    const shot = makeShot({ graphOutputSource: "editgen", graphOutputEditNodeId: "edit1", graphEditNodes: [{ id: "edit1", prompt: "" }] });
    expect(chainSourceForEdit(shot)).toEqual({ kind: "editgen", nodeId: "edit1" });
  });

  it("wires the image node when the output is an image generation", () => {
    expect(chainSourceForEdit(makeShot({ graphOutputSource: "imagegen" }))).toEqual({ kind: "imagegen" });
  });

  it("wires the output reference", () => {
    expect(chainSourceForEdit(makeShot({ graphOutputSource: "ref", graphOutputRefId: "r1" }))).toEqual({ kind: "ref", refId: "r1" });
  });

  it("selects the image generation matching the current artwork, else no source", () => {
    const shot = makeShot({
      artwork: "frame-1.jpg",
      graphImageGens: [{ path: "frame-0.jpg", prompt: "", model: "", at: "" }, { path: "frame-1.jpg", prompt: "", model: "", at: "" }],
      graphImageGenIndex: 0,
    });
    expect(chainSourceForEdit(shot)).toEqual({ kind: "imagegen" });
    expect(shot.graphImageGenIndex).toBe(1);
    expect(chainSourceForEdit(makeShot({ artwork: "legacy.jpg" }))).toBeUndefined();
  });
});

describe("newEditNode / recordGraphEditGen", () => {
  it("allocates the next free id and records onto that node", () => {
    const shot = makeShot({ graphEditNodes: [{ id: "edit0", prompt: "" }] });
    const node = newEditNode(shot, "");
    expect(node.id).toBe("edit1");
    recordGraphEditGen(shot, "edit1", "new.jpg", "p", "m");
    expect(editNodeSelection(shot, "edit1")?.path).toBe("new.jpg");
    expect(editNodeSelection(shot, "edit0")).toBeUndefined();
  });
});
