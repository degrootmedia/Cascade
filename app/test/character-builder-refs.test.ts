/**
 * Character builder reference wiring.
 *
 * The description box resolves a reference tile dragged from the References
 * panel through the raw id→name lookup: the tile carries a CustomRef id, and
 * for a mirrored character that id is absent from the name-deduped
 * `allPromptRefs` list the @ autocomplete uses. These two helpers are the seam
 * between the grid and the builder's drop handler.
 */
import { describe, it, expect } from "vitest";
import type { Production } from "../src/shared/ipc.js";
import { allPromptRefs, referenceNamesById } from "../src/renderer/src/components/production/references.js";

function makeProduction(overrides: Partial<Production> = {}): Production {
  const base: Production = {
    meta: { id: "prod-1", name: "Test Production", folder: "C:/workspace/test-production", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    currentStep: 2,
    visualStyle: "",
    styles: [],
    scenes: [],
    characters: [],
    products: [],
    references: [],
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
  };
  // Object.assign keeps the required fields non-optional even when a caller
  // passes a Partial (a plain spread would widen `status` to `| undefined`).
  return Object.assign(base, overrides);
}

describe("referenceNamesById", () => {
  it("resolves the mirrored character's CustomRef id that allPromptRefs dedupes away", () => {
    const p = makeProduction({
      characters: [{ id: "char-mara", name: "Mara", key: "", imagePath: "references/Mara.png" }],
      references: [{ id: "ref-mara", name: "Mara", imagePath: "references/Mara.png", shotIds: [] }],
    });
    // The autocomplete list keeps the character entry only.
    const promptRefs = allPromptRefs(p);
    expect(promptRefs.map((r) => r.id)).toEqual(["char-mara"]);
    // The drag lookup resolves both ids to the citable name.
    const byId = referenceNamesById(p);
    expect(byId.get("ref-mara")).toBe("Mara");
    expect(byId.get("char-mara")).toBe("Mara");
  });

  it("includes non-mirrored custom references by their own id", () => {
    const p = makeProduction({
      references: [{ id: "ref-gondola", name: "Gondola Interior", imagePath: "references/Gondola.png", shotIds: [] }],
    });
    expect(referenceNamesById(p).get("ref-gondola")).toBe("Gondola Interior");
    expect(allPromptRefs(p).map((r) => r.id)).toEqual(["ref-gondola"]);
  });
});
