import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("dragging an output into empty canvas", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../src/renderer/src/components/NodeGraphModal.tsx"), "utf8");
  it("opens an add-and-connect popup for image/video outputs", () => {
    expect(src).toContain('from.type === "source" && !readOnly');
    expect(src).toContain("setDropMenu(");
    expect(src).toContain("Add and connect");
    expect(src).toContain('{ id: "edit" as const, label: "Edit image" }');
    expect(src).toContain('{ id: "editvideo" as const, label: "Edit video" }');
  });
});
