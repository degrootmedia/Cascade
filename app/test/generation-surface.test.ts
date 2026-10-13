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
  completeEditGeneration,
  completeImageGeneration,
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
