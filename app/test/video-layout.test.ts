/**
 * video-layout tests — where generated clips live. Every provider routes its
 * finished clip through `writeShotVideo`, which drops it in the shot's own
 * board folder under `video/` (`boards/0100/video/shot-0100-<tag>.mp4`), beside
 * that shot's frames. `relocateVideoLayout` moves the legacy flat
 * `videos/shot-<number>-*.mp4` files into that folder and rewrites every shot
 * field that referenced them.
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

import { relocateBoardsForRenumber, relocateVideoLayout, shotVideoDir, shotVideoRelPath, writeShotVideo } from "../src/main/pipeline.js";

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

describe("shotVideoDir / shotVideoRelPath / writeShotVideo", () => {
  it("names clips inside the shot's board folder under video/", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-video-layout-"));
    try {
      const shot = makeShot("0100");
      const p = makeProduction(root, [shot]);
      expect(shotVideoDir(p, shot)).toBe("boards/0100/video");
      expect(shotVideoRelPath(p, shot)).toMatch(/^boards\/0100\/video\/shot-0100-[a-z0-9]+\.mp4$/);
      expect(shotVideoRelPath(p, shot, "webm", "edit")).toMatch(/^boards\/0100\/video\/shot-0100-edit-[a-z0-9]+\.webm$/);

      const rel = writeShotVideo(p, shot, Buffer.from("clip-bytes"), "mp4");
      expect(rel).toMatch(/^boards\/0100\/video\/shot-0100-[a-z0-9]+\.mp4$/);
      expect(fs.readFileSync(path.join(root, rel), "utf8")).toBe("clip-bytes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("relocateVideoLayout", () => {
  it("moves every legacy flat clip into the shot's video/ folder and rewrites the references", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-video-relocate-"));
    try {
      const shot = makeShot("0100", {
        videoPath: "videos/shot-0100-clip.mp4",
        graphVideoGens: [{ path: "videos/shot-0100-clip.mp4", prompt: "p", model: "m", at: "" }],
        graphEditVideoGens: [{ path: "videos/shot-0100-edit-x.mp4", prompt: "e", model: "m", at: "" }],
        graphTweenOutput: "videos/shot-0100-tween-t.mp4",
        graphTweenBlocks: [
          { id: "tw0", startRefId: "a", endRefId: "b", prompt: "turn", startSec: 0, durationSec: 2, gens: [{ path: "videos/shot-0100-b0.mp4", prompt: "", model: "", at: "" }], genIndex: 0 },
        ],
      });
      const p = makeProduction(root, [shot]);
      const legacy = ["clip.mp4", "edit-x.mp4", "tween-t.mp4", "b0.mp4"];
      fs.mkdirSync(path.join(root, "videos"), { recursive: true });
      for (const f of legacy) fs.writeFileSync(path.join(root, "videos", `shot-0100-${f}`), "bytes");

      expect(relocateVideoLayout(p, shot)).toBe(true);

      expect(shot.videoPath).toBe("boards/0100/video/shot-0100-clip.mp4");
      expect(shot.graphVideoGens![0].path).toBe("boards/0100/video/shot-0100-clip.mp4");
      expect(shot.graphEditVideoGens![0].path).toBe("boards/0100/video/shot-0100-edit-x.mp4");
      expect(shot.graphTweenOutput).toBe("boards/0100/video/shot-0100-tween-t.mp4");
      expect(shot.graphTweenBlocks![0].gens![0].path).toBe("boards/0100/video/shot-0100-b0.mp4");
      for (const f of legacy) {
        expect(fs.existsSync(path.join(root, "boards", "0100", "video", `shot-0100-${f}`))).toBe(true);
        expect(fs.existsSync(path.join(root, "videos", `shot-0100-${f}`))).toBe(false);
      }

      // Idempotent: a second pass finds nothing flat left to move.
      expect(relocateVideoLayout(p, shot)).toBe(false);
      expect(shot.videoPath).toBe("boards/0100/video/shot-0100-clip.mp4");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves another shot's clip and non-video paths alone", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-video-other-"));
    try {
      fs.mkdirSync(path.join(root, "videos"), { recursive: true });
      fs.writeFileSync(path.join(root, "videos", "shot-0200-clip.mp4"), "bytes");
      const shot = makeShot("0100", {
        videoPath: "videos/shot-0200-clip.mp4",
        graphVideoGens: [{ path: "boards/0100/video/shot-0100-old.mp4", prompt: "", model: "", at: "" }],
      });
      const p = makeProduction(root, [shot]);

      expect(relocateVideoLayout(p, shot)).toBe(false);
      expect(shot.videoPath).toBe("videos/shot-0200-clip.mp4");
      expect(shot.graphVideoGens![0].path).toBe("boards/0100/video/shot-0100-old.mp4");
      expect(fs.existsSync(path.join(root, "videos", "shot-0200-clip.mp4"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("relocateBoardsForRenumber (video clips)", () => {
  it("moves a shot's video/ folder with the board folder and patches every clip path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-video-renumber-"));
    try {
      const shot = makeShot("0100", {
        videoPath: "boards/0100/video/shot-0100-clip.mp4",
        graphVideoGens: [{ path: "boards/0100/video/shot-0100-clip.mp4", prompt: "", model: "", at: "" }],
        graphEditVideoGens: [{ path: "boards/0100/video/shot-0100-edit.mp4", prompt: "", model: "", at: "" }],
        graphTweenOutput: "boards/0100/video/shot-0100-tween.mp4",
        graphTweenBlocks: [
          { id: "tw0", startRefId: "a", endRefId: "b", prompt: "", startSec: 0, durationSec: 2, gens: [{ path: "boards/0100/video/shot-0100-b0.mp4", prompt: "", model: "", at: "" }], genIndex: 0 },
        ],
      });
      const p = makeProduction(root, [shot]);
      const videoDir = path.join(root, "boards", "0100", "video");
      fs.mkdirSync(videoDir, { recursive: true });
      for (const f of ["clip.mp4", "edit.mp4", "tween.mp4", "b0.mp4"]) {
        fs.writeFileSync(path.join(videoDir, `shot-0100-${f}`), "bytes");
      }

      shot.number = "0200";
      relocateBoardsForRenumber(p, new Map([[shot.id, "0100"]]));

      expect(shot.videoPath).toBe("boards/0200/video/shot-0200-clip.mp4");
      expect(shot.graphVideoGens![0].path).toBe("boards/0200/video/shot-0200-clip.mp4");
      expect(shot.graphEditVideoGens![0].path).toBe("boards/0200/video/shot-0200-edit.mp4");
      expect(shot.graphTweenOutput).toBe("boards/0200/video/shot-0200-tween.mp4");
      expect(shot.graphTweenBlocks![0].gens![0].path).toBe("boards/0200/video/shot-0200-b0.mp4");
      for (const f of ["clip.mp4", "edit.mp4", "tween.mp4", "b0.mp4"]) {
        expect(fs.existsSync(path.join(root, "boards", "0200", "video", `shot-0200-${f}`))).toBe(true);
      }
      expect(fs.existsSync(path.join(root, "boards", "0100"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
