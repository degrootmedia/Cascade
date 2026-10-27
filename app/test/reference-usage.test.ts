/**
 * Reference usage — the "is this reference in use" truth behind the node icon
 * on reference tiles and the delete confirm. A reference counts when a
 * prompt cites it by @[Name] tag (name or alias), when a shot has it
 * attached or wired into its node graph, or when it auto-attaches as style.
 * Generation-node sentinels stored beside real ids must never count, and an
 * unused reference must be absent from the map.
 */
import { describe, it, expect } from "vitest";
import { formatReferenceUsage, referenceUsage } from "../src/shared/reference-usage.js";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

function shot(over: Partial<ProductionShot> = {}): ProductionShot {
  return { id: "s1", number: "0100", audio: "", visual: "", ...over };
}

function prod(over: Partial<Production> = {}): Production {
  return {
    meta: { id: "p1", name: "Prod", folder: "C:/workspace/prod", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: [{ number: 1, title: "S1", shots: [shot()] }],
    characters: [],
    products: [],
    references: [],
    referenceCategories: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    ...over,
  } as Production;
}

function withShot(over: Partial<ProductionShot>, prodOver: Partial<Production> = {}): Production {
  return prod({ scenes: [{ number: 1, title: "S1", shots: [shot(over)] }], ...prodOver });
}

const hero = { id: "r-hero", name: "Hero Cape", imagePath: "references/hero.png" };
const silk = { id: "r-silk", name: "Silk", aliases: ["Red Silk"], imagePath: "references/silk.png" };

describe("referenceUsage", () => {
  it("counts a @[Name] tag in the shot prompt", () => {
    const p = withShot({ number: "0300", prompt: "The @[Hero Cape] billows" }, { references: [hero, silk] });
    const usage = referenceUsage(p);
    expect(usage.get("r-hero")).toEqual({ tagShots: ["0300"], wiredShots: [], other: [] });
    expect(usage.has("r-silk")).toBe(false);
  });

  it("counts a tag by alias in node prompts and magic prompts", () => {
    const p = withShot(
      {
        number: "0500",
        graphVideoNodes: [{ id: "vid0", prompt: "@[Red Silk] drifts" }],
        graphTweenBlocks: [{ id: "tw0", startRefId: "imagegen", endRefId: "editgen:edit0", prompt: "past @[Hero Cape]", startSec: 0, durationSec: 2 }],
      },
      { references: [hero, silk], magicPrompts: { s1: "@[Silk] again" } },
    );
    const usage = referenceUsage(p);
    expect(usage.get("r-silk")?.tagShots).toEqual(["0500"]);
    expect(usage.get("r-hero")?.tagShots).toEqual(["0500"]);
  });

  it("counts wiring: output pipe, node sources, ref sockets, tween keys, attachments, edges", () => {
    const p = withShot(
      {
        number: "0200",
        refIds: ["r-hero"],
        graphOutputSource: "ref",
        graphOutputRefId: "r-silk",
        graphVideoNodes: [{ id: "vid0", prompt: "", source: { kind: "ref", refId: "r-hero" }, refIds: ["imagegen", "r-silk"] }],
        graphEditNodes: [{ id: "edit0", prompt: "", source: { kind: "ref", refId: "r-silk" } }],
        graphTweenRefIds: ["imagegen", "r-hero", "editgen:edit0"],
        graphCameraGrid: { cols: 4, rows: 4, refIds: ["r-silk"] },
        graph: {
          version: 1,
          nodes: [{ id: "ref:r-hero", kind: "ref", pos: { x: 0, y: 0 } }],
          edges: [
            { id: "e1", from: { node: "ref:r-hero", port: "out" }, to: { node: "composer", port: "in" } },
            { id: "e2", from: { node: "ref:seqframe:s1", port: "out" }, to: { node: "composer", port: "in" } },
            { id: "e3", from: { node: "ref:missing-0", port: "out" }, to: { node: "composer", port: "in" } },
          ],
        },
      },
      { references: [hero, { ...silk, shotIds: ["s1"] }] },
    );
    const usage = referenceUsage(p);
    expect(usage.get("r-hero")?.wiredShots).toEqual(["0200"]);
    expect(usage.get("r-silk")?.wiredShots).toEqual(["0200"]);
    expect(usage.has("imagegen")).toBe(false);
    expect(usage.has("seqframe:s1")).toBe(false);
  });

  it("counts outdated shots and ignores ids no longer in the pool", () => {
    const p = prod({
      references: [hero],
      scenes: [{ number: 1, title: "S1", shots: [shot({ refIds: ["r-gone"] })] }],
      outdatedShots: [shot({ id: "old", number: "0900", prompt: "@[Hero Cape]" })],
    });
    const usage = referenceUsage(p);
    expect(usage.get("r-hero")?.tagShots).toEqual(["0900"]);
    expect(usage.has("r-gone")).toBe(false);
  });

  it("counts style auto-attach but not mere category membership", () => {
    const p = prod({
      referenceCategories: [
        { id: "cat-style", name: "Looks", kind: "style" },
        { id: "cat-props", name: "Props" },
      ],
      references: [
        { id: "r-a", name: "A", styleOnly: true },
        { id: "r-b", name: "B", categoryId: "cat-style" },
        { id: "r-c", name: "C", purpose: "style" },
        { id: "r-d", name: "D", categoryId: "cat-props" },
      ],
    });
    const usage = referenceUsage(p);
    for (const id of ["r-a", "r-b", "r-c"]) {
      expect(usage.get(id)?.other, id).toEqual(["auto-attached style reference"]);
    }
    expect(usage.has("r-d")).toBe(false);
  });

  it("counts character-text citations, style prompts, and Magic casting", () => {
    const p = prod({
      characters: [
        { id: "c-mara", name: "Mara", key: "wears @[Silk]", builder: { description: "with @[Hero Cape]", view: "front", model: "m", resolution: "1k" } },
      ],
      styles: [{ id: "st1", index: 1, name: "Heroic", prompt: "grade like @[Silk]" }],
      references: [hero, silk],
      magicRefDecisions: { Mara: { entityName: "Mara", refIds: ["r-hero"], updatedAt: "" } },
    });
    const usage = referenceUsage(p);
    expect(usage.get("r-hero")?.other).toEqual(expect.arrayContaining(["cast by Magic", "cited in character text"]));
    expect(usage.get("r-silk")?.other).toEqual(expect.arrayContaining(["cited in a style prompt", "cited in character text"]));
  });

  it("same-name twins share the verdict (generation resolves the tag to the character, both report in use)", () => {
    // The tag resolves to the character (characters shadow same-named
    // references, as generation resolves it), and the graph wire names the
    // character's id — but deleting the shadowed reference would strip the
    // @[Mara] tags by name and unlink the shared image file, so both twins
    // carry the union verdict.
    const p = withShot(
      {
        prompt: "@[Mara] enters",
        graph: {
          version: 1,
          nodes: [{ id: "ref:c-mara", kind: "ref", pos: { x: 0, y: 0 } }],
          edges: [{ id: "e1", from: { node: "ref:c-mara", port: "out" }, to: { node: "composer", port: "in" } }],
        },
      },
      {
        characters: [{ id: "c-mara", name: "Mara", key: "" }],
        references: [{ id: "r-mara", name: "Mara", imagePath: "references/mara.png" }],
      },
    );
    const usage = referenceUsage(p);
    expect(usage.get("c-mara")).toEqual({ tagShots: ["0100"], wiredShots: ["0100"], other: [] });
    expect(usage.get("r-mara")).toEqual({ tagShots: ["0100"], wiredShots: ["0100"], other: [] });
  });

  it("counts a moodboard placement, but not mere shelf/category membership", () => {
    const p = prod({
      references: [hero, silk],
      moodboard: {
        version: 1,
        nodes: [{ refId: "r-hero", x: 0, y: 0, w: 100, h: 80, z: 1 }],
        viewport: { x: 0, y: 0, zoom: 1 },
        frames: [{ id: "f1", x: 0, y: 0, w: 10, h: 10, label: "F", color: "red", refIds: ["r-hero"] }],
      },
    });
    const usage = referenceUsage(p);
    expect(usage.get("r-hero")?.other).toEqual(["placed on the moodboard"]);
    expect(usage.has("r-silk")).toBe(false);
  });

  it("formats a compact summary with capped shot lists", () => {
    expect(formatReferenceUsage({ tagShots: ["0200"], wiredShots: ["0300", "0500"], other: [] }))
      .toBe("wired into Shot 0300, Shot 0500 · tagged in Shot 0200");
    expect(formatReferenceUsage({ tagShots: [], wiredShots: ["0100", "0200", "0300", "0400", "0500", "0600"], other: ["cast by Magic"] }))
      .toBe("wired into Shot 0100, Shot 0200, Shot 0300, Shot 0400 +2 more · cast by Magic");
  });
});
