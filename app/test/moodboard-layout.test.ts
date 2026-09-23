/**
 * Reference Moodboard pure layout module — the board's whole correctness lives
 * in `moodboard-layout.ts` (repair on read, auto-placement, snapping, hit-test,
 * culling). The React canvas only forwards gestures, so these cover the math.
 */
import { describe, it, expect } from "vitest";
import {
  MB_DEFAULT_H,
  MB_DEFAULT_W,
  MB_FRAME_DEFAULT_COLOR,
  MB_FRAME_HEADER,
  MB_FRAME_MIN_H,
  MB_FRAME_MIN_W,
  MB_FRAME_PAD,
  MB_MAX_ZOOM,
  MB_MIN_ZOOM,
  MB_MIN_SIZE,
  autoLayoutNodes,
  clamp,
  contentBounds,
  fitViewport,
  frameColorHex,
  frameContainingRef,
  frameAtPoint,
  framesForRefs,
  groupNodes,
  nextZ,
  nodesInRect,
  normalizeFrameColor,
  normalizeMoodboardLayout,
  offBoardRefs,
  reconcileMoodboard,
  removeFrame,
  resizeFrame,
  screenToWorld,
  setFrameColor,
  setFrameLabel,
  settleFrameMembership,
  snapMove,
  snapRotation,
  snapToGrid,
  topmostNodeAt,
  translateFrame,
  ungroupFrames,
  visibleNodes,
  worldToScreen,
  zoomAt,
} from "../src/renderer/src/features/moodboard/moodboard-layout.js";

const refs = (...ids: string[]) => ids.map((id) => ({ id, name: id }));

