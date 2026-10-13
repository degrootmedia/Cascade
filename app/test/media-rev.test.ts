import { describe, it, expect } from "vitest";
import { bumpMediaRev, mediaRev } from "../src/renderer/src/components/production/media-rev.js";

describe("media revision cache-buster", () => {
  it("starts at 0 and increments per file key on bump", () => {
    expect(mediaRev("p1", "boards/0100/a.jpg")).toBe(0);
    bumpMediaRev("p1", "boards/0100/a.jpg");
    expect(mediaRev("p1", "boards/0100/a.jpg")).toBe(1);
    bumpMediaRev("p1", "boards/0100/a.jpg");
    expect(mediaRev("p1", "boards/0100/a.jpg")).toBe(2);
    // A different file / production is independent.
    expect(mediaRev("p1", "boards/0100/b.jpg")).toBe(0);
    expect(mediaRev("p2", "boards/0100/a.jpg")).toBe(0);
  });
});
