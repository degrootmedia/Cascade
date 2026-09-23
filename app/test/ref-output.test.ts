/**
 * ref-output tests — a reference piped into the frame output is copied into a
 * board frame (`applyRefToOutput`). Extracted from the `production:applyGraphRefOutput`
 * IPC handler so the external-edit refresh can re-apply a reference whose file
 * changed on disk (the storyboard frame is a copy; the node canvas reads the
 * live reference, so without the re-apply the storyboard stayed stale until the
 * pipe was toggled).
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

import { applyRefToOutput, resolveOutputRef, resolveOutputRefByPath, refreshRefCopyFromFile } from "../src/main/pipeline.js";

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
    references: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models", videosDir: "videos" },
  };
}

describe("applyRefToOutput", () => {
  it("copies an on-disk image reference into a fresh board frame", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-ref-output-"));
    try {
      const shot = makeShot("0100");
      const p = makeProduction(root, [shot]);
      fs.mkdirSync(path.join(root, "references"), { recursive: true });
      fs.writeFileSync(path.join(root, "references/hero.png"), "hero-bytes");

      const ref = { id: "ref-1", name: "Hero", imagePath: "references/hero.png" };
      const jpegRel = applyRefToOutput(p, shot, ref);

      expect(jpegRel).toMatch(/^boards\/0100\/shot-0100-[a-z0-9]+\.jpg$/);
      expect(shot.artwork).toBe(jpegRel);
      expect(fs.existsSync(path.join(root, jpegRel!))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("records the superseded frame in history", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-ref-output-"));
    try {
      const old = "boards/0100/shot-0100-old.jpg";
      const shot = makeShot("0100", { artwork: old });
      const p = makeProduction(root, [shot]);
      fs.mkdirSync(path.join(root, "references"), { recursive: true });
      fs.writeFileSync(path.join(root, "references/hero.png"), "v1");
      const ref = { id: "ref-1", name: "Hero", imagePath: "references/hero.png" };

      applyRefToOutput(p, shot, ref);
      expect(shot.artworkHistory).toContain(old);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies a video reference as videoPath and returns null", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-ref-output-"));
    try {
      const shot = makeShot("0100");
      const p = makeProduction(root, [shot]);
      const jpegRel = applyRefToOutput(p, shot, { id: "ref-v", media: "video", mediaPath: "references/clip.mp4" });
      expect(jpegRel).toBeNull();
      expect(shot.videoPath).toBe("references/clip.mp4");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when the reference has no usable media", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-ref-output-"));
    try {
      const shot = makeShot("0100");
      const p = makeProduction(root, [shot]);
      expect(() => applyRefToOutput(p, shot, { id: "ref-x" })).toThrow("no usable image");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("refreshRefCopyFromFile", () => {
  it("rewrites the board copy and its archived original in place from the reference", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-ref-output-"));
    try {
      const jpegRel = "boards/0100/shot-0100-abc.jpg";
      const originalRel = "boards/0100/originals/shot-0100-abc.png";
      fs.mkdirSync(path.join(root, "boards/0100/originals"), { recursive: true });
      fs.writeFileSync(path.join(root, jpegRel), "old-jpeg");
      fs.writeFileSync(path.join(root, originalRel), "old-original");
      fs.mkdirSync(path.join(root, "references"), { recursive: true });
      fs.writeFileSync(path.join(root, "references/hero.png"), "new-ref-bytes");
      const shot = makeShot("0100", { artwork: jpegRel });
      const p = makeProduction(root, [shot]);

      expect(refreshRefCopyFromFile(p, shot, "references/hero.png")).toBe(true);
      // Same path — the copy is refreshed in place, no new take / history entry.
      expect(shot.artwork).toBe(jpegRel);
      expect(shot.artworkHistory).toBeUndefined();
      // nativeImage is unavailable under vitest, so the raw bytes are written.
      expect(fs.readFileSync(path.join(root, jpegRel), "utf8")).toBe("new-ref-bytes");
      expect(fs.readFileSync(path.join(root, originalRel), "utf8")).toBe("new-ref-bytes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("is a no-op without a frame or a readable source", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-ref-output-"));
    try {
      const bare = makeShot("0100");
      const p1 = makeProduction(root, [bare]);
      expect(refreshRefCopyFromFile(p1, bare, "references/missing.png")).toBe(false);

      const shot = makeShot("0100", { artwork: "boards/0100/shot-0100-abc.jpg" });
      const p2 = makeProduction(root, [shot]);
      expect(refreshRefCopyFromFile(p2, shot, "references/missing.png")).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveOutputRef / resolveOutputRefByPath", () => {
  it("resolves characters, products, and custom references by id and path", () => {
    const p = makeProduction("/tmp/none", []);
    p.characters = [{ id: "char-1", name: "Ann", key: "", imagePath: "references/ann.png" }];
    p.products = [{ id: "prod-1", name: "Box", imagePath: "references/box.png" }];
    p.references = [{ id: "ref-1", name: "Mood", imagePath: "references/mood.png" }, { id: "ref-2", name: "Clip", media: "video", mediaPath: "references/clip.mp4" }];

    expect(resolveOutputRef(p, "char-1")?.imagePath).toBe("references/ann.png");
    expect(resolveOutputRef(p, "prod-1")?.id).toBe("prod-1");
    expect(resolveOutputRef(p, "ref-2")?.media).toBe("video");
    expect(resolveOutputRef(p, "nope")).toBeNull();

    expect(resolveOutputRefByPath(p, "references/mood.png")?.id).toBe("ref-1");
    expect(resolveOutputRefByPath(p, "references/clip.mp4")?.id).toBe("ref-2");
    expect(resolveOutputRefByPath(p, "boards/0100/shot-0100-x.jpg")).toBeNull();
  });
});
