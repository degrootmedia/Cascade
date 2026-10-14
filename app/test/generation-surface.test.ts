/**
 * Contextual output binding (Step 4): generation completion receives an
 * explicit initiation surface. Classic storyboard completions auto-connect
 * to Frame Output; node-view completions record on their node only and
 * never change the output — for every media type.
 */
import { describe, it, expect, vi } from "vitest";
import type { ProductionShot } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import {
  applyJobShotChanges,
  completeEditGeneration,
  completeImageGeneration,
  completePendingImageGeneration,
  completeUpscaleGeneration,
  completeVideoGeneration,
} from "../src/main/pipeline.js";
import { resolveSelectedOutput } from "../src/shared/selected-output.js";

function shot(over: Partial<ProductionShot> = {}): ProductionShot {
  return {
    id: "s1",
    number: "0100",
    audio: "",
    visual: "",
    graphVideoNodes: [{ id: "vid0", prompt: "", gens: [{ path: "v/old.mp4", prompt: "", model: "", at: "" }], genIndex: 0 }],
    graphEditNodes: [{ id: "edit0", prompt: "" }],
    graphOutputSource: "videogen",
    graphOutputVideoNodeId: "vid0",
    ...over,
  } as ProductionShot;
}

describe("node-view completions stay local", () => {
  it("image: records on the image node, Frame Output unchanged", () => {
    const s = shot();
    completeImageGeneration(s, "b/new.jpg", "p", "m", "node");
    expect(s.graphImageGens?.[0].path).toBe("b/new.jpg");
    expect(s.graphOutputSource).toBe("videogen");
    expect(resolveSelectedOutput(s).source).toBe("videogen");
  });

  it("video: records on its node, Frame Output unchanged", () => {
    const s = shot({ graphOutputSource: "imagegen" });
    completeVideoGeneration(s, "vid0", "v/new.mp4", "p", "m", undefined, "node");
    expect(s.graphVideoNodes?.[0].gens?.[0].path).toBe("v/new.mp4");
    expect(s.graphOutputSource).toBe("imagegen");
  });

  it("edit: records on its node, Frame Output unchanged", () => {
    const s = shot();
    completeEditGeneration(s, "edit0", "b/edit.jpg", "p", "m", "node");
    expect(s.graphEditNodes?.[0].gens?.[0].path).toBe("b/edit.jpg");
    expect(s.graphOutputSource).toBe("videogen");
  });

  it("upscale: records on its node, Frame Output unchanged", () => {
    const s = shot();
    completeUpscaleGeneration(s, "b/up.jpg", "m", "node");
    expect(s.graphUpscale?.gens?.[0].path).toBe("b/up.jpg");
    expect(s.graphOutputSource).toBe("videogen");
  });
});

describe("pending reclaim routes to the node that submitted", () => {
  const pending = (over: Record<string, unknown> = {}) => ({
    prompt: "make it night", model: "m", at: "2026-01-01T00:00:00.000Z", ...over,
  }) as never;

  it("an edit node's reclaimed frame lands on the edit node, not the image node", () => {
    const s = shot();
    completePendingImageGeneration(s, "b/reclaimed.jpg", pending({ target: { kind: "editgen", nodeId: "edit0" } }));
    expect(s.graphEditNodes?.[0].gens?.[0].path).toBe("b/reclaimed.jpg");
    expect(s.graphImageGens ?? []).toHaveLength(0);
    expect(s.graphOutputSource).toBe("videogen");
  });

  it("an image node's reclaimed frame lands on the image node", () => {
    const s = shot();
    completePendingImageGeneration(s, "b/reclaimed.jpg", pending({ target: { kind: "imagegen" } }));
    expect(s.graphImageGens?.[0].path).toBe("b/reclaimed.jpg");
  });

  it("an upscale node's reclaimed frame lands on the upscale node", () => {
    const s = shot();
    completePendingImageGeneration(s, "b/reclaimed.jpg", pending({ target: { kind: "upscale" } }));
    expect(s.graphUpscale?.gens?.[0].path).toBe("b/reclaimed.jpg");
    expect(s.graphImageGens ?? []).toHaveLength(0);
  });

  it("a target whose edit node was deleted falls back to the image node (no output hook)", () => {
    const s = shot({ graphEditNodes: [] });
    completePendingImageGeneration(s, "b/reclaimed.jpg", pending({ target: { kind: "editgen", nodeId: "gone" } }));
    expect(s.graphImageGens?.[0].path).toBe("b/reclaimed.jpg");
    expect(s.graphOutputSource).toBe("videogen");
  });

  it("legacy records keep their surface routing (node stays local, classic hooks output)", () => {
    const nodeSide = shot();
    completePendingImageGeneration(nodeSide, "b/a.jpg", pending({ surface: "node" }));
    expect(nodeSide.graphImageGens?.[0].path).toBe("b/a.jpg");
    expect(nodeSide.graphOutputSource).toBe("videogen");
    const classic = shot({ graphOutputSource: undefined, graphOutputVideoNodeId: undefined });
    completePendingImageGeneration(classic, "b/b.jpg", pending());
    expect(classic.graphOutputSource).toBe("imagegen");
  });
});

describe("job rebase field copy", () => {
  it("propagates deletions (a cleared pending record stays cleared)", () => {
    const prev = { id: "s1", prompt: "old", pendingImageGen: { historyId: "h" } } as never;
    const next = { id: "s1", prompt: "old", artwork: "b/new.jpg" } as never;
    const fresh = { id: "s1", prompt: "edited mid-job", pendingImageGen: { historyId: "h" } } as never;
    applyJobShotChanges(prev, next, fresh);
    const f = fresh as unknown as Record<string, unknown>;
    expect(f.pendingImageGen).toBeUndefined();
    expect(f.artwork).toBe("b/new.jpg");
    // Untouched fields keep their fresher on-disk values.
    expect(f.prompt).toBe("edited mid-job");
  });
});

describe("classic completions auto-connect", () => {
  it("image: hooks the image node when no deliberate pipe blocks it", () => {
    const s = shot({ graphOutputSource: undefined, graphOutputVideoNodeId: undefined });
    completeImageGeneration(s, "b/new.jpg", "p", "m", "classic");
    expect(s.graphOutputSource).toBe("imagegen");
  });

  it("video: binds the video node as the output", () => {
    const s = shot({ graphOutputSource: "imagegen" });
    completeVideoGeneration(s, "vid0", "v/new.mp4", "p", "m", undefined, "classic");
    expect(s.graphOutputSource).toBe("videogen");
    expect(s.graphOutputVideoNodeId).toBe("vid0");
  });

  it("edit: binds the edit node as the output", () => {
    const s = shot();
    completeEditGeneration(s, "edit0", "b/edit.jpg", "p", "m", "classic");
    expect(s.graphOutputSource).toBe("editgen");
    expect(s.graphOutputEditNodeId).toBe("edit0");
  });

  it("upscale: binds the upscale node as the output", () => {
    const s = shot();
    completeUpscaleGeneration(s, "b/up.jpg", "m", "classic");
    expect(s.graphOutputSource).toBe("upscale");
  });
});
