/**
 * media-menu tests — the pure resolver that decides which images/videos have a
 * real production file behind them (so "Open file folder" / "Edit externally"
 * can be offered). Inline data URLs and remote links resolve to null.
 */
import { describe, it, expect } from "vitest";
import { resolveProductionFile } from "../src/main/media-menu.js";

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