describe("normalizeMoodboardLayout", () => {
  it("repairs non-finite numbers instead of trusting persisted values", () => {
    const layout = normalizeMoodboardLayout({
      version: 1,
      nodes: [{ refId: "a", x: NaN, y: Infinity, w: -5, h: "big", z: "x" }],
      viewport: { x: NaN, y: 10, zoom: 999 },
    });
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0].x).toBe(0);
    expect(layout.nodes[0].y).toBe(0);
    expect(layout.nodes[0].w).toBe(MB_MIN_SIZE);
    expect(layout.nodes[0].h).toBe(MB_DEFAULT_H);
    expect(layout.nodes[0].z).toBe(0);
    expect(layout.viewport.y).toBe(10);
    expect(layout.viewport.zoom).toBe(MB_MAX_ZOOM);
  });

  it("drops duplicate and id-less node entries", () => {
    const layout = normalizeMoodboardLayout({
      nodes: [{ refId: "a" }, { refId: "a" }, { refId: "" }, null, { x: 1 }],
    });
    expect(layout.nodes.map((n) => n.refId)).toEqual(["a"]);
  });

  it("clamps zoom and keeps only valid notes", () => {
    const layout = normalizeMoodboardLayout({
      viewport: { zoom: 0.0001 },
      notes: [{ id: "n1", x: 1, y: 2, w: 10, h: 10, text: "hi" }, { id: "" }, "junk"],
    });
    expect(layout.viewport.zoom).toBe(MB_MIN_ZOOM);
    expect(layout.notes).toHaveLength(1);
    expect(layout.notes?.[0].id).toBe("n1");
  });

  it("returns a usable empty layout for junk input", () => {
    const layout = normalizeMoodboardLayout(null);
    expect(layout.nodes).toEqual([]);
    expect(layout.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});

describe("autoLayoutNodes", () => {
  it("packs deterministically, sorted by category then name", () => {
    const nodes = autoLayoutNodes([
      { id: "z", name: "Zeta", categoryId: "b" },
      { id: "a", name: "Alpha", categoryId: "a" },
      { id: "b", name: "Beta", categoryId: "a" },
    ]);
    expect(nodes.map((n) => n.refId)).toEqual(["a", "b", "z"]);
    expect(nodes[0]).toMatchObject({ x: 0, y: 0, w: MB_DEFAULT_W, h: MB_DEFAULT_H, z: 0 });
    expect(nodes[1].x).toBeGreaterThan(nodes[0].x);
  });
});

describe("reconcileMoodboard", () => {
  it("auto-places new refs below existing content and prunes orphans", () => {
    const base = normalizeMoodboardLayout({
      nodes: [
        { refId: "keep", x: 100, y: 50, w: 200, h: 200, z: 3 },
        { refId: "gone", x: 0, y: 0, w: 200, h: 200, z: 1 },
      ],
    });
    const next = reconcileMoodboard(base, refs("keep", "new"));
    expect(next.nodes.map((n) => n.refId).sort()).toEqual(["keep", "new"]);
    const keep = next.nodes.find((n) => n.refId === "keep")!;
    expect(keep).toMatchObject({ x: 100, y: 50, w: 200, h: 200, z: 3 });
    const added = next.nodes.find((n) => n.refId === "new")!;
    // New node sits below the surviving content's bottom edge.
    expect(added.y).toBeGreaterThanOrEqual(50 + 200);
    expect(added.z).toBeGreaterThan(3);
  });

  it("is a no-op identity when nothing changed", () => {
    const base = reconcileMoodboard(normalizeMoodboardLayout(null), refs("a", "b"));
    const again = reconcileMoodboard(base, refs("a", "b"));
    expect(again.nodes.map((n) => n === base.nodes.find((m) => m.refId === n.refId))).toEqual([true, true]);
  });
});

describe("offBoardRefs", () => {
  it("lists refs not visible on the board — hidden or never placed", () => {
    const layout = normalizeMoodboardLayout({
      nodes: [
        { refId: "on", x: 0, y: 0 },
        { refId: "off", x: 0, y: 0, hidden: true },
      ],
    });
    const keys = offBoardRefs(layout, refs("on", "off", "unplaced")).map((r) => r.id);
    expect(keys).toEqual(["off", "unplaced"]);
  });
});

describe("geometry helpers", () => {  it("clamp and snapToGrid", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(snapToGrid(13)).toBe(16);
    expect(snapToGrid(-3)).toBe(0);
    expect(snapRotation(52)).toBe(45);
  });

  it("hit-tests the topmost node and marquee selection", () => {
    const nodes = [
      { refId: "low", x: 0, y: 0, w: 100, h: 100, z: 1 },
      { refId: "high", x: 50, y: 50, w: 100, h: 100, z: 5 },
    ];
    expect(topmostNodeAt(nodes, 60, 60)?.refId).toBe("high");
    expect(topmostNodeAt(nodes, 200, 200)).toBeNull();
    expect(nodesInRect(nodes, { x: 10, y: 10, w: 50, h: 50 }).map((n) => n.refId)).toEqual(["low", "high"]);
  });

  it("contentBounds, nextZ", () => {
    expect(contentBounds([])).toBeNull();
    expect(contentBounds([{ refId: "a", x: 10, y: 20, w: 30, h: 40, z: 0 }])).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    expect(nextZ([{ refId: "a", x: 0, y: 0, w: 1, h: 1, z: 7 }])).toBe(8);
  });

  it("snapMove aligns an edge and reports a guide", () => {
    const rect = { x: 103, y: 200, w: 100, h: 100 };
    const other = { x: 100, y: 400, w: 50, h: 50 };
    const res = snapMove(rect, [other]);
    expect(res.x).toBe(100);
    expect(res.guides).toEqual([{ axis: "x", world: 100 }]);
  });

  it("fitViewport centers the content", () => {
    const vp = fitViewport({ x: 0, y: 0, w: 100, h: 100 }, 500, 500);
    expect(vp.zoom).toBeGreaterThan(1);
    const center = worldToScreen(vp, 50, 50);
    expect(center.x).toBeCloseTo(250);
    expect(center.y).toBeCloseTo(250);
  });

  it("zoomAt keeps the cursor's world point fixed", () => {
    const vp = { x: 0, y: 0, zoom: 1 };
    const before = screenToWorld(vp, 100, 50);
    const after = zoomAt(vp, 100, 50, 2);
    const afterWorld = screenToWorld(after, 100, 50);
    expect(afterWorld.x).toBeCloseTo(before.x);
    expect(afterWorld.y).toBeCloseTo(before.y);
    expect(after.zoom).toBe(2);
  });

  it("culls off-screen nodes and keeps the visible one", () => {
    const nodes = [
      { refId: "here", x: 0, y: 0, w: 100, h: 100, z: 0 },
      { refId: "far", x: 100000, y: 100000, w: 100, h: 100, z: 0 },
    ];
    const visible = visibleNodes(nodes, { x: 0, y: 0, zoom: 1 }, 400, 300);
    expect(visible.map((n) => n.refId)).toEqual(["here"]);
  });
});

