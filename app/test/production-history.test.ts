/**
 * Document-layer undo history (app-wide undo Item 5 harness, pure core).
 *
 * Exercises the shared history core exactly the way main drives it: every
 * committed save hands over a fresh clone of the whole production document
 * (what a load→mutate→save handler produces), and undo/redo restore through
 * `mergeRestoredProduction` (snapshot + the live document's excluded fields).
 * The operations under test are the real ones (`shotter.*`, graph edits,
 * prompt/script field writes), so "undo all → exact start, redo all → exact
 * end" is proven against production mutation code, not a toy model.
 */
import { describe, it, expect } from "vitest";
import type { Production, ProductionShot } from "../src/shared/ipc.js";
import {
  createDocumentHistory,
  projectForHistory,
  mergeRestoredProduction,
  reconcileShare,
  HISTORY_STEP_CAP,
} from "../src/shared/production-history.js";
import * as shotter from "../src/main/shotter.js";

function shot(id: string, number: string, over: Partial<ProductionShot> = {}): ProductionShot {
  return {
    id,
    number,
    audio: `audio ${id}`,
    visual: `visual ${id}`,
    prompt: `prompt ${id}`,
    graph: {
      version: 1,
      nodes: [
        { id: "composer", kind: "composer", pos: { x: 0, y: 0 } },
        { id: "imagegen", kind: "imagegen", pos: { x: 10, y: 0 } },
        { id: "output", kind: "output", pos: { x: 20, y: 0 } },
      ],
      edges: [
        { id: "e1", from: { node: "composer", port: "prompt" }, to: { node: "imagegen", port: "prompt" } },
        { id: "e2", from: { node: "imagegen", port: "image" }, to: { node: "output", port: "image" } },
      ],
    } as ProductionShot["graph"],
    graphVideoNodes: [{ id: "vid0", gens: [{ path: `boards/${number}/video/clip-${id}.mp4` }], genIndex: 0 } as never],
    graphLayout: { positions: { composer: { x: 0, y: 0 } }, viewport: { x: 1, y: 2, zoom: 1 } } as never,
    ...over,
  };
}

function baseProduction(over: Partial<Production> = {}): Production {
  return {
    meta: { id: "p1", name: "Prod", folder: "C:/ws/prod", createdAt: "t0", updatedAt: "t0", stepDone: 0, shotCount: 0 },
    currentStep: 3,
    visualStyle: "style",
    styles: [{ id: "st1", index: 1, name: "Master", prompt: "master style" }],
    scenes: [
      { number: 1, title: "Opening", shots: [shot("s1", "0100"), shot("s2", "0200")] },
      { number: 2, title: "Chase", shots: [shot("s3", "0300")] },
    ],
    characters: [{ id: "c1", name: "Hero", key: "hero key" }],
    products: [],
    references: [{ id: "r1", name: "Ref One", imagePath: "references/one.png", shotIds: ["s1"] }],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
    rev: 7,
    ...over,
  } as Production;
}

/** The main-service save/undo cycle, mirrored: saves record a projected
 *  clone; undo restores snapshot-over-current then commits the actual. */
class Harness {
  doc: Production;
  history = createDocumentHistory<Production>();
  constructor(start: Production) {
    this.doc = structuredClone(start);
    this.history.init(this.snap(this.doc));
  }
  snap(p: Production): Production {
    return projectForHistory(structuredClone(p));
  }
  /** One handler-style committed save: mutate a fresh clone, then record. */
  save(mutate: (p: Production) => void, meta?: Parameters<typeof this.history.record>[1], now?: number): boolean {
    const next = structuredClone(this.doc);
    mutate(next);
    this.doc = next;
    return this.history.record(this.snap(next), meta, now);
  }
  undo(): boolean {
    const target = this.history.peekUndo();
    if (!target) return false;
    this.doc = mergeRestoredProduction(target, this.doc);
    this.history.commitUndo(this.snap(this.doc));
    return true;
  }
  redo(): boolean {
    const target = this.history.peekRedo();
    if (!target) return false;
    this.doc = mergeRestoredProduction(target, this.doc);
    this.history.commitRedo(this.snap(this.doc));
    return true;
  }
  proj(p: Production = this.doc): string {
    return JSON.stringify(this.snap(p));
  }
}

