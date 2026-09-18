/**
 * board-video-drop tests — dropping a video file onto a storyboard panel.
 * `importBoardVideo` saves the clip as a reference video and pipes it into
 * the frame output: the same end state as dragging the clip into the node
 * graph (reference node) and wiring it to the output node (videoPath).
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

import { importBoardVideo } from "../src/main/pipeline.js";

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
  };
}

const noop = () => {};

describe("importBoardVideo", () => {
  it("saves the clip as a reference video piped to the output", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-board-video-"));
    try {
      const shot = makeShot("0100", { artwork: "boards/0100/shot-0100-old.jpg" });
      const p = makeProduction(root, [shot]);
      importBoardVideo(p, shot.id, "take-1.mp4", "video/mp4", Buffer.from("clip-bytes"), noop);

      const refs = p.references ?? [];
      expect(refs).toHaveLength(1);
      expect(refs[0].media).toBe("video");
      expect(refs[0].mediaPath).toBe("references/take-1.mp4");
      expect(fs.readFileSync(path.join(root, refs[0].mediaPath!), "utf8")).toBe("clip-bytes");

      expect(shot.graphOutputSource).toBe("ref");
      expect(shot.graphOutputRefId).toBe(refs[0].id);
      expect(shot.videoPath).toBe(refs[0].mediaPath);
      // The stale still clears (mirrors pipeRefToOutput); the frame's
      // generation history is untouched so it can be re-piped.
      expect(shot.artwork).toBeUndefined();
      // The ref node is placed on the canvas so the output edge renders.
      expect(shot.graphLayout?.positions?.[`ref:${refs[0].id}`]).toEqual({ x: 0, y: 116 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("collision-handles a repeated filename", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-board-video-"));
    try {
      const shot = makeShot("0100");
      const p = makeProduction(root, [shot]);
      importBoardVideo(p, shot.id, "take-1.mp4", "video/mp4", Buffer.from("one"), noop);
      importBoardVideo(p, shot.id, "take-1.mp4", "video/mp4", Buffer.from("two"), noop);

      const paths = (p.references ?? []).map((r) => r.mediaPath);
      expect(paths).toEqual(["references/take-1.mp4", "references/take-1 (2).mp4"]);
      expect(fs.readFileSync(path.join(root, paths[1]!), "utf8")).toBe("two");
      // The latest drop owns the output, stacked below the first node.
      expect(shot.videoPath).toBe(paths[1]);
      const ids = (p.references ?? []).map((r) => r.id);
      expect(shot.graphOutputRefId).toBe(ids[1]);
      expect(shot.graphLayout?.positions?.[`ref:${ids[0]}`]).toEqual({ x: 0, y: 116 });
      expect(shot.graphLayout?.positions?.[`ref:${ids[1]}`]).toEqual({ x: 0, y: 244 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects non-video mime types and unknown shots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-board-video-"));
    try {
      const shot = makeShot("0100");
      const p = makeProduction(root, [shot]);
      expect(() => importBoardVideo(p, shot.id, "frame.png", "image/png", Buffer.from("x"), noop)).toThrow(
        "Only video files can be dropped as clips."
      );
      expect(() => importBoardVideo(p, "nope", "take-1.mp4", "video/mp4", Buffer.from("x"), noop)).toThrow(
        "Shot not found."
      );
      expect(() => importBoardVideo(p, shot.id, "take-1.mp4", "video/mp4", Buffer.alloc(0), noop)).toThrow(
        "The video is empty."
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
