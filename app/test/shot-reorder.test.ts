/**
 * shot-reorder tests — dragging shots on the storyboard / script page must
 * keep every frame with its shot. Covers the full handler path
 * (shotter.reorderShot → relocateBoardsForRenumber): permuted board folders
 * move without colliding, pure generations and edited frames never cross-wire
 * between shots, legacy flat files follow individually, dangling links don't
 * block the reorder, and a failed move rolls back instead of saving a
 * half-moved production.
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

import { reorderShot } from "../src/main/shotter.js";
import { relocateBoardsForRenumber } from "../src/main/pipeline.js";

function makeShot(number: string, overrides: Partial<ProductionShot> = {}): ProductionShot {
  return { id: `shot-${number}`, number, audio: "", visual: `Visual ${number}`, ...overrides };
}

function makeProduction(folder: string, scenes: Production["scenes"]): Production {
  return {
    meta: { id: "prod-1", name: "Test", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes,
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
  };
}

function write(root: string, rel: string, bytes: string) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

describe("shot reorder keeps frames with their shots", () => {
  it("swaps two shots across scenes without cross-wiring pure and edited frames", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-shot-swap-"));
    try {
      const shotA = makeShot("0100", {
        id: "a",
        artwork: "boards/0100/shot-0100-a-edit.jpg",
        artworkHistory: ["boards/0100/shot-0100-a-pure.jpg"],
        graphImageGens: [{ path: "boards/0100/shot-0100-a-pure.jpg", prompt: "pure", model: "m", at: "" }],
        graphImageGenIndex: 0,
        graphEditNodes: [{
          id: "edit0",
          prompt: "night",
          gens: [{ path: "boards/0100/shot-0100-a-edit.jpg", prompt: "night", model: "m", at: "" }],
          genIndex: 0,
        }],
        graphOutputSource: "editgen",
        graphOutputEditNodeId: "edit0",
        videoPath: "boards/0100/video/shot-0100-a-clip.mp4",
        graphVideoGens: [{ path: "boards/0100/video/shot-0100-a-clip.mp4", prompt: "v", model: "m", at: "" }],
      });
      const shotB = makeShot("0200", {
        id: "b",
        artwork: "boards/0200/shot-0200-b.jpg",
        graphImageGens: [{ path: "boards/0200/shot-0200-b.jpg", prompt: "b", model: "m", at: "" }],
        graphImageGenIndex: 0,
        graphOutputSource: "imagegen",
      });
      const p = makeProduction(root, [
        { number: 1, title: "S1", shots: [shotA] },
        { number: 2, title: "S2", shots: [shotB] },
      ]);
      write(root, "boards/0100/shot-0100-a-pure.jpg", "A-pure");
      write(root, "boards/0100/shot-0100-a-edit.jpg", "A-edit");
      write(root, "boards/0100/originals/shot-0100-a-pure.png", "A-orig");
      write(root, "boards/0100/video/shot-0100-a-clip.mp4", "A-clip");
      write(root, "boards/0200/shot-0200-b.jpg", "B-pure");

      // Drag B before A: B joins scene 1 as 0100, A becomes 0200.
      const { oldNumbers } = reorderShot(p.scenes, "b", "a");
      relocateBoardsForRenumber(p, oldNumbers);

      expect(p.scenes[0].shots.map((s) => s.id)).toEqual(["b", "a"]);
      expect(p.scenes[0].shots.map((s) => s.number)).toEqual(["0100", "0200"]);
      const [b, a] = p.scenes[0].shots;
      // Paths follow their shots and keep edit-vs-pure apart.
      expect(b.artwork).toBe("boards/0100/shot-0100-b.jpg");
      expect(b.graphImageGens![0].path).toBe("boards/0100/shot-0100-b.jpg");
      expect(a.artwork).toBe("boards/0200/shot-0200-a-edit.jpg");
      expect(a.artworkHistory).toEqual(["boards/0200/shot-0200-a-pure.jpg"]);
      expect(a.graphImageGens![0].path).toBe("boards/0200/shot-0200-a-pure.jpg");
      expect(a.graphEditNodes![0].gens![0].path).toBe("boards/0200/shot-0200-a-edit.jpg");
      expect(a.videoPath).toBe("boards/0200/video/shot-0200-a-clip.mp4");
      expect(a.graphVideoGens![0].path).toBe("boards/0200/video/shot-0200-a-clip.mp4");
      // File bytes moved with the paths — nothing swapped, nothing lost.
      expect(read(root, "boards/0100/shot-0100-b.jpg")).toBe("B-pure");
      expect(read(root, "boards/0200/shot-0200-a-edit.jpg")).toBe("A-edit");
      expect(read(root, "boards/0200/shot-0200-a-pure.jpg")).toBe("A-pure");
      expect(read(root, "boards/0200/originals/shot-0200-a-pure.png")).toBe("A-orig");
      expect(read(root, "boards/0200/video/shot-0200-a-clip.mp4")).toBe("A-clip");
      expect(fs.existsSync(path.join(root, "boards", "0100", "shot-0100-a-edit.jpg"))).toBe(false);
      expect(fs.existsSync(path.join(root, "boards", "0200", "shot-0200-b.jpg"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("moves a legacy flat file individually and renames it with its shot", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-shot-flat-"));
    try {
      const shot = makeShot("0100", { artwork: "boards/shot-0100-flat.jpg" });
      const p = makeProduction(root, [{ number: 1, title: "S1", shots: [shot] }]);
      write(root, "boards/shot-0100-flat.jpg", "flat-bytes");

      shot.number = "0200";
      relocateBoardsForRenumber(p, new Map([[shot.id, "0100"]]));

      expect(shot.artwork).toBe("boards/shot-0200-flat.jpg");
      expect(read(root, "boards/shot-0200-flat.jpg")).toBe("flat-bytes");
      expect(fs.existsSync(path.join(root, "boards", "shot-0100-flat.jpg"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves dangling links untouched instead of manufacturing new broken paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-shot-dangling-"));
    try {
      const shot = makeShot("0100", {
        artwork: "boards/0100/shot-0100-gone.jpg", // never existed on disk
        graphImageGens: [{ path: "boards/0100/shot-0100-real.jpg", prompt: "p", model: "m", at: "" }],
      });
      const p = makeProduction(root, [{ number: 1, title: "S1", shots: [shot] }]);
      write(root, "boards/0100/shot-0100-real.jpg", "real-bytes");

      shot.number = "0200";
      relocateBoardsForRenumber(p, new Map([[shot.id, "0100"]]));

      expect(shot.artwork).toBe("boards/0100/shot-0100-gone.jpg");
      expect(shot.graphImageGens![0].path).toBe("boards/0200/shot-0200-real.jpg");
      expect(read(root, "boards/0200/shot-0200-real.jpg")).toBe("real-bytes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite another shot's folder and rolls back", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-shot-collision-"));
    try {
      const shot = makeShot("0100", { artwork: "boards/0100/shot-0100-a.jpg" });
      const p = makeProduction(root, [{ number: 1, title: "S1", shots: [shot] }]);
      write(root, "boards/0100/shot-0100-a.jpg", "A-bytes");
      write(root, "boards/0200/unrelated.jpg", "junk");

      shot.number = "0200";
      expect(() => relocateBoardsForRenumber(p, new Map([[shot.id, "0100"]]))).toThrow(/already exists/);

      // Rollback restored the old layout; stored paths were never patched.
      expect(read(root, "boards/0100/shot-0100-a.jpg")).toBe("A-bytes");
      expect(read(root, "boards/0200/unrelated.jpg")).toBe("junk");
      expect(shot.artwork).toBe("boards/0100/shot-0100-a.jpg");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sweeps stale temp dirs from an interrupted reorder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-shot-tmp-"));
    try {
      const shot = makeShot("0100", { artwork: "boards/0100/shot-0100-a.jpg" });
      const p = makeProduction(root, [{ number: 1, title: "S1", shots: [shot] }]);
      write(root, "boards/0100/shot-0100-a.jpg", "A-bytes");
      write(root, "boards/.tmp-reorder-0100-ab12/leftover.jpg", "stale");

      shot.number = "0200";
      relocateBoardsForRenumber(p, new Map([[shot.id, "0100"]]));

      expect(fs.existsSync(path.join(root, "boards", ".tmp-reorder-0100-ab12"))).toBe(false);
      expect(shot.artwork).toBe("boards/0200/shot-0200-a.jpg");
      expect(read(root, "boards/0200/shot-0200-a.jpg")).toBe("A-bytes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
