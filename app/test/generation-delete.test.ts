/**
 * Generation deletion — locating a stored take by path, blocking ones that
 * still feed the storyboard/animatic/a pipe, removing the history entry
 * (repairing the selection), and unlinking the file + archived original.
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { findGeneration, generationInUse, removeGeneration } from "../src/shared/generations.js";
import { deleteGeneration } from "../src/main/pipeline.js";

function makeShot(number: string, overrides: Partial<ProductionShot> = {}): ProductionShot {
  return { id: `shot-${number}`, number, audio: "", visual: `Visual ${number}`, ...overrides };
}

function makeProduction(folder: string, shots: ProductionShot[]): Production {
  return {
    meta: { id: "prod-1", name: "Test", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: shots.length },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: shots.map((shot) => ({ number: 1, title: "S1", shots: [shot] })),
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
  } as Production;
}

const gen = (rel: string) => ({ path: rel, prompt: "", model: "m", at: "" });

describe("findGeneration", () => {
  it("locates each history owner by path and returns null otherwise", () => {
    const shot = makeShot("0100", {
      graphImageGens: [gen("i.jpg")],
      graphVideoGens: [gen("v.mp4")],
      graphEditVideoGens: [gen("ev.mp4")],
      graphEditNodes: [{ id: "edit0", prompt: "", gens: [gen("e.jpg")] }],
      graphTweenBlocks: [{ id: "tw0", startRefId: "a", endRefId: "b", prompt: "", startSec: 0, durationSec: 2, gens: [gen("t.mp4")] }],
      artworkHistory: ["legacy.jpg"],
    });
    expect(findGeneration(shot, "i.jpg")).toMatchObject({ kind: "image", index: 0 });
    expect(findGeneration(shot, "v.mp4")).toMatchObject({ kind: "video", index: 0 });
    expect(findGeneration(shot, "ev.mp4")).toMatchObject({ kind: "editvideo", index: 0 });
    expect(findGeneration(shot, "e.jpg")).toMatchObject({ kind: "edit", index: 0, nodeId: "edit0" });
    expect(findGeneration(shot, "t.mp4")).toMatchObject({ kind: "tween", index: 0, blockId: "tw0" });
    expect(findGeneration(shot, "legacy.jpg")).toBeNull();
    expect(findGeneration(shot, "")).toBeNull();
  });
});

describe("generationInUse", () => {
  it("blocks the active output/pipe/keyframe but allows older takes", () => {
    const shot = makeShot("0100", {
      artwork: "bound.jpg",
      graphImageGens: [gen("bound.jpg"), gen("old.jpg")],
      graphImageGenIndex: 0,
    });
    expect(generationInUse(shot, findGeneration(shot, "bound.jpg")!)).toBe("the storyboard's current frame");
    expect(generationInUse(shot, findGeneration(shot, "old.jpg")!)).toBeNull();

    shot.videoPath = "bound.jpg";
    shot.artwork = "";
    expect(generationInUse(shot, findGeneration(shot, "bound.jpg")!)).toBe("the shot's current clip");
  });

  it("blocks the image node while it feeds the video node or a tween keyframe", () => {
    const shot = makeShot("0100", {
      graphImageGens: [gen("frame.jpg"), gen("old.jpg")],
      graphImageGenIndex: 0,
      graphImageToVideo: true,
    });
    expect(generationInUse(shot, findGeneration(shot, "frame.jpg")!)).toBe("the video node's source frame");
    shot.graphImageToVideo = false;
    shot.graphTweenRefIds = ["imagegen"];
    expect(generationInUse(shot, findGeneration(shot, "frame.jpg")!)).toBe("an in-betweener keyframe");
  });

  it("blocks an edit-node take feeding output/video/a child node, older takes free", () => {
    const shot = makeShot("0100", {
      graphEditNodes: [
        { id: "edit0", prompt: "", gens: [gen("e0.jpg"), gen("e0-old.jpg")], genIndex: 0 },
        { id: "edit1", prompt: "", source: { kind: "editgen", nodeId: "edit0" } },
      ],
    });
    expect(generationInUse(shot, findGeneration(shot, "e0.jpg")!)).toBe("another edit node's source image");
    expect(generationInUse(shot, findGeneration(shot, "e0-old.jpg")!)).toBeNull();

    shot.graphEditNodes![1].source = undefined;
    shot.graphOutputSource = "editgen";
    shot.graphOutputEditNodeId = "edit0";
    expect(generationInUse(shot, findGeneration(shot, "e0.jpg")!)).toBe("the storyboard's current frame");
  });

  it("blocks a tween take only while it is selected and the stitch is live", () => {
    const block = { id: "tw0", startRefId: "a", endRefId: "b", prompt: "", startSec: 0, durationSec: 2, gens: [gen("t.mp4"), gen("t-old.mp4")], genIndex: 0 };
    const shot = makeShot("0100", { graphTweenBlocks: [block], graphTweenOutput: "tween.mp4" });
    expect(generationInUse(shot, findGeneration(shot, "t.mp4")!)).toBe("the stitched in-betweener output");
    expect(generationInUse(shot, findGeneration(shot, "t-old.mp4")!)).toBeNull();
  });
});

describe("removeGeneration", () => {
  it("drops the entry, repairs the selection, and purges the artworkHistory mirror", () => {
    const shot = makeShot("0100", {
      graphImageGens: [gen("a.jpg"), gen("b.jpg"), gen("c.jpg")],
      graphImageGenIndex: 2,
      artworkHistory: ["a.jpg", "legacy.jpg"],
    });
    // Remove an older entry before the selection: the selection shifts with it.
    removeGeneration(shot, findGeneration(shot, "b.jpg")!);
    expect(shot.graphImageGens?.map((g) => g.path)).toEqual(["a.jpg", "c.jpg"]);
    expect(shot.graphImageGenIndex).toBe(1);
    removeGeneration(shot, findGeneration(shot, "a.jpg")!);
    expect(shot.artworkHistory).toEqual(["legacy.jpg"]);
  });

  it("clears the selection to undefined when the last take goes", () => {
    const shot = makeShot("0100", { graphVideoGens: [gen("only.mp4")], graphVideoGenIndex: 0 });
    removeGeneration(shot, findGeneration(shot, "only.mp4")!);
    expect(shot.graphVideoGens).toEqual([]);
    expect(shot.graphVideoGenIndex).toBeUndefined();
  });
});

describe("deleteGeneration", () => {
  it("removes the entry and unlinks the frame plus its archived original", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-gen-delete-"));
    try {
      const write = (rel: string) => {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, "bytes");
      };
      write("boards/0100/shot-0100-tag.jpg");
      write("boards/0100/originals/shot-0100-tag.png");
      const shot = makeShot("0100", { graphImageGens: [gen("boards/0100/shot-0100-tag.jpg"), gen("boards/0100/shot-0100-keep.jpg")] });
      const p = makeProduction(root, [shot]);

      deleteGeneration(p, shot, "boards/0100/shot-0100-tag.jpg");

      expect(shot.graphImageGens?.map((g) => g.path)).toEqual(["boards/0100/shot-0100-keep.jpg"]);
      expect(fs.existsSync(path.join(root, "boards/0100/shot-0100-tag.jpg"))).toBe(false);
      expect(fs.existsSync(path.join(root, "boards/0100/originals/shot-0100-tag.png"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses non-generations and in-use takes without touching disk", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-gen-delete-"));
    try {
      fs.writeFileSync(path.join(root, "legacy.jpg"), "bytes");
      fs.writeFileSync(path.join(root, "bound.jpg"), "bytes");
      const shot = makeShot("0100", { artwork: "bound.jpg", graphImageGens: [gen("bound.jpg")] });
      const p = makeProduction(root, [shot]);

      expect(() => deleteGeneration(p, shot, "legacy.jpg")).toThrow(/isn't a stored generation/);
      expect(() => deleteGeneration(p, shot, "bound.jpg")).toThrow(/in use/);
      expect(fs.existsSync(path.join(root, "legacy.jpg"))).toBe(true);
      expect(fs.existsSync(path.join(root, "bound.jpg"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
