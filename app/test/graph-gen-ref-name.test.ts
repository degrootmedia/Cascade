import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

describe("generation output wired into a reference socket", () => {
  const modal = read("../src/renderer/src/components/NodeGraphModal.tsx");
  it("is saved under the node's name (no popup) and wired/tagged", () => {
    expect(modal).toContain("Edit Image #${Number(m[1]) + 1}");
    expect(modal).toContain("generationNodeRefName(canonicalNodeId(conn.source))");
    expect(modal).toContain("onSaveGenerationAsReference(rel, name)");
    const ws = read("../src/renderer/src/components/ProductionWorkspace.tsx");
    expect(ws).toContain("name ? { name } : await promptReferenceSave");
  });
});
