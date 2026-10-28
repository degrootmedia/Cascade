/**
 * Style-tagged references must never be uploaded with a generation payload.
 * The style tag may remain as prompt/LLM context (the bare name), but the
 * style reference file itself must not ride along — not as an automatic
 * attachment, and not via an explicit @[Name] citation. Removing the style
 * tag (explicit non-style purpose) restores normal cited-upload behavior.
 */
import { describe, it, expect, vi } from "vitest";
import type { Production, ProductionShot } from "../src/shared/ipc.js";
import { resolvePromptRefs, styleRefNames } from "../src/main/providers/refs.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { shotReferences } from "../src/main/pipeline.js";

function makeProduction(overrides: Partial<Production> = {}): Production {
  return {
    meta: { id: "prod-1", name: "Test Production", folder: "C:/workspace/test-production", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    currentStep: 1,
    visualStyle: "",
    styles: [],
    scenes: [],
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    ...overrides,
  } as Production;
}

const STYLE_REFS = [
  { id: "s-flag", name: "Noir", artwork: "data:image/png;base64,AAAA", styleOnly: true },
  { id: "s-purpose", name: "Sepia", artwork: "data:image/png;base64,BBBB", purpose: "style" as const },
  { id: "s-cat", name: "Bleach", artwork: "data:image/png;base64,CCCC", categoryId: "cat-style" },
  { id: "c-hero", name: "Hero", artwork: "data:image/png;base64,DDDD" },
];
const STYLE_CATS = [{ id: "cat-style", name: "Looks", kind: "style" as const }];

describe("style-tagged references never upload (resolvePromptRefs)", () => {
  it("does not auto-attach any style-tagged ref when nothing cites it", () => {
    const p = makeProduction({ references: STYLE_REFS as never, referenceCategories: STYLE_CATS as never });
    const { extras } = resolvePromptRefs(p, "a plain shot with no citations", 0);
    expect(extras).toEqual([]);
  });

  it("keeps a cited style ref as bare-name context without uploading it", () => {
    const p = makeProduction({ references: STYLE_REFS as never, referenceCategories: STYLE_CATS as never });
    const { resolved, extras } = resolvePromptRefs(p, "@[Noir] mood, @[Hero] walks in", 0);
    expect(extras.map((e) => e.name)).toEqual(["Hero"]);
    // Style tag survives as text context; content token numbering is unshifted.
    expect(resolved).toBe("Noir mood, @image1 walks in");
  });

  it("excludes purpose-style and category-style refs even when cited", () => {
    const p = makeProduction({ references: STYLE_REFS as never, referenceCategories: STYLE_CATS as never });
    const { resolved, extras } = resolvePromptRefs(p, "@[Sepia] and @[Bleach] and @[Hero]", 0);
    expect(extras.map((e) => e.name)).toEqual(["Hero"]);
    expect(resolved).toBe("Sepia and Bleach and @image1");
  });

  it("excludes a style ref cited by alias", () => {
    const p = makeProduction({
      references: [
        { id: "s1", name: "Noir", aliases: ["DarkLook"], artwork: "data:image/png;base64,AAAA", styleOnly: true },
        { id: "c1", name: "Hero", artwork: "data:image/png;base64,DDDD" },
      ] as never,
      referenceCategories: [] as never,
    });
    const { resolved, extras } = resolvePromptRefs(p, "@[DarkLook] with @[Hero]", 0);
    expect(extras.map((e) => e.name)).toEqual(["Hero"]);
    expect(resolved).toBe("Noir with @image1");
  });

  it("treats an inferred style purpose as tagged until the user overrides it", () => {
    const inferred = makeProduction({
      references: [{ id: "r1", name: "LookDev 01", artwork: "data:image/png;base64,AAAA" }] as never,
      referenceCategories: [] as never,
    });
    expect(resolvePromptRefs(inferred, "use @[LookDev 01]", 0).extras).toEqual([]);

    const overridden = makeProduction({
      references: [{ id: "r1", name: "LookDev 01", artwork: "data:image/png;base64,AAAA", purpose: "subject" }] as never,
      referenceCategories: [] as never,
    });
    const out = resolvePromptRefs(overridden, "use @[LookDev 01]", 0);
    expect(out.extras.map((e) => e.name)).toEqual(["LookDev 01"]);
    expect(out.resolved).toBe("use @image1");
  });

  it("still uploads a same-named character that shadows a style reference", () => {
    const p = makeProduction({
      characters: [{ id: "ch1", name: "Hero", key: "", artwork: "data:image/png;base64,Q0hBUg==" }] as never,
      references: [{ id: "s1", name: "Hero", artwork: "data:image/png;base64,U1RZTEU=", styleOnly: true }] as never,
      referenceCategories: [] as never,
    });
    const { extras } = resolvePromptRefs(p, "show @[Hero]", 0);
    expect(extras).toEqual([{ name: "Hero", dataUrl: "data:image/png;base64,Q0hBUg==" }]);
  });

  it("styleRefNames covers every tagging signal", () => {
    const p = makeProduction({ references: STYLE_REFS as never, referenceCategories: STYLE_CATS as never });
    expect([...styleRefNames(p)].sort()).toEqual(["bleach", "noir", "sepia"]);
  });
});

describe("style-tagged references never upload (shotReferences)", () => {
  const shot = { id: "s1", number: "0100", audio: "", visual: "x", prompt: "@[Noir] mood with @[Hero]" } as ProductionShot;

  it("returns only cited content refs, never style-tagged ones", () => {
    const p = makeProduction({ references: STYLE_REFS as never, referenceCategories: STYLE_CATS as never });
    expect(shotReferences(p, shot).map((r) => r.name)).toEqual(["Hero"]);
  });

  it("adds nothing when the prompt cites nothing", () => {
    const p = makeProduction({ references: STYLE_REFS as never, referenceCategories: STYLE_CATS as never });
    const plain = { ...shot, prompt: "no citations" } as ProductionShot;
    expect(shotReferences(p, plain)).toEqual([]);
  });
});
