import { describe, it, expect } from "vitest";
import { hasDraggedFiles } from "../src/renderer/src/drag-files.js";

describe("hasDraggedFiles", () => {
  it("accepts drags carrying files", () => expect(hasDraggedFiles({ types: ["text/plain", "Files"] })).toBe(true));
  it("ignores text-only drags and null", () => {
    expect(hasDraggedFiles({ types: ["text/plain"] })).toBe(false);
    expect(hasDraggedFiles(null)).toBe(false);
  });
});
