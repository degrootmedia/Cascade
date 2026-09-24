/**
 * outdated-shots tests — re-ingesting a script must never overwrite the
 * previous panels. `archiveShotsToOutdated` moves each old panel's board folder
 * to `boards/outdated/<id>/` (so a fresh shot re-using the number can't
 * collide), rewrites every media path, and appends it to `outdatedShots`;
 * `restoreOutdatedShot` pulls one back with a fresh number; `removeOutdatedShot`
 * drops it and its files. Batches accumulate.
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

import { archiveShotsToOutdated, restoreOutdatedShot, removeOutdatedShot } from "../src/main/pipeline.js";

function makeShot(number: string, overrides: Partial<ProductionShot> = {}): ProductionShot {
  return { id: `shot-${number}`, number, audio: "", visual: `Visual ${number}`, ...overrides };
}

function makeProduction(folder: string, scenes: Production["scenes"], outdatedShots?: ProductionShot[]): Production {
  return {
    meta: { id: "prod-1", name: "Test", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes,
    outdatedShots,
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

function exists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

describe("outdated panels (script re-ingest preservation)", () => {
  it("archives a panel: relocates its board folder and rewrites every media path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-outdated-archive-"));
    try {
      const shot = makeShot("0100", {
        id: "a",
        artwork: "boards/0100/shot-0100-a-edit.jpg",
        artworkHistory: ["boards/0100/shot-0100-a-pure.jpg"],
        graphImageGens: [{ path: "boards/0100/shot-0100-a-pure.jpg", prompt: "p", model: "m", at: "" }],
        graphImageGenIndex: 0,
        graphEditNodes: [{ id: "edit0", prompt: "night", gens: [{ path: "boards/0100/shot-0100-a-edit.jpg", prompt: "night", model: "m", at: "" }], genIndex: 0 }],
        graphOutputSource: "editgen",
        graphOutputEditNodeId: "edit0",
        videoPath: "boards/0100/video/shot-0100-a-clip.mp4",
        graphVideoGens: [{ path: "boards/0100/video/shot-0100-a-clip.mp4", prompt: "v", model: "m", at: "" }],
      });
      const p = makeProduction(root, [{ number: 1, title: "S1", shots: [shot] }]);
      write(root, "boards/0100/shot-0100-a-pure.jpg", "A-pure");
      write(root, "boards/0100/shot-0100-a-edit.jpg", "A-edit");
      write(root, "boards/0100/originals/shot-0100-a-pure.png", "A-orig");
      write(root, "boards/0100/video/shot-0100-a-clip.mp4", "A-clip");

      const archived = archiveShotsToOutdated(p, p.scenes.flatMap((s) => s.shots));

      expect(archived).toBe(1);
      expect(shot.outdated).toBe(true);
      expect(typeof shot.outdatedAt).toBe("string");
      // Folder + filenames keep the old number, only the folder root changes.
      expect(shot.artwork).toBe("boards/outdated/a/shot-0100-a-edit.jpg");
      expect(shot.artworkHistory).toEqual(["boards/outdated/a/shot-0100-a-pure.jpg"]);
      expect(shot.graphImageGens![0].path).toBe("boards/outdated/a/shot-0100-a-pure.jpg");
      expect(shot.graphEditNodes![0].gens![0].path).toBe("boards/outdated/a/shot-0100-a-edit.jpg");
      expect(shot.videoPath).toBe("boards/outdated/a/video/shot-0100-a-clip.mp4");
      expect(shot.graphVideoGens![0].path).toBe("boards/outdated/a/video/shot-0100-a-clip.mp4");
      expect(p.outdatedShots!.map((s) => s.id)).toEqual(["a"]);
      // Bytes moved with the paths.
      expect(read(root, "boards/outdated/a/shot-0100-a-edit.jpg")).toBe("A-edit");
      expect(read(root, "boards/outdated/a/originals/shot-0100-a-pure.png")).toBe("A-orig");
      expect(read(root, "boards/outdated/a/video/shot-0100-a-clip.mp4")).toBe("A-clip");
      expect(exists(root, "boards/0100")).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("frees the old number: a fresh shot re-using it cannot overwrite the archived frame", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-outdated-reuse-"));
    try {
      const shot = makeShot("0100", { id: "a", artwork: "boards/0100/shot-0100-a.jpg" });
      const p = makeProduction(root, [{ number: 1, title: "S1", shots: [shot] }]);
      write(root, "boards/0100/shot-0100-a.jpg", "OLD");

      archiveShotsToOutdated(p, p.scenes.flatMap((s) => s.shots));

      // The new ingest's shot lands on the same number and generates its frame.
      write(root, "boards/0100/shot-0100-fresh.jpg", "FRESH");

      expect(read(root, "boards/outdated/a/shot-0100-a.jpg")).toBe("OLD");
      expect(read(root, "boards/0100/shot-0100-fresh.jpg")).toBe("FRESH");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores a panel with a fresh number and moves its files back", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-outdated-restore-"));
    try {
      const shot = makeShot("0100", { id: "a", artwork: "boards/0100/shot-0100-a.jpg", audio: "line", visual: "wide" });
      const p = makeProduction(root, [{ number: 1, title: "S1", shots: [shot] }]);
      write(root, "boards/0100/shot-0100-a.jpg", "A");
      archiveShotsToOutdated(p, p.scenes.flatMap((s) => s.shots));

      // A new breakdown replaced the storyboard with a shot on 0100.
      p.scenes = [{ number: 1, title: "S1", shots: [makeShot("0100", { id: "live" })] }];

      const restored = restoreOutdatedShot(p, "a");

      expect(restored.number).toBe("0200");
      expect(restored.outdated).toBeUndefined();
      expect(restored.outdatedAt).toBeUndefined();
      expect(restored.artwork).toBe("boards/0200/shot-0200-a.jpg");
      expect(read(root, "boards/0200/shot-0200-a.jpg")).toBe("A");
      expect(exists(root, "boards/outdated/a")).toBe(false);
      // Appended to the end of the last scene; bucket emptied.
      expect(p.scenes[0].shots.map((s) => s.id)).toEqual(["live", "a"]);
      expect(p.outdatedShots).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes a panel and deletes its preserved files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-outdated-remove-"));
    try {
      const shot = makeShot("0100", { id: "a", artwork: "boards/0100/shot-0100-a.jpg" });
      const p = makeProduction(root, [{ number: 1, title: "S1", shots: [shot] }]);
      write(root, "boards/0100/shot-0100-a.jpg", "A");
      archiveShotsToOutdated(p, p.scenes.flatMap((s) => s.shots));

      removeOutdatedShot(p, "a");

      expect(p.outdatedShots).toEqual([]);
      expect(exists(root, "boards/outdated/a")).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("archives a text-only panel (no board folder) without error", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-outdated-textonly-"));
    try {
      const shot = makeShot("0100", { id: "a", audio: "hello", visual: "world" });
      const p = makeProduction(root, [{ number: 1, title: "S1", shots: [shot] }]);

      expect(() => archiveShotsToOutdated(p, p.scenes.flatMap((s) => s.shots))).not.toThrow();
      expect(p.outdatedShots![0]).toMatchObject({ id: "a", outdated: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accumulates batches across repeated re-ingests", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-outdated-accum-"));
    try {
      const a = makeShot("0100", { id: "a" });
      const b = makeShot("0100", { id: "b" });
      const p = makeProduction(root, [{ number: 1, title: "S1", shots: [a] }]);

      archiveShotsToOutdated(p, [a]);
      p.scenes = [{ number: 1, title: "S1", shots: [b] }];
      archiveShotsToOutdated(p, [b]);

      expect(p.outdatedShots!.map((s) => s.id)).toEqual(["a", "b"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
