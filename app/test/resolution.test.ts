import { describe, expect, it } from "vitest";
import { closestResolution } from "../src/renderer/src/components/resolution.js";

describe("closestResolution", () => {
  it("keeps a selection the new model supports", () => {
    expect(closestResolution("1080p", ["720p", "1080p", "4k"])).toBe("1080p");
  });

  it("picks the numerically closest supported resolution", () => {
    expect(closestResolution("1080p", ["480p", "720p"])).toBe("720p");
    expect(closestResolution("1440p", ["480p", "1080p", "4k"])).toBe("1080p");
    expect(closestResolution("2k", ["1080p", "4k"])).toBe("1080p");
    expect(closestResolution("3k", ["1080p", "4k"])).toBe("4k");
  });

  it("breaks distance ties toward the smaller (cheaper) resolution", () => {
    expect(closestResolution("960p", ["720p", "1200p"])).toBe("720p");
  });

  it("falls back to the first entry for unparseable selections", () => {
    expect(closestResolution("cinematic", ["720p", "1080p"])).toBe("720p");
  });

  it("returns the selection unchanged when nothing is available", () => {
    expect(closestResolution("1080p", [])).toBe("1080p");
  });
});
