/**
 * Save as reference — copying a stored generation (image or clip) into the
 * production's referencesDir as a new "Saved Ref_NN" reference. The copy is
 * independent of the source file so deleting the generation later can't orphan
 * the reference.
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

import { saveGenerationAsReference, savedRefName } from "../src/main/pipeline.js";

function makeShot(number: string, overrides: Partial<ProductionShot> = {}): ProductionShot {
  return { id: `shot-${number}`, number, audio: "", visual: `Visual ${number}`, ...overrides };
}

function makeProduction(folder: string, shots: ProductionShot[], references: Production["references"] = []): Production {
  return {
    meta: { id: "prod-1", name: "Test", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: shots.length },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: shots.map((shot) => ({ number: 1, title: "S1", shots: [shot] })),
    characters: [],
    products: [],
    references,
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
  } as Production;
}

describe("savedRefName", () => {
  it("starts at Saved Ref_00 and skips taken suffixes (case-insensitive)", () => {
    expect(savedRefName([])).toBe("Saved Ref_00");
    expect(savedRefName(["Saved Ref_00"])).toBe("Saved Ref_01");
    expect(savedRefName(["saved ref_00", "Saved Ref_01"])).toBe("Saved Ref_02");
  });
});

describe("saveGenerationAsReference", () => {
  it("copies the frame into referencesDir and appends an image reference", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-save-ref-"));
    try {
      const src = path.join(root, "boards/0100/shot-0100-tag.jpg");
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.writeFileSync(src, "frame-bytes");
      const shot = makeShot("0100", { graphImageGens: [{ path: "boards/0100/shot-0100-tag.jpg", prompt: "", model: "m", at: "" }] });
      const p = makeProduction(root, [shot]);

      const ref = saveGenerationAsReference(p, "boards/0100/shot-0100-tag.jpg");

      expect(ref.name).toBe("Saved Ref_00");
      expect(ref.imagePath).toBe("references/Saved Ref_00.jpg");
      expect(ref.media).toBeUndefined();
      expect(p.references).toHaveLength(1);
      expect(fs.readFileSync(path.join(root, ref.imagePath!), "utf8")).toBe("frame-bytes");
      // The source generation is untouched (the copy is independent).
      expect(fs.existsSync(src)).toBe(true);

      // A second save gets the next suffix.
      const ref2 = saveGenerationAsReference(p, "boards/0100/shot-0100-tag.jpg");
      expect(ref2.name).toBe("Saved Ref_01");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores a clip as a video reference with mediaPath", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-save-ref-"));
    try {
      const src = path.join(root, "boards/0100/video/clip.mp4");
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.writeFileSync(src, "clip-bytes");
      const p = makeProduction(root, []);

      const ref = saveGenerationAsReference(p, "boards/0100/video/clip.mp4");

      expect(ref.media).toBe("video");
      expect(ref.mediaPath).toBe("references/Saved Ref_00.mp4");
      expect(ref.imagePath).toBeUndefined();
      expect(fs.readFileSync(path.join(root, ref.mediaPath!), "utf8")).toBe("clip-bytes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when the file isn't on disk", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-save-ref-"));
    try {
      const p = makeProduction(root, []);
      expect(() => saveGenerationAsReference(p, "boards/missing.jpg")).toThrow(/isn't on disk/);
      expect(p.references ?? []).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
