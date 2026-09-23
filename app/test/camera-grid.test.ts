/**
 * Camera-grid pure grid math (Spec 04). These helpers are shared by the
 * renderer (panel derivation, marquee → covered panels) and main (rect
 * clamping/validation), so every branch is exercised here.
 */
import { describe, it, expect } from "vitest";
import {
  CAMERA_GRID_COLS,
  CAMERA_GRID_ROWS,
  CAMERA_GRID_SIZES,
  cameraGridPanels,
  cameraGridSizeKey,
  clampGridRect,
  gridRectFromPoints,
  insetGridRect,
  intersectArea,
  isCameraGridSheetPath,
  normalizeCameraGridData,
  normalizeGraphSource,
  panelLabelFor,
  placeCameraGridRef,
  rectArea,
  removeCameraGridRefAt,
  resolveCameraGridPanels,
  resolvePanelLabels,
  touchedPanelIndices,
  unionGridRects,
} from "../src/shared/ipc.js";

describe("cameraGridPanels", () => {
  it("builds a row-major 4x4 unit grid", () => {
    const panels = cameraGridPanels(CAMERA_GRID_COLS, CAMERA_GRID_ROWS);
    expect(panels).toHaveLength(16);
    expect(panels[0]).toEqual({ x: 0, y: 0, w: 0.25, h: 0.25 });
    expect(panels[1]).toEqual({ x: 0.25, y: 0, w: 0.25, h: 0.25 });
    expect(panels[4]).toEqual({ x: 0, y: 0.25, w: 0.25, h: 0.25 });
    expect(panels[15]).toEqual({ x: 0.75, y: 0.75, w: 0.25, h: 0.25 });
  });

  it("coerces degenerate geometry to at least one cell", () => {
    expect(cameraGridPanels(0, 0)).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
  });
});

describe("cameraGridSizes", () => {
  it("offers 4x4, 3x3, and 2x2 with the default first", () => {
    expect(CAMERA_GRID_SIZES.map((s) => [s.cols, s.rows])).toEqual([[4, 4], [3, 3], [2, 2]]);
    expect(CAMERA_GRID_SIZES[0]).toMatchObject({ cols: CAMERA_GRID_COLS, rows: CAMERA_GRID_ROWS });
  });
  it("keys a geometry canonically", () => {
    expect(cameraGridSizeKey(4, 4)).toBe("4x4");
    expect(cameraGridSizeKey(3, 3)).toBe("3x3");
    expect(cameraGridSizeKey(0, 2.9)).toBe("1x2");
  });
});

