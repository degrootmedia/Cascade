/**
 * Media registry + media service (architecture hardening, brief
 * recommendation 1; rollout Phase 2a).
 *
 * Pins the registry contract:
 *   - pure helpers: normalize/dedupe/remap, kind detection, path lookup;
 *   - the service is the ONE door for files: registration, moves (with the
 *     registry re-pointing so ids keep resolving), removal, missing marking,
 *     and load-time bootstrap (present/missing from disk, unreferenced
 *     entries pruned);
 *   - an interrupted move leaves the old path AND the registry untouched —
 *     recoverable, never a broken published path;
 *   - the real movers (outdated archive/restore, renumber) keep the registry
 *     in lockstep with the stored fields — a moved file still resolves from
 *     the storyboard, the canvas, and the history;
 *   - the registry is main-owned: a stale renderer save can't revert it.
 */
import { afterAll, afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Production, ProductionShot } from "../src/shared/ipc.js";
import {
  mediaEntryForPath,
  mediaKindForRel,
  normalizeMediaRegistry,
  remapMediaPaths,
  upsertMediaEntry,
  type MediaEntry,
} from "../src/shared/media-registry.js";
import { createMediaService } from "../src/main/media.js";

// pipeline.ts imports scripting.ts (whose dynamic pdf-parse import doesn't
// resolve under Vitest) — mock it away like the other pipeline suites.
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { archiveShotsToOutdated, relocateBoardsForRenumber, restoreOutdatedShot } from "../src/main/pipeline.js";

let root: string;
const resolveAbs = (p: Production, rel: string): string => {
  const abs = path.resolve(p.meta.folder, rel);
  return abs;
};
const service = createMediaService({ resolveAbs, newId: (() => { let i = 0; return () => `m${++i}`; })() });