describe("reconcileShare", () => {
  it("reuses unchanged subtrees and rebuilds only the changed path", () => {
    const a = { x: { deep: [1, 2, { v: "a" }] }, y: { keep: true } };
    const b = structuredClone(a);
    (b.x.deep[2] as { v: string }).v = "b";
    const out = reconcileShare(a, b);
    expect(out).not.toBe(a);
    expect(out.y).toBe(a.y);
    expect(out.x).not.toBe(a.x);
    expect(out.x.deep[0]).toBe(1);
    expect((out.x.deep[2] as { v: string }).v).toBe("b");
    // Deep-equal input folds back to the previous reference entirely.
    expect(reconcileShare(a, structuredClone(a))).toBe(a);
  });
});

describe("projection (world/document boundary)", () => {
  it("excluded-only changes record no entry (status, pending receipts, step, viewport, rev, media)", () => {
    const h = new Harness(baseProduction());
    expect(
      h.save((p) => {
        p.status = { 3: "running" };
        p.currentStep = 4;
        p.rev = 99;
        p.meta.updatedAt = "later";
        const s = p.scenes[0].shots[0];
        s.pendingImageGen = { historyId: "job-1" } as never;
        (s.graphLayout as { viewport?: unknown }).viewport = { x: 9, y: 9, zoom: 2 };
        p.media = [{ id: "m1", path: "boards/0100/a.jpg", kind: "image", origin: "generated", state: "missing", at: "t" } as never];
      })
    ).toBe(false);
    expect(h.history.canUndo()).toBe(false);
  });

  it("restore never clobbers live excluded fields (pending receipt + viewport survive an undo)", () => {
    const h = new Harness(baseProduction());
    expect(h.save((p) => { p.scenes[0].shots[0].prompt = "edited"; })).toBe(true);
    // A generation submits meanwhile: receipt + viewport move (no entry).
    h.save((p) => {
      p.scenes[0].shots[0].pendingImageGen = { historyId: "job-9" } as never;
      (p.scenes[0].shots[0].graphLayout as { viewport?: unknown }).viewport = { x: 5, y: 6, zoom: 3 };
    });
    expect(h.undo()).toBe(true);
    const s = h.doc.scenes[0].shots[0];
    expect(s.prompt).toBe("prompt s1");
    expect((s.pendingImageGen as { historyId?: string } | undefined)?.historyId).toBe("job-9");
    expect((s.graphLayout as { viewport?: { zoom: number } } | undefined)?.viewport?.zoom).toBe(3);
  });
});

describe("round-trips per area (do / undo / redo, exact at each step)", () => {
  const areas: Array<[string, (p: Production) => void]> = [
    ["prompt edit", (p) => { p.scenes[0].shots[1].prompt = "a brand new prompt"; }],
    ["script edit (audio/visual)", (p) => {
      p.scenes[0].shots[0].audio = "new dialogue";
      p.scenes[0].shots[0].visual = "new visual";
    }],
    ["scene rename (Feature #12)", (p) => { shotter.renameScene(p.scenes, 2, "The Big Chase"); }],
    ["wire disconnect", (p) => {
      const g = p.scenes[0].shots[0].graph!;
      g.edges = g.edges.filter((e) => e.id !== "e1");
    }],
    ["node delete", (p) => {
      const s = p.scenes[0].shots[0];
      s.graph!.nodes = s.graph!.nodes.filter((n) => n.id !== "imagegen");
      s.graph!.edges = s.graph!.edges.filter((e) => e.from.node !== "imagegen" && e.to.node !== "imagegen");
      s.graphVideoNodes = [];
    }],
    ["node move (layout)", (p) => {
      const l = p.scenes[0].shots[0].graphLayout as { positions: Record<string, { x: number; y: number }> };
      l.positions.composer = { x: 120, y: 40 };
    }],
    ["shot reorder (whole atomic reorder = one step)", (p) => { shotter.reorderShot(p.scenes, "s3", "s1"); }],
    ["shot delete", (p) => { shotter.removeShotById(p.scenes, "s2"); }],
    ["scene delete (Feature #12)", (p) => { shotter.deleteScene(p.scenes, 1); }],
    ["generation completion lands media (its own entry)", (p) => {
      const s = p.scenes[0].shots[0];
      s.graphImageGens = [{ path: "boards/0100/shot-0100-new.jpg" } as never, ...(s.graphImageGens ?? [])];
      delete s.pendingImageGen;
    }],
  ];

  for (const [name, op] of areas) {
    it(name, () => {
      const h = new Harness(baseProduction());
      const start = h.proj();
      expect(h.save(op)).toBe(true);
      const after = h.proj();
      expect(after).not.toBe(start);
      expect(h.history.size).toBe(1);
      expect(h.undo()).toBe(true);
      expect(h.proj()).toBe(start);
      expect(h.redo()).toBe(true);
      expect(h.proj()).toBe(after);
      // Undo again after redo lands exactly back at start.
      expect(h.undo()).toBe(true);
      expect(h.proj()).toBe(start);
    });
  }

  it("a new edit after undo clears the redo stack", () => {
    const h = new Harness(baseProduction());
    h.save((p) => { p.scenes[0].shots[0].prompt = "one"; });
    h.undo();
    expect(h.history.canRedo()).toBe(true);
    h.save((p) => { p.scenes[0].shots[0].prompt = "two"; });
    expect(h.history.canRedo()).toBe(false);
  });
});

