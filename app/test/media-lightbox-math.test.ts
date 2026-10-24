/**
 * Pure zoom/pan math behind the shared media lightbox: fit sizing,
 * cursor-anchored zoom, and pan clamping.
 */
import { describe, it, expect } from "vitest";
import {
  LIGHTBOX_IDENTITY,
  LIGHTBOX_MAX_ZOOM,
  lightboxClampPan,
  lightboxFitSize,
  lightboxZoomAt,
  lightboxZoomTo,
} from "../src/renderer/src/components/common/media-lightbox-math.js";

describe("lightboxFitSize", () => {
  it("downscales a large image to fit, preserving aspect", () => {
    expect(lightboxFitSize(4000, 2000, 1000, 1000)).toEqual({ w: 1000, h: 500 });
    expect(lightboxFitSize(2000, 4000, 1000, 1000)).toEqual({ w: 500, h: 1000 });
  });

  it("upscales a small image to fill the stage", () => {
    expect(lightboxFitSize(250, 250, 1000, 500)).toEqual({ w: 500, h: 500 });
  });

  it("survives degenerate inputs", () => {
    expect(lightboxFitSize(0, 100, 100, 100)).toEqual({ w: 1, h: 1 });
    expect(lightboxFitSize(100, 100, 0, 100)).toEqual({ w: 1, h: 1 });
  });
});

describe("lightboxZoomAt", () => {
  it("zooming at the center keeps the image centered", () => {
    expect(lightboxZoomAt(LIGHTBOX_IDENTITY, 0, 0, 2)).toEqual({ x: 0, y: 0, zoom: 2 });
  });

  it("keeps the image point under the cursor fixed", () => {
    // Cursor 100px right of center at zoom 1 sits over fit-point (100, 40);
    // after zooming 3x that point must still be under the cursor.
    const vp = lightboxZoomAt(LIGHTBOX_IDENTITY, 100, 40, 3);
    expect(vp.zoom).toBe(3);
    expect((100 - vp.x) / vp.zoom).toBeCloseTo(100);
    expect((40 - vp.y) / vp.zoom).toBeCloseTo(40);
  });

  it("clamps zoom to [1, 8]", () => {
    expect(lightboxZoomAt(LIGHTBOX_IDENTITY, 0, 0, 100).zoom).toBe(LIGHTBOX_MAX_ZOOM);
    expect(lightboxZoomAt({ x: 5, y: 5, zoom: 2 }, 0, 0, 0.01).zoom).toBe(1);
  });

  it("lightboxZoomTo hits an absolute zoom", () => {
    expect(lightboxZoomTo(LIGHTBOX_IDENTITY, 0, 0, 2.5).zoom).toBe(2.5);
    expect(lightboxZoomTo({ x: 0, y: 0, zoom: 4 }, 0, 0, 2).zoom).toBe(2);
  });
});

describe("lightboxClampPan", () => {
  it("recenters exactly at fit zoom", () => {
    expect(lightboxClampPan({ x: 50, y: -30, zoom: 1 }, 800, 600, 800, 600))
      .toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("allows panning to the edge but no further", () => {
    // Fit 800x600 in an 800x600 stage at zoom 2: overflow is 400x300 per side.
    const vp = lightboxClampPan({ x: 9999, y: -9999, zoom: 2 }, 800, 600, 800, 600);
    expect(vp).toEqual({ x: 400, y: -300, zoom: 2 });
  });

  it("locks the axis where the zoomed image is narrower than the stage", () => {
    // Portrait fit (300 wide) in a wide stage: even at zoom 2 it is 600 < 800.
    const vp = lightboxClampPan({ x: 120, y: 120, zoom: 2 }, 800, 600, 300, 600);
    expect(vp.x).toBe(0);
    expect(vp.y).toBe(120);
  });
});
