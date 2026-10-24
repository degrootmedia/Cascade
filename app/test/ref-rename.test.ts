/**
 * ref-rename tests — Design-page rename changes the reference's name and
 * rewrites every `@[oldName]` tag across the prompt stores that can cite it,
 * so its node graph follows the new name instead of disconnecting. Node and
 * connection identity is id-based (canvas placement, pipes, keyframes), so a
 * rename never touches them.
 */
import { describe, it, expect, vi } from "vitest";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { assignReferenceAlias, dismissCitedRefName, renameReference, shotReferences, uniqueReferenceName } from "../src/main/pipeline.js";

function makeShot(number: string, overrides: Partial<ProductionShot> = {}): ProductionShot {
  return { id: `shot-${number}`, number, audio: "", visual: `Visual ${number}`, ...overrides };
}

function makeProduction(shots: ProductionShot[]): Production {
  return {
    meta: { id: "prod-1", name: "Test", folder: "C:/test", createdAt: "", updatedAt: "", stepDone: 0, shotCount: shots.length },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: shots.map((shot) => ({ number: 1, title: "S1", shots: [shot] })),
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    references: [
      { id: "r1", name: "Hero", imagePath: "references/hero.png", shotIds: [] },
      { id: "r2", name: "Sidekick", imagePath: "references/sidekick.png", shotIds: [] },
    ],
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models", videosDir: "videos" },
  } as Production;
}

const noop = () => {};

describe("renameReference", () => {
  it("renames the entry and rewrites its tags across every prompt store", () => {
    const shot = makeShot("0100", {
      prompt: "@[Hero] standing in the valley",
      graphEditPrompt: "next edit @[Hero]",
      graphVideoNodes: [
        { id: "vid0", prompt: "slow push in @[Hero]" },
        { id: "ev0", mode: "edit", prompt: "grade @[Hero]" },
      ],
      graphTweenBlocks: [
        { id: "tw0", startRefId: "r1", endRefId: "r2", prompt: "turn toward @[hero]", startSec: 0, durationSec: 2 },
      ],
      graphEditNodes: [
        { id: "edit0", prompt: "make it night @[Hero]", source: { kind: "ref", refId: "r1" } },
      ],
      graphOutputSource: "ref",
      graphOutputRefId: "r1",
      graphVideoSourceRefId: "r1",
      graphTweenRefIds: ["r1", "r2"],
      graphLayout: { positions: { "ref:r1": { x: 0, y: 116 } } },
    });
    const p = makeProduction([shot]);
    (p as unknown as Record<string, unknown>).magicPrompts = { "shot-0100": "hello @[Hero]" };

    renameReference(p, "r1", "Champion", noop);

    // Entry renamed; the other reference and all id-based wiring untouched.
    expect(p.references?.map((r) => r.name)).toEqual(["Champion", "Sidekick"]);
    expect(shot.graphOutputRefId).toBe("r1");
    expect(shot.graphVideoSourceRefId).toBe("r1");
    expect(shot.graphTweenRefIds).toEqual(["r1", "r2"]);
    expect(shot.graphEditNodes?.[0].source).toEqual({ kind: "ref", refId: "r1" });
    expect(shot.graphLayout?.positions?.["ref:r1"]).toEqual({ x: 0, y: 116 });

    // Tags rewritten everywhere (case-insensitive), no old-name stragglers.
    expect(shot.prompt).toBe("@[Champion] standing in the valley");
    expect(shot.graphVideoNodes?.find((n) => n.id === "vid0")?.prompt).toBe("slow push in @[Champion]");
    expect(shot.graphEditPrompt).toBe("next edit @[Champion]");
    expect(shot.graphVideoNodes?.find((n) => n.id === "ev0")?.prompt).toBe("grade @[Champion]");
    expect(shot.graphEditNodes?.[0].prompt).toBe("make it night @[Champion]");
    expect(shot.graphTweenBlocks?.[0].prompt).toBe("turn toward @[Champion]");
    expect((p as unknown as Record<string, { [k: string]: string }>).magicPrompts["shot-0100"]).toBe("hello @[Champion]");
  });

  it("keeps the old name as an alias so stale/external tags still resolve", () => {
    const shot = makeShot("0100", { prompt: "@[Hero] standing" });
    const p = makeProduction([shot]);

    renameReference(p, "r1", "Champion", noop);

    expect(p.references?.find((r) => r.id === "r1")?.aliases).toEqual(["Hero"]);
  });

  it("leaves other references' tags alone", () => {
    const shot = makeShot("0100", { prompt: "@[Hero] and @[Sidekick] together" });
    const p = makeProduction([shot]);

    renameReference(p, "r1", "Champion", noop);

    expect(shot.prompt).toBe("@[Champion] and @[Sidekick] together");
  });

  it("appends _dup when another reference already owns the name", () => {
    const shot = makeShot("0100", { prompt: "@[Hero]" });
    const p = makeProduction([shot]);

    renameReference(p, "r1", "Sidekick", noop);

    expect(p.references?.map((r) => r.name)).toEqual(["Sidekick_dup", "Sidekick"]);
    expect(shot.prompt).toBe("@[Sidekick_dup]");
  });

  it("keeps appending _dup until the name is free (case-insensitive)", () => {
    const p = makeProduction([]);
    p.references = [
      { id: "r1", name: "Hero", imagePath: "references/hero.png", shotIds: [] },
      { id: "r2", name: "Champion", imagePath: "references/a.png", shotIds: [] },
      { id: "r3", name: "champion_dup", imagePath: "references/b.png", shotIds: [] },
    ];

    expect(uniqueReferenceName(p, "r1", "Champion")).toBe("Champion_dup_dup");
    expect(uniqueReferenceName(p, "r1", "Champion_dup_dup")).toBe("Champion_dup_dup");
  });

  it("is a no-op when the name is unchanged and rejects unknown/empty names", () => {
    const shot = makeShot("0100", { prompt: "@[Hero]" });
    const p = makeProduction([shot]);

    expect(renameReference(p, "r1", "Hero", noop)).toBe(p);

    expect(() => renameReference(p, "nope", "Champion", noop)).toThrow("Reference not found.");
    expect(() => renameReference(p, "r1", "   ", noop)).toThrow("Reference name can't be empty.");
    expect(p.references?.[0].name).toBe("Hero");
    expect(shot.prompt).toBe("@[Hero]");
  });
});

