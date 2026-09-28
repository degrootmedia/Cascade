/**
 * Video stills — saving the frame a video is paused on as a new
 * `Video still_NN` image reference. The ffmpeg seam is faked (no binary
 * needed): the fake `run` writes dummy JPEG bytes to the output path.
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

import { saveVideoStillAsReference } from "../src/main/pipeline.js";
import { extractVideoStillFrame, videoStillName } from "../src/main/video-still.js";

function makeProduction(folder: string, references: Production["references"] = []): Production {
  const shot: ProductionShot = { id: "shot-0100", number: "0100", audio: "", visual: "" };
  return {
    meta: { id: "prod-1", name: "Test", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 1 },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: [{ number: 1, title: "S1", shots: [shot] }],
    characters: [],
    products: [],
    references,
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
  } as Production;
}

function fakeDeps(captured: string[][], bytes = "still-jpeg") {
  return {
    resolveBin: async () => "ffmpeg",
    run: async (_bin: string, argv: string[]) => {
      captured.push(argv);
      fs.writeFileSync(argv[argv.length - 1], Buffer.from(bytes));
    },
  };
}

describe("videoStillName", () => {
  it("starts at Video still_00 and skips taken suffixes (case-insensitive)", () => {
    expect(videoStillName([])).toBe("Video still_00");
    expect(videoStillName(["Video still_00"])).toBe("Video still_01");
    expect(videoStillName(["video STILL_00", "Video still_01"])).toBe("Video still_02");
  });
});

describe("extractVideoStillFrame", () => {
  it("seeks accurately (output seek after -i) at the paused timestamp", async () => {
    const captured: string[][] = [];
    const jpeg = await extractVideoStillFrame("/v/clip.mp4", 12.5, fakeDeps(captured));
    expect(jpeg.toString()).toBe("still-jpeg");
    const argv = captured[0];
    // Accurate output seek: -ss comes AFTER -i (unlike the poster's fast input seek).
    expect(argv.indexOf("-ss")).toBeGreaterThan(argv.indexOf("-i"));
    expect(argv[argv.indexOf("-ss") + 1]).toBe("12.5");
    expect(argv).toContain("-frames:v");
  });

  it("clamps a negative timestamp to the first frame", async () => {
    const captured: string[][] = [];
    await extractVideoStillFrame("/v/clip.mp4", -3, fakeDeps(captured));
    expect(captured[0][captured[0].indexOf("-ss") + 1]).toBe("0");
  });

  it("rejects when no ffmpeg binary is available", async () => {
    await expect(
      extractVideoStillFrame("/v/clip.mp4", 1, { resolveBin: async () => null, run: async () => {} }),
    ).rejects.toThrow(/no video encoder/i);
  });
});

describe("saveVideoStillAsReference", () => {
  it("stores the extracted frame as an image reference named Video still_00", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-still-"));
    try {
      const src = path.join(root, "boards/0100/video/clip.mp4");
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.writeFileSync(src, "clip-bytes");
      const p = makeProduction(root);
      const captured: string[][] = [];

      const ref = await saveVideoStillAsReference(p, "boards/0100/video/clip.mp4", 4.25, fakeDeps(captured));

      expect(ref.name).toBe("Video still_00");
      expect(ref.imagePath).toBe("references/Video still_00.jpg");
      expect(ref.media).toBeUndefined();
      expect(p.references).toHaveLength(1);
      expect(fs.readFileSync(path.join(root, ref.imagePath!), "utf8")).toBe("still-jpeg");
      // The source clip is untouched.
      expect(fs.readFileSync(src, "utf8")).toBe("clip-bytes");

      // A second still gets the next suffix.
      const ref2 = await saveVideoStillAsReference(p, "boards/0100/video/clip.mp4", 1, fakeDeps(captured));
      expect(ref2.name).toBe("Video still_01");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when the video isn't on disk", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-still-"));
    try {
      const p = makeProduction(root);
      const captured: string[][] = [];
      await expect(saveVideoStillAsReference(p, "boards/missing.mp4", 1, fakeDeps(captured))).rejects.toThrow(/isn't on disk/);
      expect(p.references ?? []).toHaveLength(0);
      expect(captured).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