describe("mixed-sequence invariant (Item 5)", () => {
  it("undo-all reproduces the starting document EXACTLY, redo-all the final one", () => {
    const h = new Harness(baseProduction());
    const start = h.proj();
    const ops: Array<(p: Production) => void> = [
      (p) => { p.scenes[0].shots[0].prompt = "hero at dawn"; },
      (p) => { p.scenes[0].shots[0].audio = "VO: dawn breaks"; p.scenes[0].shots[0].visual = "Dawn over rooftops"; },
      (p) => { shotter.renameScene(p.scenes, 1, "Dawn Patrol"); },
      (p) => { const g = p.scenes[0].shots[1].graph!; g.edges = g.edges.filter((e) => e.id !== "e2"); },
      (p) => { shotter.reorderShot(p.scenes, "s2", "s3"); },
      (p) => { p.scenes.flatMap((s) => s.shots).find((s) => s.id === "s3")!.graphImageGens = [{ path: "boards/x/gen.jpg" } as never]; },
      (p) => { shotter.removeShotById(p.scenes, "s1"); },
      (p) => { shotter.deleteScene(p.scenes, 2); },
      (p) => { p.characters.push({ id: "c2", name: "Villain", key: "villain key" }); },
    ];
    for (const op of ops) expect(h.save(op)).toBe(true);
    const final = h.proj();
    expect(h.history.size).toBe(ops.length);

    let undos = 0;
    while (h.undo()) undos++;
    expect(undos).toBe(ops.length);
    expect(h.proj()).toBe(start);
    expect(h.doc.scenes.map((s) => s.title)).toEqual(["Opening", "Chase"]);

    let redos = 0;
    while (h.redo()) redos++;
    expect(redos).toBe(ops.length);
    expect(h.proj()).toBe(final);
  });
});