function makeProduction(folder: string, overrides: Partial<Production> = {}): Production {
  return {
    meta: { id: "p1", name: "Prod", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: [],
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    ...overrides,
  };
}

function makeShot(id: string, number: string, overrides: Partial<ProductionShot> = {}): ProductionShot {
  return { id, number, audio: "", visual: "wide", ...overrides };
}

const write = (folder: string, rel: string, content = "bytes"): void => {
  const abs = path.join(folder, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

describe("media registry (pure)", () => {
  it("detects kind by extension", () => {
    expect(mediaKindForRel("boards/0100/shot-0100-x.jpg")).toBe("image");
    expect(mediaKindForRel("videos/a.mp4")).toBe("video");
    expect(mediaKindForRel("voiceover/vo.mp3")).toBe("audio");
    expect(mediaKindForRel("models/x.glb")).toBe("other");
  });

  it("normalize dedupes by path and drops terminal deleted entries", () => {
    const list: MediaEntry[] = [
      { id: "a", path: "x.jpg", kind: "image", origin: "generated", state: "present" },
      { id: "b", path: "x.jpg", kind: "image", origin: "generated", state: "present" },
      { id: "c", path: "y.jpg", kind: "image", origin: "generated", state: "deleted" },
      { id: "d", path: "z.jpg", kind: "image", origin: "generated", state: "missing" },
    ];
    const out = normalizeMediaRegistry(list);
    expect(out.map((e) => e.id)).toEqual(["a", "d"]);
  });

  it("remapMediaPaths re-points moved entries and keeps ids", () => {
    const list: MediaEntry[] = [{ id: "a", path: "boards/0100/f.jpg", kind: "image", origin: "generated", state: "present" }];
    const out = remapMediaPaths(list, (rel) => rel.replace("/0100/", "/0200/"));
    expect(out[0].id).toBe("a");
    expect(out[0].path).toBe("boards/0200/f.jpg");
    expect(mediaEntryForPath(out, "boards/0200/f.jpg")?.id).toBe("a");
  });

  it("upsertMediaEntry replaces by id or by path", () => {
    const base: MediaEntry[] = [{ id: "a", path: "x.jpg", kind: "image", origin: "generated", state: "present" }];
    const byId = upsertMediaEntry(base, { id: "a", path: "x2.jpg", kind: "image", origin: "generated", state: "missing" });
    expect(byId).toHaveLength(1);
    expect(byId[0].path).toBe("x2.jpg");
    const byPath = upsertMediaEntry(base, { id: "b", path: "x.jpg", kind: "image", origin: "adopted", state: "present" });
    expect(byPath).toHaveLength(1);
    expect(byPath[0].id).toBe("b");
  });
});

describe("media service (one door for files)", () => {
  beforeEach(() => {
    root = path.join(os.tmpdir(), `cascade-media-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(root, { recursive: true });
  });
  afterAll(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("register is idempotent per path", () => {
    const p = makeProduction(root);
    write(root, "boards/0100/a.jpg");
    const first = service.register(p, "boards/0100/a.jpg", "image", "generated")!;
    const second = service.register(p, "boards/0100/a.jpg", "image", "generated")!;
    expect(second.id).toBe(first.id);
    expect(p.media).toHaveLength(1);
  });

  it("moveFile re-points the registry entry so the id keeps resolving", () => {
    const p = makeProduction(root);
    write(root, "boards/0100/a.jpg");
    service.register(p, "boards/0100/a.jpg", "image", "generated");
    const moved = service.moveFile(p, "boards/0100/a.jpg", "boards/0200/a.jpg");
    expect(moved).toBe("boards/0200/a.jpg");
    expect(fs.existsSync(path.join(root, "boards/0200/a.jpg"))).toBe(true);
    expect(mediaEntryForPath(p.media, "boards/0200/a.jpg")).toBeDefined();
    expect(mediaEntryForPath(p.media, "boards/0100/a.jpg")).toBeUndefined();
  });

  it("an interrupted move is recoverable: null result, old path + registry untouched", () => {
    const p = makeProduction(root);
    // No source file on disk.
    service.register(p, "boards/0100/a.jpg", "image", "generated");
    const moved = service.moveFile(p, "boards/0100/a.jpg", "boards/0200/a.jpg");
    expect(moved).toBeNull();
    expect(mediaEntryForPath(p.media, "boards/0100/a.jpg")).toBeDefined();
    expect(fs.existsSync(path.join(root, "boards/0200/a.jpg"))).toBe(false);
  });

  it("removeFile unlinks and marks deleted (dropped by the next normalize)", () => {
    const p = makeProduction(root);
    write(root, "boards/0100/a.jpg");
    service.register(p, "boards/0100/a.jpg", "image", "generated");
    service.removeFile(p, "boards/0100/a.jpg");
    expect(fs.existsSync(path.join(root, "boards/0100/a.jpg"))).toBe(false);
    expect(mediaEntryForPath(p.media, "boards/0100/a.jpg")?.state).toBe("deleted");
    expect(normalizeMediaRegistry(p.media)).toHaveLength(0);
  });

  it("markMissing records a missing state without a file", () => {
    const p = makeProduction(root);
    service.markMissing(p, "boards/0100/ghost.jpg");
    expect(mediaEntryForPath(p.media, "boards/0100/ghost.jpg")?.state).toBe("missing");
  });

  it("bootstrap upserts referenced paths with present/missing from disk and prunes orphans", () => {
    const p = makeProduction(root);
    write(root, "boards/0100/live.jpg");
    service.register(p, "boards/0100/live.jpg", "image", "generated");
    service.register(p, "boards/0100/soon-gone.jpg", "image", "generated");
    service.bootstrap(p, ["boards/0100/live.jpg", "boards/0100/gone.jpg"]);
    expect(mediaEntryForPath(p.media, "boards/0100/live.jpg")?.state).toBe("present");
    const gone = mediaEntryForPath(p.media, "boards/0100/gone.jpg");
    expect(gone?.state).toBe("missing");
    // Unreferenced entries are garbage-collected.
    expect(mediaEntryForPath(p.media, "boards/0100/soon-gone.jpg")).toBeUndefined();
  });
});

describe("movers keep the registry in lockstep with the fields", () => {
  let prod: Production;
  beforeEach(() => {
    root = path.join(os.tmpdir(), `cascade-move-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(root, { recursive: true });
    const shot = makeShot("s1", "0100", {
      artwork: "boards/0100/shot-0100-a.jpg",
      artworkHistory: ["boards/0100/shot-0100-old.jpg"],
      graphImageGens: [
        { path: "boards/0100/shot-0100-a.jpg", prompt: "p", model: "m", at: "" },
        { path: "boards/0100/shot-0100-old.jpg", prompt: "p", model: "m", at: "" },
      ],
      graphImageGenIndex: 0,
    });
    prod = makeProduction(root, { scenes: [{ number: 1, title: "S1", shots: [shot] }] });
    write(root, shot.artwork!);
    write(root, shot.artworkHistory![0]);
    service.bootstrap(prod, ["boards/0100/shot-0100-a.jpg", "boards/0100/shot-0100-old.jpg"]);
  });
  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("outdated archive + restore: the registry follows the folder both ways", () => {
    archiveShotsToOutdated(prod, [prod.scenes[0].shots[0]]);
    expect(prod.outdatedShots).toHaveLength(1);
    const archived = prod.outdatedShots![0];
    expect(archived.artwork).toBe(`boards/outdated/s1/shot-0100-a.jpg`);
    // The registry entry moved with the file — the id resolves at the new path.
    expect(mediaEntryForPath(prod.media, archived.artwork)).toBeDefined();
    expect(mediaEntryForPath(prod.media, "boards/0100/shot-0100-a.jpg")).toBeUndefined();

    const restored = restoreOutdatedShot(prod, "s1");
    expect(restored.outdated).toBeUndefined();
    expect(mediaEntryForPath(prod.media, restored.artwork!)).toBeDefined();
    expect(mediaEntryForPath(prod.media, "boards/outdated/s1/shot-0100-a.jpg")).toBeUndefined();
  });

  it("renumber: the registry follows the shot's new number (storyboard, canvas, and history all resolve)", () => {
    const shot = prod.scenes[0].shots[0];
    shot.number = "0200";
    relocateBoardsForRenumber(prod, new Map([["s1", "0100"]]));
    // Fields moved…
    expect(shot.artwork).toBe("boards/0200/shot-0200-a.jpg");
    expect(shot.artworkHistory).toEqual(["boards/0200/shot-0200-old.jpg"]);
    expect(fs.existsSync(path.join(root, "boards/0200/shot-0200-a.jpg"))).toBe(true);
    // …and the registry moved with every one of them.
    for (const rel of [shot.artwork!, shot.artworkHistory![0]]) {
      expect(mediaEntryForPath(prod.media, rel), rel).toBeDefined();
    }
    expect(mediaEntryForPath(prod.media, "boards/0100/shot-0100-a.jpg")).toBeUndefined();
  });
});