describe("assignReferenceAlias (Magic Prompt reconciliation)", () => {
  it("slots the user's ref under a model name: alias saved, tags canonicalized everywhere", () => {
    const shot = makeShot("0100", { prompt: "The @[MainCharacter] walks. @[Sidekick] follows." });
    const p = makeProduction([shot]);
    (p as unknown as Record<string, unknown>).magicPrompts = { "shot-0100": "@[maincharacter] at dawn" };

    assignReferenceAlias(p, "MainCharacter", "r1", noop);

    expect(p.references?.find((r) => r.id === "r1")?.aliases).toEqual(["MainCharacter"]);
    expect(shot.prompt).toBe("The @[Hero] walks. @[Sidekick] follows.");
    expect((p as unknown as Record<string, { [k: string]: string }>).magicPrompts["shot-0100"]).toBe("@[Hero] at dawn");
  });

  it("an alias tag resolves the reference image even before any rewrite", () => {
    const shot = makeShot("0100", { prompt: "@[MainCharacter] at dawn" });
    const p = makeProduction([shot]);
    p.references![0].aliases = ["MainCharacter"];
    // No artwork file exists in the fixture, but name resolution must match:
    // shotReferences returns the entry (artwork read is best-effort).
    expect(shotReferences(p, shot).map((r) => r.name)).toEqual(["Hero"]);
  });

  it("refuses a cited name another reference already owns, and unknown targets", () => {
    const p = makeProduction([makeShot("0100")]);
    expect(() => assignReferenceAlias(p, "Sidekick", "r1", noop)).toThrow(/already belongs to Sidekick/);
    expect(() => assignReferenceAlias(p, "Anything", "nope", noop)).toThrow("Reference not found.");
    expect(() => assignReferenceAlias(p, "  ", "r1", noop)).toThrow(/empty/);
  });

  it("assigning a character binds the matching bible entity and clears its dismissal", () => {
    const p = makeProduction([makeShot("0100", { prompt: "@[Ada] walks" })]);
    p.characters = [{ id: "c1", name: "Heroine", key: "red cloak" } as Production["characters"][number]];
    p.magicDismissedRefs = ["ada"];
    p.magicBible = {
      version: 1, synopsis: "s", assumptions: [], scenes: [],
      entities: [{ name: "Ada", kind: "character", descriptor: "red cloak" }],
      shotPlans: [], inputHash: "h", generatedAt: "2026-01-01",
    };

    assignReferenceAlias(p, "Ada", "c1", noop);

    expect(p.characters[0].aliases).toEqual(["Ada"]);
    expect(p.magicBible.entities[0].refName).toBe("Heroine");
    expect(p.magicDismissedRefs).toEqual([]);
  });

  it("dismiss turns the tag into the plain noun everywhere and remembers the name", () => {
    const shot = makeShot("0100", { prompt: "A @[WeatherVane] spins above @[Hero]." });
    const p = makeProduction([shot]);
    (p as unknown as Record<string, unknown>).magicPrompts = { "shot-0100": "The @[weathervane] again" };

    dismissCitedRefName(p, "WeatherVane", noop);

    expect(shot.prompt).toBe("A WeatherVane spins above @[Hero].");
    expect((p as unknown as Record<string, { [k: string]: string }>).magicPrompts["shot-0100"]).toBe("The WeatherVane again");
    expect(p.magicDismissedRefs).toEqual(["weathervane"]);
  });
});
