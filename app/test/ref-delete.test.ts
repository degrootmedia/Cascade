/**
 * ref-delete tests — Design-page delete removes the reference entirely:
 * JSON entry, on-disk files, and every node + connection it had across all
 * shots (output pipe, video sources, tween keyframes, edit-node sources,
 * prompt tags, canvas placement). Board frames are independent copies under
 * boards/ and stay; a piped clip pointed at the deleted file and can't.
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

import { deleteReference } from "../src/main/pipeline.js";

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
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models", videosDir: "videos" },
  } as Production;
}

const noop = () => {};

function writeFile(root: string, rel: string, content = "bytes"): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("deleteReference", () => {
  it("removes the entry, files, and every node + connection across shots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-ref-delete-"));
    try {
      writeFile(root, "references/hero.png", "img");
      writeFile(root, "references/sidekick.png", "img2");
      const shot = makeShot("0100", {
        artwork: "boards/0100/shot-0100-old.jpg",
        prompt: "@[Hero] standing in the valley",
        graphVideoPrompt: "slow push in @[Hero]",
        graphEditPrompt: "next edit",
        graphEditVideoPrompt: "grade @[Hero]",
        graphOutputSource: "ref",
        graphOutputRefId: "r1",
        graphVideoSourceRefId: "r1",
        graphVideoRefIds: ["r1", "r2"],
        graphEditVideoSourceRefId: "r1",
        graphEditVideoRefIds: ["r1"],
        graphTweenRefIds: ["r1", "r2"],
        graphTweenBlocks: [
          { id: "tw0", startRefId: "r1", endRefId: "r2", prompt: "turn", startSec: 0, durationSec: 2 },
        ],
        graphEditNodes: [
          { id: "edit0", prompt: "make it night @[Hero]", source: { kind: "ref", refId: "r1" } },
        ],
        refIds: ["r1"],
        refExcluded: ["r1"],
        refPromptOverrides: { r1: "override" },
        graphLayout: {
          positions: { "ref:r1": { x: 0, y: 116 }, composer: { x: 620, y: 20 } },
          sizes: { "ref:r1": { width: 100, height: 100 } },
        },
      });
      // A second shot piped to the same ref with its own generated clip: the
      // pipe unbinds but the unrelated clip survives.
      const other = makeShot("0200", {
        videoPath: "boards/0200/video/shot-0200-x.mp4",
        graphOutputSource: "ref",
        graphOutputRefId: "r1",
      });
      const p = makeProduction(root, [shot, other]);
      p.references = [
        { id: "r1", name: "Hero", imagePath: "references/hero.png", shotIds: [] },
        { id: "r2", name: "Sidekick", imagePath: "references/sidekick.png", shotIds: [] },
      ];
      (p as unknown as Record<string, unknown>).magicPrompts = { "shot-0100": "hello @[Hero]" };

      deleteReference(p, "r1", noop);

      // Entry + file gone, survivor untouched.
      expect((p.references ?? []).map((r) => r.id)).toEqual(["r2"]);
      expect(fs.existsSync(path.join(root, "references/hero.png"))).toBe(false);
      expect(fs.existsSync(path.join(root, "references/sidekick.png"))).toBe(true);

      // Output pipe unbound on both shots; the piped still moves into frame
      // history (recoverable via Make Primary) instead of staying active
      // in the frame render; unrelated clip stays.
      expect(shot.graphOutputSource).toBeUndefined();
      expect(shot.graphOutputRefId).toBeUndefined();
      expect(shot.artwork).toBeUndefined();
      expect(shot.artworkHistory).toContain("boards/0100/shot-0100-old.jpg");
      expect(other.graphOutputSource).toBeUndefined();
      expect(other.videoPath).toBe("boards/0200/video/shot-0200-x.mp4");

      // Sources + extra inputs cleared/filtered.
      expect(shot.graphVideoSourceRefId).toBeUndefined();
      expect(shot.graphEditVideoSourceRefId).toBeUndefined();
      expect(shot.graphVideoRefIds).toEqual(["r2"]);
      expect(shot.graphEditVideoRefIds).toEqual([]);

      // Tween keyframes re-derived (surviving pair histories preserved).
      expect(shot.graphTweenRefIds).toEqual(["r2"]);
      expect(shot.graphTweenBlocks).toEqual([]);

      // Edit-node source cleared, tag stripped.
      expect(shot.graphEditNodes?.[0].source).toBeUndefined();
      expect(shot.graphEditNodes?.[0].prompt).not.toContain("@[Hero]");

      // Attach lists filtered.
      expect(shot.refIds).toEqual([]);
      expect(shot.refExcluded).toEqual([]);
      expect(shot.refPromptOverrides).toEqual({});

      // Prompt tags stripped everywhere.
      expect(shot.prompt).not.toContain("@[Hero]");
      expect(shot.graphVideoPrompt).not.toContain("@[Hero]");
      expect(shot.graphEditVideoPrompt).not.toContain("@[Hero]");
      expect((p as unknown as Record<string, { [k: string]: string }>).magicPrompts["shot-0100"]).not.toContain("@[Hero]");

      // Canvas placement forgotten, other nodes kept.
      expect(shot.graphLayout?.positions?.["ref:r1"]).toBeUndefined();
      expect(shot.graphLayout?.positions?.composer).toEqual({ x: 620, y: 20 });
      expect(shot.graphLayout?.sizes?.["ref:r1"]).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears a piped videoPath that pointed at the deleted file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-ref-delete-"));
    try {
      writeFile(root, "references/clip.mp4", "clip");
      const shot = makeShot("0100", {
        videoPath: "references/clip.mp4",
        graphOutputSource: "ref",
        graphOutputRefId: "r1",
      });
      const p = makeProduction(root, [shot]);
      p.references = [{ id: "r1", name: "Clip", media: "video", mediaPath: "references/clip.mp4", shotIds: [] }];

      deleteReference(p, "r1", noop);

      expect(shot.videoPath).toBeUndefined();
      expect(shot.graphOutputSource).toBeUndefined();
      expect(shot.graphOutputRefId).toBeUndefined();
      expect(fs.existsSync(path.join(root, "references/clip.mp4"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws for an unknown id and leaves state untouched", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-ref-delete-"));
    try {
      writeFile(root, "references/hero.png", "img");
      const shot = makeShot("0100");
      const p = makeProduction(root, [shot]);
      p.references = [{ id: "r1", name: "Hero", imagePath: "references/hero.png", shotIds: [] }];

      expect(() => deleteReference(p, "nope", noop)).toThrow("Reference not found.");
      expect((p.references ?? []).map((r) => r.id)).toEqual(["r1"]);
      expect(fs.existsSync(path.join(root, "references/hero.png"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
