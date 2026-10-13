/**
 * Phase 3: intent commands for canvas state (brief recommendation 4).
 *
 * Whole-document saves made node moves last-write-wins on the WHOLE layout
 * object — two windows moving different nodes lost one of the moves, and a
 * stale save could wholesale replace a newer layout. The `production:
 * updateGraphLayout` command merges per-key instead. These tests pin the
 * shared merge both sides read:
 *   - positions/sizes/collapsed fold node-by-node (concurrent moves survive),
 *   - `remove` drops deleted nodes explicitly (a stale snapshot missing a
 *     node never deletes it by absence alone),
 *   - the viewport replaces outright, absent sections stay untouched;
 * plus the command's IPC payload validation, and the brief's idempotency
 * acceptance (repeating a command after an uncertain response changes
 * nothing the second time).
 */
import { describe, it, expect, vi } from "vitest";
import { mergeGraphLayoutPatch } from "../src/shared/graph/layout.js";
import type { GraphLayout, ProductionShot } from "../src/shared/ipc.js";

// setShotSelectedOutput lives in pipeline.ts (whose scripting import doesn't
// resolve under Vitest) — mock it away like the other pipeline suites.
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { setShotSelectedOutput } from "../src/main/pipeline.js";
describe("mergeGraphLayoutPatch", () => {
  it("folds positions node-by-node (two windows moving different nodes both survive)", () => {
    const fresh: GraphLayout = { positions: { composer: { x: 0, y: 0 }, imagegen: { x: 10, y: 10 } } };
    const out = mergeGraphLayoutPatch(fresh, { positions: { imagegen: { x: 11, y: 12 } } });
    // Window A moved imagegen; window B's composer position survives.
    expect(out.positions).toEqual({ composer: { x: 0, y: 0 }, imagegen: { x: 11, y: 12 } });
  });

  it("folds sizes and collapsed tiles the same way", () => {
    const fresh: GraphLayout = {
      sizes: { output: { width: 300, height: 200 } },
      collapsed: { "ref:r1": true },
    };
    const out = mergeGraphLayoutPatch(fresh, {
      sizes: { output: { width: 320, height: 200 } },
      collapsed: { "ref:r2": false },
    });
    expect(out.sizes).toEqual({ output: { width: 320, height: 200 } });
    expect(out.collapsed).toEqual({ "ref:r1": true, "ref:r2": false });
  });

  it("drops deleted nodes explicitly via remove", () => {
    const fresh: GraphLayout = {
      positions: { composer: { x: 0, y: 0 }, "videogen:vid1": { x: 5, y: 5 } },
      sizes: { "videogen:vid1": { width: 100, height: 100 } },
    };
    const out = mergeGraphLayoutPatch(fresh, { remove: ["videogen:vid1"] });
    expect(out.positions).toEqual({ composer: { x: 0, y: 0 } });
    expect(out.sizes).toBeUndefined();
  });

  it("replaces the viewport outright and leaves absent sections untouched", () => {
    const fresh: GraphLayout = {
      positions: { composer: { x: 0, y: 0 } },
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const out = mergeGraphLayoutPatch(fresh, { viewport: { x: 10, y: 20, zoom: 1.5 } });
    expect(out.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 });
    expect(out.positions).toEqual({ composer: { x: 0, y: 0 } });
  });

  it("starts from an empty layout and prunes empty sections", () => {
    expect(mergeGraphLayoutPatch(undefined, { positions: { a: { x: 1, y: 2 } } }))
      .toEqual({ positions: { a: { x: 1, y: 2 } } });
    const emptied = mergeGraphLayoutPatch({ positions: { a: { x: 0, y: 0 } } }, { remove: ["a"] });
    expect(emptied.positions).toBeUndefined();
  });

  it("repeating the same patch is a fixed point (retry-safe)", () => {
    const fresh: GraphLayout = { positions: { a: { x: 0, y: 0 } }, viewport: { x: 0, y: 0, zoom: 1 } };
    const patch = { positions: { a: { x: 5, y: 5 } }, sizes: { output: { width: 300, height: 200 } } };
    const once = mergeGraphLayoutPatch(fresh, patch);
    expect(mergeGraphLayoutPatch(once, patch)).toEqual(once);
  });
});

describe("command idempotency (phase 4: a repeat after an uncertain response changes nothing)", () => {
  it("selecting the same take twice settles (no duplicate, no drift)", () => {
    const shot = {
      id: "s1", number: "0100", audio: "", visual: "",
      graphImageGens: [
        { path: "a.jpg", prompt: "", model: "", at: "" },
        { path: "b.jpg", prompt: "", model: "", at: "" },
      ],
      graphImageGenIndex: 1,
    } as ProductionShot;
    setShotSelectedOutput(shot, { kind: "imagegen" });
    const once = JSON.stringify(shot);
    setShotSelectedOutput(shot, { kind: "imagegen" });
    expect(JSON.stringify(shot)).toBe(once);
    expect(shot.graphOutputSource).toBe("imagegen");
  });
});

describe("updateGraphLayout payload validation", () => {
  // The IPC boundary validates the same shapes main merges (non-finite
  // coordinates, wrong types, and overlong keys are rejected before the
  // handler runs).
  it("accepts a well-formed patch and rejects malformed ones", async () => {
    const { validateIpcArgs } = await import("../src/shared/ipc-schemas.js");
    const good = ["production:updateGraphLayout", "p1", "s1", {
      positions: { composer: { x: 1, y: 2 } },
      collapsed: { "ref:r1": true },
      viewport: { x: 0, y: 0, zoom: 1 },
      remove: ["videogen:vid1"],
    }];
    expect(() => validateIpcArgs(good[0] as string, good.slice(1))).not.toThrow();
    for (const bad of [
      { positions: { composer: { x: NaN, y: 0 } } },
      { positions: { composer: "left" } },
      { collapsed: { a: "yes" } },
      { viewport: { x: 0, y: 0 } },
      { remove: [1] },
      { positions: [] },
      "nope",
    ]) {
      expect(() => validateIpcArgs("production:updateGraphLayout", ["p1", "s1", bad])).toThrow();
    }
  });
});
