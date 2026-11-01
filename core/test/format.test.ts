import { describe, it, expect, vi } from "vitest";
import { isFormattable } from "../src/format.js";

describe("format", () => {
  it("only formats known source types", () => {
    expect(isFormattable("a/b.ts")).toBe(true);
    expect(isFormattable("pic.png")).toBe(false);
  });
});