describe("text-edit granularity (Item 2 coalescing)", () => {
  it("keyed saves within one field session are ONE step; coalesceEnd closes it", () => {
    const h = new Harness(baseProduction());
    const start = h.proj();
    // Simulate live prompt saves while typing in one field.
    expect(h.save((p) => { p.scenes[0].shots[0].prompt = "h"; }, { coalesceKey: "prompt:s1", coalesceMs: 600000 }, 1000)).toBe(true);
    expect(h.save((p) => { p.scenes[0].shots[0].prompt = "he"; }, { coalesceKey: "prompt:s1", coalesceMs: 600000 }, 1100)).toBe(true);
    expect(h.save((p) => { p.scenes[0].shots[0].prompt = "hero"; }, { coalesceKey: "prompt:s1", coalesceMs: 600000, coalesceEnd: true }, 1200)).toBe(true);
    expect(h.history.size).toBe(1);
    // The next committed edit starts a new step even under the same key.
    expect(h.save((p) => { p.scenes[0].shots[0].prompt = "hero2"; }, { coalesceKey: "prompt:s1", coalesceMs: 600000 }, 1300)).toBe(true);
    expect(h.history.size).toBe(2);
    expect(h.undo()).toBe(true);
    expect(h.doc.scenes[0].shots[0].prompt).toBe("hero");
    expect(h.undo()).toBe(true);
    expect(h.proj()).toBe(start);
  });

  it("a paste (single save) is one step; forceStep never merges", () => {
    const h = new Harness(baseProduction());
    h.save((p) => { p.scenes[0].shots[0].prompt = "pasted paragraph one\nparagraph two"; }, { coalesceKey: "prompt:s1" }, 1000);
    expect(h.history.size).toBe(1);
    h.save((p) => { p.scenes[0].shots[0].prompt = "discrete"; }, { coalesceKey: "prompt:s1", forceStep: true }, 1100);
    expect(h.history.size).toBe(2);
  });

  it("slider-style bursts merge inside the window and split after it", () => {
    const h = new Harness(baseProduction());
    h.save((p) => { p.uncategorizedTileSize = 150; }, { coalesceKey: "tilesize:uncat", coalesceMs: 800 }, 1000);
    h.save((p) => { p.uncategorizedTileSize = 180; }, { coalesceKey: "tilesize:uncat", coalesceMs: 800 }, 1400);
    expect(h.history.size).toBe(1);
    h.save((p) => { p.uncategorizedTileSize = 200; }, { coalesceKey: "tilesize:uncat", coalesceMs: 800 }, 5000);
    expect(h.history.size).toBe(2);
  });
});

describe("structural sharing + cap (Item 5 perf/memory)", () => {
  function countNewObjects(prev: unknown, next: unknown): number {
    const prevObjs = new Set<object>();
    const walk = (v: unknown, into: Set<object>) => {
      if (!v || typeof v !== "object" || into.has(v as object)) return;
      into.add(v as object);
      for (const val of Object.values(v as Record<string, unknown>)) walk(val, into);
    };
    walk(prev, prevObjs);
    const seen = new Set<object>();
    let added = 0;
    const walk2 = (v: unknown) => {
      if (!v || typeof v !== "object" || seen.has(v as object)) return;
      seen.add(v as object);
      if (!prevObjs.has(v as object)) added++;
      for (const val of Object.values(v as Record<string, unknown>)) walk2(val);
    };
    walk2(next);
    return added;
  }

  it("a deep edit in a large production retains O(change) new objects, not O(document)", () => {
    const many: ProductionShot[] = [];
    for (let i = 0; i < 300; i++) many.push(shot(`t${i}`, String(100 + i * 100).padStart(4, "0")));
    const big = baseProduction({ scenes: [{ number: 1, title: "Big", shots: many }] });
    const h = new Harness(big);
    const before = h.history.current()!;
    const totalBefore = countNewObjects(null, before);
    h.save((p) => { p.scenes[0].shots[150].prompt = "one deep change"; });
    const after = h.history.current()!;
    expect(after.scenes[0].shots[150]).not.toBe(before.scenes[0].shots[150]);
    expect(after.scenes[0].shots[0]).toBe(before.scenes[0].shots[0]);
    expect(after.scenes[0].shots[299]).toBe(before.scenes[0].shots[299]);
    expect(after.characters).toBe(before.characters);
    const added = countNewObjects(before, after);
    // Changed path only: production + scenes array + scene + shots array + shot.
    expect(added).toBeLessThan(25);
    expect(totalBefore).toBeGreaterThan(2000);
    // Snapshots are frozen: later working-doc mutation cannot corrupt them.
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.scenes[0].shots[150])).toBe(true);
  });

  it("the step cap holds (oldest dropped) and undo stops at the cap boundary", () => {
    const h = new Harness(baseProduction());
    const total = HISTORY_STEP_CAP + 50;
    for (let i = 0; i < total; i++) {
      h.save((p) => { p.scenes[0].shots[0].prompt = `v${i}`; }, undefined, i * 10000);
    }
    expect(h.history.size).toBe(HISTORY_STEP_CAP);
    let undos = 0;
    while (h.undo()) undos++;
    expect(undos).toBe(HISTORY_STEP_CAP);
    // State after the first 50 edits is as far back as history reaches.
    expect(h.doc.scenes[0].shots[0].prompt).toBe("v49");
  });
});
