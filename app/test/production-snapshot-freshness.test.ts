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
import { isFresh, revOf, isStaleRevisionError, applySavedRevision, sameSnapshotExceptRev } from "../src/shared/snapshot-freshness.js";

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

describe("stale-revision error detection (delete shot recovery)", () => {
  it("recognizes a bare stale-edit error", () => {
    expect(isStaleRevisionError(new Error("Stale edit: this production changed since (rev 3 → 5). Refresh and retry."))).toBe(true);
  });

  it("recognizes the Electron invoke-wrapped form a renderer actually receives", () => {
    // ipcRenderer.invoke rejects with the remote-method prefix, so a
    // startsWith("Stale edit:") check in the renderer never matches and the
    // refresh-and-retry recovery for Delete shot silently never runs.
    const wrapped = new Error("Error invoking remote method 'production:deleteShot': Error: Stale edit: this production changed since (rev 3 → 5). Refresh and retry.");
    expect(isStaleRevisionError(wrapped)).toBe(true);
    expect(isStaleRevisionError(String(wrapped).replace(/^Error:\s*/, ""))).toBe(true);
  });

  it("does not flag unrelated errors", () => {
    expect(isStaleRevisionError(new Error("Shot not found."))).toBe(false);
    expect(isStaleRevisionError(null)).toBe(false);
  });
});

describe("applySavedRevision (whole-document saves adopt the stamped rev)", () => {
  it("bumps a lagging local revision to the saved one, keeping local fields", () => {
    const local = { rev: 3, name: "optimistic edit" };
    const next = applySavedRevision(local, 4);
    expect(next).toEqual({ rev: 4, name: "optimistic edit" });
    expect(next).not.toBe(local);
  });

  it("keeps identity when the saved revision is not newer", () => {
    const local = { rev: 5, name: "current" };
    expect(applySavedRevision(local, 5)).toBe(local);
    expect(applySavedRevision(local, 2)).toBe(local);
    expect(applySavedRevision(local, 0)).toBe(local);
  });
});

describe("sameSnapshotExceptRev (layout-save echo skip)", () => {
  it("is true when only the rev differs (the save carried no news)", () => {
    const a = { rev: 3, meta: { id: "p1" }, scenes: [{ shots: [{ id: "a", graphLayout: { viewport: { x: 1, y: 2, zoom: 0.5 } } }] }] };
    const b = { rev: 4, meta: { id: "p1" }, scenes: [{ shots: [{ id: "a", graphLayout: { viewport: { x: 1, y: 2, zoom: 0.5 } } }] }] };
    expect(sameSnapshotExceptRev(a, b)).toBe(true);
    expect(sameSnapshotExceptRev(a, a)).toBe(true);
  });

  it("is false when any other field moved (concurrent main-side change)", () => {
    const a = { rev: 3, scenes: [{ shots: [{ id: "a", prompt: "old" }] }] };
    const b = { rev: 4, scenes: [{ shots: [{ id: "a", prompt: "new" }] }] };
    expect(sameSnapshotExceptRev(a, b)).toBe(false);
  });

  it("treats a missing rev as comparable", () => {
    expect(sameSnapshotExceptRev({ scenes: [] }, { rev: 9, scenes: [] })).toBe(true);
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