describe("gridRectFromPoints / clampGridRect", () => {
  it("normalizes any drag direction", () => {
    const r = gridRectFromPoints(0.8, 0.9, 0.2, 0.3);
    expect(r.x).toBeCloseTo(0.2);
    expect(r.y).toBeCloseTo(0.3);
    expect(r.w).toBeCloseTo(0.6);
    expect(r.h).toBeCloseTo(0.6);
  });
  it("clamps to the unit square and never yields negative extents", () => {
    expect(clampGridRect({ x: -0.5, y: -0.5, w: 0.2, h: 0.2 })).toEqual({ x: 0, y: 0, w: 0.2, h: 0.2 });
    expect(clampGridRect({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0.9, y: 0.9, w: 0.09999999999999998, h: 0.09999999999999998 });
  });
});

describe("insetGridRect", () => {
  it("shrinks proportionally by the inset on every edge", () => {
    const r = insetGridRect({ x: 0.25, y: 0, w: 0.25, h: 0.25 }, 0.1);
    expect(r.x).toBeCloseTo(0.275);
    expect(r.y).toBeCloseTo(0.025);
    expect(r.w).toBeCloseTo(0.2);
    expect(r.h).toBeCloseTo(0.2);
  });
  it("is a no-op at 0 and clamps the inset", () => {
    expect(insetGridRect({ x: 0, y: 0, w: 1, h: 1 }, 0)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    const c = insetGridRect({ x: 0, y: 0, w: 1, h: 1 }, 9);
    expect(c.x).toBeCloseTo(0.45);
    expect(c.y).toBeCloseTo(0.45);
    expect(c.w).toBeCloseTo(0.1);
    expect(c.h).toBeCloseTo(0.1);
  });
});

describe("rectArea / intersectArea", () => {
  const a = { x: 0, y: 0, w: 0.5, h: 0.5 };
  const b = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  it("computes area and overlap", () => {
    expect(rectArea(a)).toBeCloseTo(0.25);
    expect(intersectArea(a, b)).toBeCloseTo(0.0625);
    expect(intersectArea(a, { x: 0.6, y: 0.6, w: 0.1, h: 0.1 })).toBe(0);
  });
});

describe("touchedPanelIndices", () => {
  const panels = cameraGridPanels(4, 4);
  it("selects a single panel a marquee sits on", () => {
    // Panel 7 = row 1, col 3.
    expect(touchedPanelIndices({ x: 0.76, y: 0.26, w: 0.2, h: 0.2 }, panels)).toEqual([7]);
  });
  it("selects every panel a 2x2 marquee overlaps", () => {
    expect(touchedPanelIndices({ x: 0, y: 0, w: 0.5, h: 0.5 }, panels)).toEqual([0, 1, 4, 5]);
  });
  it("selects a panel it only barely clips", () => {
    expect(touchedPanelIndices({ x: 0, y: 0, w: 0.1, h: 0.1 }, panels)).toEqual([0]);
    // Grazing a shared edge with zero area does not select the neighbour.
    expect(touchedPanelIndices({ x: 0.25, y: 0, w: 0, h: 1 }, panels)).toEqual([]);
  });
});

describe("unionGridRects", () => {
  it("covers every rect, returning null when empty", () => {
    expect(unionGridRects([])).toBeNull();
    expect(unionGridRects([{ x: 0, y: 0, w: 0.25, h: 0.25 }, { x: 0.75, y: 0.75, w: 0.25, h: 0.25 }]))
      .toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("labels", () => {
  it("falls back to Angle N", () => {
    expect(panelLabelFor(undefined, 0)).toBe("Angle 1");
    expect(panelLabelFor(["Front"], 0)).toBe("Front");
    expect(panelLabelFor(["Front"], 1)).toBe("Angle 2");
    expect(panelLabelFor(["  "], 4)).toBe("Angle 5");
    expect(resolvePanelLabels(3, ["Front"])).toEqual(["Front", "Angle 2", "Angle 3"]);
  });
});

describe("resolveCameraGridPanels", () => {
  it("derives cells when stored panels don't match the geometry", () => {
    expect(resolveCameraGridPanels({ cols: 4, rows: 4 })).toHaveLength(16);
    expect(resolveCameraGridPanels({ cols: 3, rows: 3 })).toHaveLength(9);
    expect(resolveCameraGridPanels({ cols: 2, rows: 2, panels: [{ x: 0, y: 0, w: 1, h: 1 }] })).toHaveLength(4);
  });
  it("keeps stored panels that match", () => {
    const stored = cameraGridPanels(2, 2);
    expect(resolveCameraGridPanels({ cols: 2, rows: 2, panels: stored })).toEqual(stored);
  });
});

describe("normalizeCameraGridData", () => {
  it("repairs a raw persisted value and defaults the geometry", () => {
    const d = normalizeCameraGridData({ sheetPath: "references/grids/g.png" });
    expect(d).toEqual({ cols: 4, rows: 4, sheetPath: "references/grids/g.png" });
  });
  it("drops malformed values", () => {
    expect(normalizeCameraGridData(null)).toBeUndefined();
    expect(normalizeCameraGridData("nope")).toBeUndefined();
  });
  it("keeps a generation with a prompt", () => {
    const d = normalizeCameraGridData({ cols: 4, rows: 4, generation: { provider: "openart", model: "m", prompt: "p" } });
    expect(d?.generation).toEqual({ provider: "openart", model: "m", prompt: "p" });
  });
  it("keeps the node's wiring and generation picks", () => {
    const d = normalizeCameraGridData({
      cols: 4,
      rows: 4,
      source: { kind: "ref", refId: "r1" },
      refIds: ["a", "b"],
      model: "higgsfield-cli:x",
      resolution: "2k",
      params: { variant: "sunburst", seed: 12 },
      inset: 0.12,
    });
    expect(d).toMatchObject({
      source: { kind: "ref", refId: "r1" },
      refIds: ["a", "b"],
      model: "higgsfield-cli:x",
      resolution: "2k",
      params: { variant: "sunburst" },
      inset: 0.12,
    });
  });
  it("keeps the grid-image wiring and drops a malformed one", () => {
    const d = normalizeCameraGridData({ cols: 4, rows: 4, gridSource: { kind: "ref", refId: "g1" }, sheetAt: "2026-01-01T00:00:00.000Z" });
    expect(d?.gridSource).toEqual({ kind: "ref", refId: "g1" });
    expect(d?.sheetAt).toBe("2026-01-01T00:00:00.000Z");
    const bad = normalizeCameraGridData({ cols: 4, rows: 4, gridSource: { kind: "editgen" } });
    expect(bad?.gridSource).toBeUndefined();
  });
  it("drops malformed wiring and non-string params", () => {
    const d = normalizeCameraGridData({
      cols: 4,
      rows: 4,
      source: { kind: "editgen" },
      refIds: ["a", 7, ""],
      params: { ok: "yes", bad: 1 },
    });
    expect(d?.source).toBeUndefined();
    expect(d?.refIds).toEqual(["a"]);
    expect(d?.params).toEqual({ ok: "yes" });
  });
});

describe("normalizeGraphSource", () => {
  it("accepts the three source shapes", () => {
    expect(normalizeGraphSource({ kind: "imagegen" })).toEqual({ kind: "imagegen" });
    expect(normalizeGraphSource({ kind: "editgen", nodeId: "edit1" })).toEqual({ kind: "editgen", nodeId: "edit1" });
    expect(normalizeGraphSource({ kind: "ref", refId: "r1" })).toEqual({ kind: "ref", refId: "r1" });
  });
  it("rejects malformed values", () => {
    expect(normalizeGraphSource(null)).toBeUndefined();
    expect(normalizeGraphSource({ kind: "editgen" })).toBeUndefined();
    expect(normalizeGraphSource({ kind: "ref", refId: "  " })).toBeUndefined();
    expect(normalizeGraphSource({ kind: "nope" })).toBeUndefined();
  });
});

describe("camera-grid reference slots", () => {
  it("appends on the open socket and places at a numbered slot", () => {
    expect(placeCameraGridRef(["a"], "b")).toEqual(["a", "b"]);
    expect(placeCameraGridRef(["a", "b"], "c", 0)).toEqual(["c", "b"]);
    expect(placeCameraGridRef(["a", "b"], "c", 5)).toEqual(["a", "b", "c"]);
  });
  it("moves a ref already wired instead of duplicating it", () => {
    expect(placeCameraGridRef(["a", "b"], "a")).toEqual(["b", "a"]);
  });
  it("removes the ref at a slot, no-op out of range", () => {
    expect(removeCameraGridRefAt(["a", "b", "c"], 1)).toEqual(["a", "c"]);
    expect(removeCameraGridRefAt(["a"], 3)).toEqual(["a"]);
  });
});

describe("isCameraGridSheetPath", () => {
  it("accepts production-relative paths and rejects escapes", () => {
    expect(isCameraGridSheetPath("references/grids/g.png")).toBe(true);
    expect(isCameraGridSheetPath("../secret.png")).toBe(false);
    expect(isCameraGridSheetPath("/etc/passwd")).toBe(false);
    expect(isCameraGridSheetPath("C:\\x.png")).toBe(false);
    expect(isCameraGridSheetPath(42)).toBe(false);
  });
});
