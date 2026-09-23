/**
 * Camera-grid cutout (Spec 04). The decoder/path/writer/exists/id deps are
 * injected, so the whole crop → name → write → ref flow is tested with no
 * Electron and no disk.
 */
import { describe, it, expect } from "vitest";
import { cutoutCameraGrid, pixelRect, type CameraGridDeps, type CropImage } from "../src/main/camera-grid.js";

function fakeImage(width: number, height: number): CropImage {
  return {
    getSize: () => ({ width, height }),
    crop: (rect) => ({ toPNG: () => Buffer.from(JSON.stringify(rect)) }),
  };
}

function makeDeps(overrides: Partial<CameraGridDeps> = {}): { deps: CameraGridDeps; writes: { rel: string; bytes: Buffer }[] } {
  const writes: { rel: string; bytes: Buffer }[] = [];
  const existing = new Set<string>();
  let n = 0;
  const deps: CameraGridDeps = {
    decodeImage: () => fakeImage(400, 400),
    resolvePath: (rel) => `/prod/${rel}`,
    writeFile: (rel, bytes) => { writes.push({ rel, bytes }); existing.add(rel); },
    exists: (rel) => existing.has(rel),
    newRefId: () => `ref-${++n}`,
    ...overrides,
  };
  return { deps, writes };
}

describe("pixelRect", () => {
  it("maps a normalized rect to clamped pixels", () => {
    expect(pixelRect({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 400, 400)).toEqual({ x: 200, y: 200, width: 200, height: 200 });
  });
  it("returns null for a degenerate rect", () => {
    expect(pixelRect({ x: 0.5, y: 0.5, w: 0, h: 0.5 }, 400, 400)).toBeNull();
  });
  it("clamps out-of-range values", () => {
    expect(pixelRect({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 400, 400)).toEqual({ x: 360, y: 360, width: 40, height: 40 });
  });
});

describe("cutoutCameraGrid", () => {
  const base = {
    nodeId: "cameraGrid",
    referencesDir: "references",
    sheetPath: "references/grids/g.png",
    rects: [{ x: 0, y: 0, w: 0.25, h: 0.25 }, { x: 0.75, y: 0.75, w: 0.25, h: 0.25 }],
    labels: ["Front"],
    categoryId: "camera-grid",
  };

  it("crops one reference per rect, naming from labels with a fallback", () => {
    const { deps, writes } = makeDeps();
    const result = cutoutCameraGrid(base, deps);
    expect(result.refs).toHaveLength(2);
    expect(result.refs[0]).toMatchObject({ id: "ref-1", name: "Front", imagePath: "references/camera-grid-cameraGrid-1.png", categoryId: "camera-grid", shotIds: [] });
    expect(result.refs[1].name).toBe("Angle 2");
    expect(writes.map((w) => w.rel)).toEqual([
      "references/camera-grid-cameraGrid-1.png",
      "references/camera-grid-cameraGrid-2.png",
    ]);
  });

  it("suffixes a collision rather than overwriting", () => {
    const { deps } = makeDeps();
    cutoutCameraGrid(base, deps);
    const second = cutoutCameraGrid(base, deps);
    expect(second.refs[0].imagePath).toBe("references/camera-grid-cameraGrid-1-2.png");
  });

  it("skips degenerate rects", () => {
    const { deps, writes } = makeDeps();
    const result = cutoutCameraGrid({ ...base, rects: [{ x: 0, y: 0, w: 0, h: 0 }] }, deps);
    expect(result.refs).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it("throws when the sheet can't be decoded", () => {
    const { deps } = makeDeps({ decodeImage: () => null });
    expect(() => cutoutCameraGrid(base, deps)).toThrow(/couldn't be read/);
  });

  it("throws on a zero-dimension sheet", () => {
    const { deps } = makeDeps({ decodeImage: () => fakeImage(0, 0) });
    expect(() => cutoutCameraGrid(base, deps)).toThrow(/readable dimensions/);
  });

  it("sanitizes the node id in the filename", () => {
    const { deps } = makeDeps();
    const result = cutoutCameraGrid({ ...base, nodeId: "camera/grid:1" }, deps);
    expect(result.refs[0].imagePath).toBe("references/camera-grid-camera-grid-1-1.png");
  });
});
