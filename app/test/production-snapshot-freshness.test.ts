/**
 * Production snapshot freshness — regression tests for the storyboard
 * prompt-editing bug (add a shot, delete a different shot, prompt editing
 * breaks until restart).
 *
 * Root cause: the renderer applied whole-Production IPC snapshots with no
 * freshness guard, so a prompt-save response produced before an
 * insert/delete could resolve after it and resurrect a deleted "ghost" shot.
 * The fix stamps a monotonic `rev` on every saveProduction and rejects older
 * snapshots in the renderer (isFresh / applySnapshot).
 */
import { afterAll, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import type { Production } from "../src/shared/ipc.js";
import { isFresh, revOf } from "../src/shared/snapshot-freshness.js";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/opencode/cascade-snapshot-freshness-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({ app: { getPath: () => dataDir } }));

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { loadProduction, saveProduction } from "../src/main/productions.js";
import { insertShotAt } from "../src/main/shotter.js";

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function baseProduction(overrides: Partial<Production> = {}): Production {
  return {
    meta: { id: "p1", name: "Prod", folder: "C:/workspace/prod", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    currentStep: 1,
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

function shot(id: string, number: string) {
  return { id, number, audio: "", visual: "" };
}

describe("isFresh", () => {
  it("applies a newer snapshot", () => {
    expect(isFresh(2, 1)).toBe(true);
  });

  it("rejects an older snapshot (the regression)", () => {
    expect(isFresh(1, 2)).toBe(false);
  });

  it("applies an equal-revision snapshot (latest write wins)", () => {
    expect(isFresh(2, 2)).toBe(true);
  });

  it("revOf normalizes missing/non-numeric revs to 0", () => {
    expect(revOf({})).toBe(0);
    expect(revOf({ rev: undefined })).toBe(0);
    expect(revOf({ rev: "3" })).toBe(0);
    expect(revOf({ rev: 7 })).toBe(7);
  });
});

describe("saveProduction rev", () => {
  it("stamps a monotonic rev that survives a load round-trip", () => {
    const p = baseProduction();
    saveProduction(p);
    const r1 = revOf(p);
    expect(r1).toBeGreaterThan(0);
    saveProduction(p);
    expect(revOf(p)).toBe(r1 + 1);
    const reloaded = loadProduction(p.meta.id);
    expect(reloaded && revOf(reloaded)).toBe(revOf(p));
  });
});

describe("insert + delete + prompt save leaves no ghost shot", () => {
  it("a stale pre-delete snapshot is rejected by the freshness guard", () => {
    const p = baseProduction({
      scenes: [{ number: 1, title: "S1", shots: [shot("a", "0100"), shot("b", "0200"), shot("c", "0300")] }],
    });
    saveProduction(p);
    const staleRev = revOf(p); // snapshot taken before the structural edits

    insertShotAt(p.scenes, 1, 1); // S1: a, <new>, b, c (renumbered as needed)
    saveProduction(p);
    const insertedId = p.scenes[0].shots[1].id;

    const bi = p.scenes[0].shots.findIndex((s) => s.id === "b");
    p.scenes[0].shots.splice(bi, 1);
    saveProduction(p);
    const freshRev = revOf(p);
    expect(freshRev).toBeGreaterThan(staleRev);

    // The stale pre-edit snapshot must not be applied over the fresh state.
    expect(isFresh(staleRev, freshRev)).toBe(false);

    const ids = p.scenes.flatMap((s) => s.shots.map((x) => x.id));
    expect(ids).not.toContain("b");
    expect(ids).toContain("a");
    expect(ids).toContain("c");
    expect(ids).toContain(insertedId);

    // A prompt save on a remaining shot lands on the fresh document.
    const target = p.scenes.flatMap((s) => s.shots).find((s) => s.id === "c")!;
    target.prompt = "hello";
    target.promptManual = true;
    saveProduction(p);
    const after = loadProduction(p.meta.id)!;
    const afterIds = after.scenes.flatMap((s) => s.shots.map((x) => x.id));
    expect(afterIds).not.toContain("b");
    expect(after.scenes.flatMap((s) => s.shots).find((s) => s.id === "c")!.prompt).toContain("hello");
  });
});