describe("moodboard frames", () => {
  const base = () =>
    normalizeMoodboardLayout({
      nodes: [
        { refId: "a", x: 0, y: 0, w: 100, h: 100, z: 0 },
        { refId: "b", x: 200, y: 40, w: 100, h: 100, z: 1 },
        { refId: "c", x: 500, y: 500, w: 100, h: 100, z: 2 },
      ],
    });

  it("normalizes the palette key and drops empty/duplicate frames", () => {
    expect(normalizeFrameColor("teal")).toBe("teal");
    expect(normalizeFrameColor("chartreuse")).toBe(MB_FRAME_DEFAULT_COLOR);
    expect(frameColorHex("chartreuse")).toBe(frameColorHex(MB_FRAME_DEFAULT_COLOR));

    const layout = normalizeMoodboardLayout({
      nodes: [{ refId: "a" }],
      frames: [
        { id: "f1", x: 0, y: 0, w: 300, h: 200, color: "purple", refIds: ["a", "a", "ghost"] },
        { id: "f1", x: 0, y: 0, w: 300, h: 200, refIds: ["a"] },
        { id: "f2", x: 0, y: 0, w: 300, h: 200, refIds: [] },
      ],
    });
    expect(layout.frames).toHaveLength(1);
    expect(layout.frames?.[0]).toMatchObject({ id: "f1", color: MB_FRAME_DEFAULT_COLOR, refIds: ["a"] });
  });

  it("groups a selection into a frame sized around its members", () => {
    const layout = groupNodes(base(), ["a", "b"], { id: "f1", color: "green", label: "Heroes" });
    expect(layout.frames).toHaveLength(1);
    const f = layout.frames![0];
    expect(f).toMatchObject({ id: "f1", color: "green", label: "Heroes" });
    expect(f.refIds).toEqual(["a", "b"]);
    expect(f.x).toBe(0 - MB_FRAME_PAD);
    expect(f.y).toBe(0 - MB_FRAME_PAD - MB_FRAME_HEADER);
    expect(f.w).toBe(300 + MB_FRAME_PAD * 2);
    expect(f.h).toBe(140 + MB_FRAME_PAD * 2 + MB_FRAME_HEADER);
  });

  it("re-grouping pulls members out of an existing frame", () => {
    const first = groupNodes(base(), ["a", "b"], { id: "f1" });
    const next = groupNodes(first, ["b", "c"], { id: "f2" });
    expect(next.frames?.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(next.frames?.find((f) => f.id === "f1")?.refIds).toEqual(["a"]);
    expect(next.frames?.find((f) => f.id === "f2")?.refIds).toEqual(["b", "c"]);
  });

  it("ignores hidden nodes and unknown ids when grouping", () => {
    const layout = normalizeMoodboardLayout({ nodes: [{ refId: "a", hidden: true }, { refId: "b" }] });
    expect(groupNodes(layout, ["a", "ghost"], { id: "f1" })).toBe(layout);
    const grouped = groupNodes(layout, ["a", "b"], { id: "f1" });
    expect(grouped.frames?.[0].refIds).toEqual(["b"]);
  });

  it("un-groups by reference or by frame id", () => {
    const layout = groupNodes(base(), ["a", "b"], { id: "f1" });
    expect(ungroupFrames(layout, ["a"]).frames).toBeUndefined();
    expect(removeFrame(layout, "other")).toBe(layout);
    expect(removeFrame(layout, "f1").frames).toBeUndefined();
  });

  it("renames and recolors a frame, ignoring unknown colors", () => {
    const layout = groupNodes(base(), ["a"], { id: "f1" });
    expect(setFrameLabel(layout, "f1", "Set A").frames?.[0].label).toBe("Set A");
    expect(setFrameColor(layout, "f1", "pink").frames?.[0].color).toBe("pink");
    expect(setFrameColor(layout, "f1", "nope").frames?.[0].color).toBe(MB_FRAME_DEFAULT_COLOR);
    expect(setFrameLabel(layout, "ghost", "x")).toBe(layout);
  });

  it("translates a frame together with its members only", () => {
    const layout = groupNodes(base(), ["a", "b"], { id: "f1" });
    const moved = translateFrame(layout, "f1", 10, -20);
    const a = moved.nodes.find((n) => n.refId === "a")!;
    const c = moved.nodes.find((n) => n.refId === "c")!;
    expect(a).toMatchObject({ x: 10, y: -20 });
    expect(c).toMatchObject({ x: 500, y: 500 });
    expect(moved.frames?.[0]).toMatchObject({ x: -MB_FRAME_PAD + 10, y: -MB_FRAME_PAD - MB_FRAME_HEADER - 20 });
  });

  it("resizes a frame, clamping to the minimum", () => {
    const layout = groupNodes(base(), ["a"], { id: "f1" });
    expect(resizeFrame(layout, "f1", 5, 5).frames?.[0]).toMatchObject({ w: MB_FRAME_MIN_W, h: MB_FRAME_MIN_H });
    expect(resizeFrame(layout, "f1", 400, 300).frames?.[0]).toMatchObject({ w: 400, h: 300 });
  });

  it("prunes dead members and empty frames on reconcile", () => {
    const grouped = groupNodes(base(), ["a", "b"], { id: "f1" });
    const next = reconcileMoodboard(grouped, refs("a", "c"));
    expect(next.nodes.map((n) => n.refId).sort()).toEqual(["a", "c"]);
    expect(next.frames?.[0].refIds).toEqual(["a"]);
    // Removing the last member removes the frame entirely.
    const empty = reconcileMoodboard(grouped, refs("c"));
    expect(empty.frames).toBeUndefined();
  });

  it("finds frames by member and reference", () => {
    const layout = groupNodes(base(), ["a", "b"], { id: "f1" });
    expect(frameContainingRef(layout, "a")?.id).toBe("f1");
    expect(frameContainingRef(layout, "c")).toBeNull();
    expect(framesForRefs(layout, ["b", "c"]).map((f) => f.id)).toEqual(["f1"]);
  });

  it("finds the innermost frame at a point", () => {
    const outer = groupNodes(base(), ["a", "b"], { id: "f1" });
    const inner = groupNodes(outer, ["a"], { id: "f2" });
    // A point over "a" is inside both; the smaller (inner) frame wins.
    expect(frameAtPoint(inner, 50, 50)?.id).toBe("f2");
    expect(frameAtPoint(inner, 250, 90)?.id).toBe("f1");
    expect(frameAtPoint(inner, 5000, 5000)).toBeNull();
  });

  it("adds a node dropped inside a frame and keeps one dropped outside", () => {
    const layout = groupNodes(base(), ["a"], { id: "f1" });
    const moved = {
      ...layout,
      nodes: layout.nodes.map((n) => (n.refId === "c" ? { ...n, x: 0, y: 0 } : n)),
    };
    const joined = settleFrameMembership(moved, ["c"], false);
    expect(frameContainingRef(joined, "c")?.id).toBe("f1");

    // Dropped outside every frame, an unframed node stays unframed.
    const outside = settleFrameMembership(layout, ["c"], false);
    expect(frameContainingRef(outside, "c")).toBeNull();
  });

  it("re-parents a node dragged into another frame", () => {
    let layout = groupNodes(base(), ["a"], { id: "f1" });
    layout = groupNodes(layout, ["c"], { id: "f2" });
    const moved = {
      ...layout,
      nodes: layout.nodes.map((n) => (n.refId === "a" ? { ...n, x: 500, y: 500 } : n)),
    };
    const settled = settleFrameMembership(moved, ["a"], false);
    expect(frameContainingRef(settled, "a")?.id).toBe("f2");
    // f1 held only "a", so it is dropped once empty.
    expect(settled.frames?.map((f) => f.id)).toEqual(["f2"]);
  });

  it("removes a node on alt-drag and drops a frame left empty", () => {
    const layout = groupNodes(base(), ["a", "b"], { id: "f1" });
    const one = settleFrameMembership(layout, ["a"], true);
    expect(one.frames?.[0].refIds).toEqual(["b"]);
    const none = settleFrameMembership(one, ["b"], true);
    expect(none.frames).toBeUndefined();
  });

  it("keeps a hidden member when its frame is group-dragged", () => {
    const grouped = groupNodes(base(), ["a", "b"], { id: "f1" });
    const hidden = { ...grouped, nodes: grouped.nodes.map((n) => (n.refId === "b" ? { ...n, hidden: true } : n)) };
    const settled = settleFrameMembership(hidden, ["a", "b"], false);
    expect(new Set(settled.frames?.[0].refIds)).toEqual(new Set(["a", "b"]));
  });
});
