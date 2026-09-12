/**
 * refreshBoardLinks tests — the Step 3 storyboard re-link helper. When board
 * files are moved/renamed externally (or a production folder is re-registered
 * with its JSON gone), a shot's artwork/history/node-graph generation paths can
 * point at files that no longer exist. Each broken path is repointed to the
 * newest `shot-<number>-*.jpg` in that shot's board folder; valid paths are
 * untouched.
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Production, ProductionScene, ProductionShot } from "../src/shared/ipc.js";

// pipeline.ts imports scripting.ts; the tests never call its helpers and its
// dynamic pdf-parse import doesn't resolve under Vitest — mock it away.
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { refreshBoardLinks } from "../src/main/pipeline.js";

function makeShot(number: string, overrides: Partial<ProductionShot> = {}): ProductionShot {
  return {
    id: `shot-${number}`,
    number,
    audio: "",
    visual: `Visual ${number}`,
    ...overrides,
  };
}

function makeProduction(folder: string, shots: ProductionShot[]): Production {
  return {
    meta: { id: "prod-1", name: "Test", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: shots.length },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: shots.map((shot): ProductionScene => ({ number: 1, title: "S1", shots: [shot] })),
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
  };
}

/** Make a real board folder for a shot, write two frames with the given mtimes,
 *  and return the newer frame's rel path (and its abs path). */
function boardFolder(root: string, number: string, mtimes: Array<[tag: string, mtime: number]>): { newerRel: string; olderRel: string } {
  const dir = path.join(root, "boards", number);
  fs.mkdirSync(dir, { recursive: true });
  for (const [tag, mtime] of mtimes) {
    const abs = path.join(root, "boards", number, `shot-${number}-${tag}.jpg`);
    fs.writeFileSync(abs, "fake-jpeg");
    const now = Date.now() / 1000;
    fs.utimesSync(abs, now, mtime);
  }
  const sorted = [...mtimes].sort((a, b) => b[1] - a[1]);
  const newerRel = `boards/${number}/shot-${number}-${sorted[0][0]}.jpg`;
  const olderRel = `boards/${number}/shot-${number}-${sorted[sorted.length - 1][0]}.jpg`;
  return { newerRel, olderRel };
}

describe("refreshBoardLinks", () => {
  it("repoints a broken artwork path to the newest frame in the shot's board folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-relink-"));
    const { newerRel } = boardFolder(root, "0100", [["aaa", 1_000_000_000], ["bbb", 1_000_000_100]]);
    const p = makeProduction(root, [makeShot("0100", { artwork: "boards/0100/shot-0100-gone.jpg" })]);
    const fixed = refreshBoardLinks(p);
    expect(fixed).toBe(1);
    expect(p.scenes[0].shots[0].artwork).toBe(newerRel);
  });

  it("leaves a valid artwork path untouched", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-relink-"));
    const { olderRel } = boardFolder(root, "0100", [["aaa", 1_000_000_000], ["bbb", 1_000_000_100]]);
    const p = makeProduction(root, [makeShot("0100", { artwork: olderRel })]);
    const fixed = refreshBoardLinks(p);
    expect(fixed).toBe(0);
    expect(p.scenes[0].shots[0].artwork).toBe(olderRel);
  });

  it("repoints broken history and node-graph generation paths, preserving valid ones", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-relink-"));
    const { newerRel } = boardFolder(root, "0100", [["aaa", 1_000_000_000], ["bbb", 1_000_000_100]]);
    const shot = makeShot("0100", {
      artwork: newerRel, // valid — must stay
      artworkHistory: ["boards/0100/shot-0100-old.jpg", "boards/0100/shot-0100-aaa.jpg"],
      graphImageGens: [
        { path: "boards/0100/shot-0100-gone.jpg", prompt: "", model: "", at: "" },
        { path: "boards/0100/shot-0100-aaa.jpg", prompt: "", model: "", at: "" },
      ],
      graphEditGens: [{ path: "boards/0100/shot-0100-missing.jpg", prompt: "", model: "", at: "" }],
    });
    const p = makeProduction(root, [shot]);
    const fixed = refreshBoardLinks(p);
    expect(fixed).toBe(3); // history old + image gone + edit missing
    expect(shot.artwork).toBe(newerRel);
    expect(shot.artworkHistory![0]).toBe(newerRel); // broken old history repointed
    expect(shot.artworkHistory![1]).toBe("boards/0100/shot-0100-aaa.jpg"); // valid kept
    expect(shot.graphImageGens![0].path).toBe(newerRel);
    expect(shot.graphImageGens![1].path).toBe("boards/0100/shot-0100-aaa.jpg");
    expect(shot.graphEditGens![0].path).toBe(newerRel);
  });

  it("is a no-op when no board folder exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-relink-"));
    const p = makeProduction(root, [makeShot("0100", { artwork: "boards/0100/shot-0100-gone.jpg" })]);
    const fixed = refreshBoardLinks(p);
    expect(fixed).toBe(0);
    expect(p.scenes[0].shots[0].artwork).toBe("boards/0100/shot-0100-gone.jpg");
  });

  it("adopts a file on disk when artwork is undefined, incl. png/webp and originals/", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-relink-"));
    const dir = path.join(root, "boards", "0100");
    const origDir = path.join(dir, "originals");
    fs.mkdirSync(origDir, { recursive: true });
    const pngAbs = path.join(dir, "shot-0100-aaa.png");
    const webpAbs = path.join(origDir, "shot-0100-bbb.webp");
    fs.writeFileSync(pngAbs, "fake-png");
    fs.writeFileSync(webpAbs, "fake-webp");
    const now = Date.now() / 1000;
    fs.utimesSync(pngAbs, now, 1_000_000_000);
    fs.utimesSync(webpAbs, now, 1_000_000_100); // newest lives in originals/
    const p = makeProduction(root, [makeShot("0100", { artwork: undefined })]);
    const fixed = refreshBoardLinks(p);
    expect(fixed).toBe(1);
    expect(p.scenes[0].shots[0].artwork).toBe("boards/0100/originals/shot-0100-bbb.webp");
    // Idempotent: a second run repairs nothing.
    expect(refreshBoardLinks(p)).toBe(0);
  });

  it("seeds artwork from node history when no file match exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-relink-"));
    const dir = path.join(root, "boards", "0100");
    fs.mkdirSync(dir, { recursive: true });
    // History file with a non-board name: the folder scan (shot-<n>-*.*)
    // finds nothing, so the seed must come from node history.
    fs.writeFileSync(path.join(dir, "custom-history.jpg"), "fake-jpeg");
    const shot = makeShot("0100", {
      artwork: undefined,
      graphImageGens: [{ path: "boards/0100/custom-history.jpg", prompt: "", model: "", at: "" }],
    });
    const p = makeProduction(root, [shot]);
    const fixed = refreshBoardLinks(p);
    expect(fixed).toBeGreaterThanOrEqual(1);
    expect(p.scenes[0].shots[0].artwork).toBe("boards/0100/custom-history.jpg");
  });
});