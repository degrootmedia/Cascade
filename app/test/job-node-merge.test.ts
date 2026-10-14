/**
 * A finished generation job must not revert graph-node edits the user made
 * while it ran. The job holds its own copy of the production from job start;
 * when it commits, only the generation histories it owns (gens + selection)
 * may land on the freshest disk state. Prompts (including `@[ref]` tags added
 * mid-job), source wiring, reference lists, node membership — everything the
 * renderer owns — must survive. Regression test for: connecting a reference
 * to an edit node mid-generation lost the wire (its socket derives from the
 * prompt tag) and left tag/edge disagreeing.
 */
import { describe, it, expect, vi } from "vitest";
import type { ProductionShot } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { mergeJobShotNodes } from "../src/main/pipeline.js";

const gen = (path: string) => ({ path, prompt: "p", model: "auto", at: "2026-01-01T00:00:00.000Z" });

describe("mergeJobShotNodes (finished job onto freshest disk state)", () => {
  it("keeps a reference tag + wiring added to an edit node mid-job, and lands the new generation", () => {
    const prev = {
      graphEditNodes: [{ id: "edit0", prompt: "make it night", gens: [gen("a.jpg")], genIndex: 0 }],
    } as unknown as ProductionShot;
    // While the job ran, the user wired a reference in: the prompt gained the
    // tag and the node was re-sourced.
    const fresh = {
      graphEditNodes: [{
        id: "edit0",
        prompt: "make it night @[Hero]",
        source: { kind: "ref", refId: "r1" },
        gens: [gen("a.jpg")],
        genIndex: 0,
      }],
    } as unknown as ProductionShot;
    // The job's own copy still holds the prompt as submitted (no tag).
    const next = {
      graphEditNodes: [{ id: "edit0", prompt: "make it night", gens: [gen("b.jpg"), gen("a.jpg")], genIndex: 0 }],
    } as unknown as ProductionShot;

    const merged = mergeJobShotNodes(prev, fresh, next);
    expect(merged.graphEditNodes).toHaveLength(1);
    expect(merged.graphEditNodes![0].prompt).toBe("make it night @[Hero]");
    expect(merged.graphEditNodes![0].source).toEqual({ kind: "ref", refId: "r1" });
    expect(merged.graphEditNodes![0].gens!.map((g) => g.path)).toEqual(["b.jpg", "a.jpg"]);
  });

  it("keeps a node the user added mid-job and drops one they deleted mid-job", () => {
    const prev = {
      graphEditNodes: [
        { id: "edit0", prompt: "x", gens: [gen("a.jpg")], genIndex: 0 },
        { id: "edit1", prompt: "y", gens: [], genIndex: 0 },
      ],
    } as unknown as ProductionShot;
    const fresh = {
      graphEditNodes: [
        { id: "edit0", prompt: "x", gens: [gen("a.jpg")], genIndex: 0 },
        { id: "edit2", prompt: "new", gens: [], genIndex: 0 },
      ],
    } as unknown as ProductionShot;
    const next = {
      graphEditNodes: [
        { id: "edit0", prompt: "x", gens: [gen("b.jpg"), gen("a.jpg")], genIndex: 0 },
        { id: "edit1", prompt: "y", gens: [], genIndex: 0 },
      ],
    } as unknown as ProductionShot;

    const merged = mergeJobShotNodes(prev, fresh, next);
    expect(merged.graphEditNodes!.map((n) => n.id)).toEqual(["edit0", "edit2"]);
  });

  it("keeps a node the job itself created (classic edit chain)", () => {
    const prev = { graphEditNodes: [] } as unknown as ProductionShot;
    const fresh = { graphEditNodes: [] } as unknown as ProductionShot;
    const next = {
      graphEditNodes: [{ id: "edit0", prompt: "warmer", source: { kind: "imagegen" }, gens: [gen("b.jpg")], genIndex: 0 }],
    } as unknown as ProductionShot;

    const merged = mergeJobShotNodes(prev, fresh, next);
    expect(merged.graphEditNodes).toHaveLength(1);
    expect(merged.graphEditNodes![0].source).toEqual({ kind: "imagegen" });
    expect(merged.graphEditNodes![0].gens!.map((g) => g.path)).toEqual(["b.jpg"]);
  });

  it("keeps video-node reference edits made mid-job while landing the new clip", () => {
    const prev = {
      graphVideoNodes: [{ id: "vid0", prompt: "pan", refIds: [], gens: [gen("a.mp4")], genIndex: 0 }],
    } as unknown as ProductionShot;
    const fresh = {
      graphVideoNodes: [{ id: "vid0", prompt: "pan slower", refIds: ["r9"], gens: [gen("a.mp4")], genIndex: 0 }],
    } as unknown as ProductionShot;
    const next = {
      graphVideoNodes: [{ id: "vid0", prompt: "pan", refIds: [], gens: [gen("b.mp4"), gen("a.mp4")], genIndex: 0 }],
    } as unknown as ProductionShot;

    const merged = mergeJobShotNodes(prev, fresh, next);
    expect(merged.graphVideoNodes![0].prompt).toBe("pan slower");
    expect(merged.graphVideoNodes![0].refIds).toEqual(["r9"]);
    expect(merged.graphVideoNodes![0].gens!.map((g) => g.path)).toEqual(["b.mp4", "a.mp4"]);
  });

  it("re-anchors the selection at the take the user picked mid-job", () => {
    const prev = {
      graphEditNodes: [{ id: "edit0", prompt: "x", gens: [gen("a.jpg"), gen("b.jpg")], genIndex: 0 }],
    } as unknown as ProductionShot;
    // The user cycled to b.jpg while the job ran.
    const fresh = {
      graphEditNodes: [{ id: "edit0", prompt: "x", gens: [gen("a.jpg"), gen("b.jpg")], genIndex: 1 }],
    } as unknown as ProductionShot;
    const next = {
      graphEditNodes: [{ id: "edit0", prompt: "x", gens: [gen("c.jpg"), gen("a.jpg"), gen("b.jpg")], genIndex: 0 }],
    } as unknown as ProductionShot;

    const merged = mergeJobShotNodes(prev, fresh, next);
    expect(merged.graphEditNodes![0].gens![merged.graphEditNodes![0].genIndex!].path).toBe("b.jpg");
  });

  it("keeps upscale wiring changed mid-job while landing the upscale", () => {
    const prev = { graphUpscale: { gens: [gen("a.jpg")], genIndex: 0 } } as unknown as ProductionShot;
    const fresh = {
      graphUpscale: { source: { kind: "ref", refId: "r2" }, gens: [gen("a.jpg")], genIndex: 0 },
    } as unknown as ProductionShot;
    const next = { graphUpscale: { gens: [gen("b.jpg"), gen("a.jpg")], genIndex: 0 } } as unknown as ProductionShot;

    const merged = mergeJobShotNodes(prev, fresh, next);
    expect(merged.graphUpscale!.source).toEqual({ kind: "ref", refId: "r2" });
    expect(merged.graphUpscale!.gens!.map((g) => g.path)).toEqual(["b.jpg", "a.jpg"]);
  });
});
