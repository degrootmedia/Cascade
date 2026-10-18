/**
 * media-menu tests — the pure resolver that decides which images/videos have a
 * real production file behind them (so "Open file folder" / "Edit externally"
 * can be offered). Inline data URLs and remote links resolve to null.
 */
import { describe, it, expect } from "vitest";
import { classifyCopyImageSource, resolveProductionFile } from "../src/main/media-menu.js";

describe("resolveProductionFile", () => {
  it("prefers an explicit productionId + relPath", () => {
    expect(resolveProductionFile({ productionId: "p1", relPath: "videos/shot-0100.mp4" })).toEqual({
      productionId: "p1",
      relPath: "videos/shot-0100.mp4",
    });
  });

  it("parses a cascade-media URL back into its production file", () => {
    // graphMediaUrl / cascadeMedia encode the rel path, including separators.
    expect(resolveProductionFile({ src: "cascade-media://p1/references%2Fhero.png" })).toEqual({
      productionId: "p1",
      relPath: "references/hero.png",
    });
  });

  it("returns null for inline data URLs and http links", () => {
    expect(resolveProductionFile({ src: "data:image/png;base64,AAAA" })).toBeNull();
    expect(resolveProductionFile({ src: "https://cdn.example.com/frame.png" })).toBeNull();
    expect(resolveProductionFile({})).toBeNull();
  });

  it("returns null for malformed cascade-media URLs", () => {
    expect(resolveProductionFile({ src: "cascade-media://p1" })).toBeNull();
  });
});

describe("classifyCopyImageSource", () => {
  it("prefers the production file behind an explicit target or cascade-media src", () => {
    expect(classifyCopyImageSource({ productionId: "p1", relPath: "boards/0100/frame.png", x: 5, y: 6 })).toEqual({
      kind: "file",
      file: { productionId: "p1", relPath: "boards/0100/frame.png" },
    });
    expect(classifyCopyImageSource({ src: "cascade-media://p1/references%2Fhero.png", x: 5, y: 6 })).toEqual({
      kind: "file",
      file: { productionId: "p1", relPath: "references/hero.png" },
    });
  });

  it("uses data URLs (explicit or as src) and http(s) URLs next", () => {
    expect(classifyCopyImageSource({ dataUrl: "data:image/png;base64,AAAA", x: 1, y: 2 })).toEqual({
      kind: "dataUrl",
      dataUrl: "data:image/png;base64,AAAA",
    });
    expect(classifyCopyImageSource({ src: "data:image/jpeg;base64,BBBB" })).toEqual({
      kind: "dataUrl",
      dataUrl: "data:image/jpeg;base64,BBBB",
    });
    expect(classifyCopyImageSource({ src: "https://cdn.example.com/frame.png", x: 1, y: 2 })).toEqual({
      kind: "url",
      url: "https://cdn.example.com/frame.png",
    });
  });

  it("falls back to page coords only for sources main cannot decode", () => {
    expect(classifyCopyImageSource({ src: "blob:http://localhost/abc", x: 7, y: 8 })).toEqual({ kind: "coords", x: 7, y: 8 });
    expect(classifyCopyImageSource({ src: "cascade-media://p1", x: 7, y: 8 })).toEqual({ kind: "coords", x: 7, y: 8 });
    expect(classifyCopyImageSource({ src: "blob:http://localhost/abc" })).toEqual({ kind: "none" });
    expect(classifyCopyImageSource({})).toEqual({ kind: "none" });
  });
});
