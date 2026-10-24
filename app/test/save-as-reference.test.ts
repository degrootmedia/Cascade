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

function makeProduction(folder: string, shots: ProductionShot[], references: Production["references"] = [], referenceCategories: Production["referenceCategories"] = []): Production {
  return {
    meta: { id: "prod-1", name: "Test", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: shots.length },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: shots.map((shot) => ({ number: 1, title: "S1", shots: [shot] })),
    characters: [],
    products: [],
    references,
    referenceCategories,
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
  } as Production;
}

describe("savedRefName", () => {
  it("starts at Saved Ref_001 and skips taken suffixes (case-insensitive)", () => {
    expect(savedRefName([])).toBe("Saved Ref_001");
    expect(savedRefName(["Saved Ref_001"])).toBe("Saved Ref_002");
    expect(savedRefName(["saved ref_001", "Saved Ref_002"])).toBe("Saved Ref_003");
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

      expect(ref.name).toBe("Saved Ref_001");
      expect(ref.imagePath).toBe("references/Saved Ref_001.jpg");
      expect(ref.media).toBeUndefined();
      expect(p.references).toHaveLength(1);
      expect(fs.readFileSync(path.join(root, ref.imagePath!), "utf8")).toBe("frame-bytes");
      // The source generation is untouched (the copy is independent).
      expect(fs.existsSync(src)).toBe(true);

      // A second save gets the next suffix.
      const ref2 = saveGenerationAsReference(p, "boards/0100/shot-0100-tag.jpg");
      expect(ref2.name).toBe("Saved Ref_002");
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
      expect(ref.mediaPath).toBe("references/Saved Ref_001.mp4");
      expect(ref.imagePath).toBeUndefined();
      expect(fs.readFileSync(path.join(root, ref.mediaPath!), "utf8")).toBe("clip-bytes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors a popup-chosen name + category, sanitizing and de-duplicating", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-save-ref-"));
    try {
      const src = path.join(root, "boards/0100/shot.jpg");
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.writeFileSync(src, "frame-bytes");
      const existing = [{ id: "r1", name: "Hero pose", imagePath: "references/hero.jpg", shotIds: [] }];
      const p = makeProduction(root, [], existing, [{ id: "cat-1", name: "Characters" }]);

      const ref = saveGenerationAsReference(p, "boards/0100/shot.jpg", { name: "Hero [pose]", categoryId: "cat-1" });
      // Brackets are tag-hostile (sanitized away); the name then collides
      // with the existing reference and is de-duplicated.
      expect(ref.name).toBe("Hero pose_dup");
      expect(ref.categoryId).toBe("cat-1");
      expect(ref.imagePath).toBe("references/Hero pose_dup.jpg");

      // An unknown category falls back to uncategorized.
      const ref2 = saveGenerationAsReference(p, "boards/0100/shot.jpg", { name: "Second", categoryId: "nope" });
      expect(ref2.name).toBe("Second");
      expect(ref2.categoryId).toBeUndefined();
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
