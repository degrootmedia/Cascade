import { describe, it, expect } from "vitest";
import { closestResolution } from "../src/shared/resolution.js";

describe("closestResolution (Flux 2 regression)", () => {
  it("clamps an unsupported 4k pick to the model's largest tier, not its 1k default", () => {
    expect(closestResolution("4k", ["1k", "2k"])).toBe("2k");
  });
  it("keeps a supported pick", () => {
    expect(closestResolution("2k", ["1k", "2k"])).toBe("2k");
  });
});
