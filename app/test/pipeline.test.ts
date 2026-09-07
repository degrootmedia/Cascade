/**
 * pipeline tests — the prompt-derivation core of the production pipeline.
 *
 * These pure functions (parseBreakdownJson, normalizeScenes, boardPrompt,
 * effectivePrompt, shotReferences, refTokens, …) hold the real generation
 * logic. With pipeline.ts now importing Electron only as a soft dependency,
 * the module loads in plain node and this suite can pin its behavior — the
 * same code the OpenArtClient and the renderer depend on.
 */
import { describe, it, expect, vi } from "vitest";
import type { Production, ProductionScene, ProductionShot } from "../src/shared/ipc.js";

// pipeline.ts imports scripting.ts for its text-extraction helpers; the tests
// never touch them, and scripting's dynamic pdf-parse import doesn't resolve
// under Vitest — so the module is replaced with a factory instead.
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import {
  applyVideoOutput,
  boardPrompt,
  brandPrompt,
  characterSheetPrompt,
  effectivePrompt,
  formatRuntime,
  hookImageGenToOutput,
  hookVideoGenToOutput,
  mergeCharacters,
  mergeProducts,
  normalizeScenes,
  parseBreakdownJson,
  openArtPrompt,
  recordGraphEditGen,
  refTokens,
  resolveReferenceTags,
  resolveShotStyle,
  scriptMarkdown,
  shotReferences,
  syncBoardOutputToPipe,
  upsertCharacterSheetRef,
} from "../src/main/pipeline.js";

// ---- fixture ---------------------------------------------------------------

function makeShot(overrides: Partial<ProductionShot> = {}): ProductionShot {
  return {
    id: crypto.randomUUID(),
    number: "0100",
    audio: "",
    visual: "A hero walks through the valley.",
    ...overrides,
  };
}

function makeScene(shots: ProductionShot[], title = "Arrival"): ProductionScene {
  return { number: 1, title, shots };
}

function makeProduction(overrides: Partial<Production> = {}): Production {
  return {
    meta: { id: "prod-1", name: "Test Production", folder: "C:/workspace/test-production", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 1 },
    currentStep: 1,
    visualStyle: "",
    styles: [{ id: "s-master", index: 1, name: "Heroic 3D", prompt: "Heroic 3D render style" }],
    scenes: [makeScene([makeShot()])],
    characters: [{ id: "c-gandalf", name: "Gandalf", key: "grey wizard with a staff" }],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    ...overrides,
  };
}

// ---- tests -----------------------------------------------------------------

describe("parseBreakdownJson", () => {
  it("parses fenced JSON with trailing prose", () => {
    const raw = '```json\n{"scenes":[{"title":"S1","shots":[{"audio":"Hi","visual":"Wide shot"}]}]}\n``` thanks';
    const parsed = parseBreakdownJson(raw);
    expect(parsed.scenes).toHaveLength(1);
    expect(parsed.scenes[0].shots?.[0]?.visual).toBe("Wide shot");
  });

  it("throws when no JSON object is present", () => {
    expect(() => parseBreakdownJson("no json here")).toThrow(/no JSON object/i);
  });
});

describe("normalizeScenes", () => {
  it("assigns the 100-grid numbering and drops empty rows/scenes", () => {
    const scenes = normalizeScenes({
      scenes: [
        { title: "S1", shots: [
          { audio: "Hello", visual: "" },
          { audio: "", visual: "" }, // empty noise row — skipped
          { audio: "", visual: "Wide shot" },
        ] },
        { title: "", shots: [{ audio: "", visual: "" }] }, // scene with no shots — skipped
        { title: "S2", shots: [{ audio: "Bye", visual: "Close-up" }] },
      ],
    });
    expect(scenes).toHaveLength(2);
    expect(scenes[0].shots.map((s) => s.number)).toEqual(["0100", "0200"]);
    expect(scenes[1].shots.map((s) => s.number)).toEqual(["0300"]);
    expect(scenes[0].title).toBe("S1");
    expect(scenes[1].title).toBe("S2");
  });
});

describe("mergeCharacters / mergeProducts", () => {
  it("dedupes case-insensitively and preserves existing artwork/key", () => {
    const existing = [{ id: "c1", name: "Gandalf", key: "old key", artwork: "data:image/png;base64,QUFBQQ==" }];
    const merged = mergeCharacters(
      [
        { name: "gandalf", key: "grey wizard" }, // case-insensitive match
        { name: "Aragorn", key: "ranger" },
      ],
      existing
    );
    expect(merged).toHaveLength(2);
    const g = merged.find((c) => c.name === "Gandalf")!;
    expect(g.id).toBe("c1"); // existing id preserved
    expect(g.artwork).toBe("data:image/png;base64,QUFBQQ=="); // artwork preserved
    expect(g.key).toBe("grey wizard"); // fresh key wins
    expect(merged.some((c) => c.name === "Aragorn")).toBe(true);
  });

  it("keeps existing characters the model didn't mention", () => {
    const existing = [{ id: "c1", name: "Legolas", key: "elf" }];
    const merged = mergeCharacters([{ name: "Aragorn", key: "ranger" }], existing);
    expect(merged.map((c) => c.name).sort()).toEqual(["Aragorn", "Legolas"]);
  });

  it("merges products without dropping existing ones", () => {
    const merged = mergeProducts(["The One Ring"], [{ id: "p1", name: "Sting" }]);
    expect(merged.map((p) => p.name).sort()).toEqual(["Sting", "The One Ring"]);
  });
});

describe("resolveShotStyle", () => {
  it("resolves by id, then name, then literal text", () => {
    const p = makeProduction();
    expect(resolveShotStyle(p, makeShot({ style: "s-master" }))).toBe("Heroic 3D render style");
    expect(resolveShotStyle(p, makeShot({ style: "Heroic 3D" }))).toBe("Heroic 3D render style");
    expect(resolveShotStyle(p, makeShot({ style: "Some literal prompt" }))).toBe("Some literal prompt");
    expect(resolveShotStyle(p, makeShot())).toBe("");
  });
});

describe("brandPrompt", () => {
  it("normalizes colors and appends the font", () => {
    const p = makeProduction({ brand: { colors: ["#AABBCC", "not-a-color", "#00ff00"], font: "Baskerville" } });
    expect(brandPrompt(p)).toBe("Color palette: #aabbcc, #00ff00. Font: Baskerville.");
  });
});

describe("characterSheetPrompt", () => {
  it("wraps the description in the always-on sheet framing (front view)", () => {
    const prompt = characterSheetPrompt("a scarred space smuggler in a worn leather jacket", "front");
    expect(prompt).toContain("Character reference sheet: a scarred space smuggler in a worn leather jacket.");
    expect(prompt).toContain("Full body front view, with an inset closeup of the character's face.");
    expect(prompt).toContain("Neutral pose, neutral expression, neutral lighting, plain gray background.");
  });

  it("marks BOTH the front and back views as full body for the front-back option", () => {
    const prompt = characterSheetPrompt("a short gnome baker with flour-dusted apron", "front-back");
    expect(prompt).toContain("Full body front view and full body back view, with an inset closeup of the character's face.");
  });

  it("defaults to the front view when none is given", () => {
    const prompt = characterSheetPrompt("a robot butler");
    expect(prompt).toContain("Full body front view, with an inset closeup of the character's face.");
  });

  it("keeps the neutral-presentation language regardless of view", () => {
    for (const view of ["front", "front-back"] as const) {
      const prompt = characterSheetPrompt("anyone", view);
      expect(prompt).toContain("Neutral pose, neutral expression, neutral lighting, plain gray background.");
    }
  });

  it("always forbids text overlays", () => {
    for (const view of ["front", "front-back"] as const) {
      const prompt = characterSheetPrompt("anyone", view);
      expect(prompt).toContain("No text, no labels, no watermarks.");
    }
  });
});

describe("upsertCharacterSheetRef", () => {
  it("creates a Characters category and adds the sheet as a reference", () => {
    const p = makeProduction();
    const categoryId = upsertCharacterSheetRef(p, "Mara", "references/Mara.png");
    expect(p.referenceCategories).toHaveLength(1);
    expect(p.referenceCategories?.[0].name).toBe("Characters");
    const ref = p.references?.find((r) => r.name === "Mara");
    expect(ref?.imagePath).toBe("references/Mara.png");
    expect(ref?.categoryId).toBe(categoryId);
  });

  it("reuses an existing Characters category (case-insensitive)", () => {
    const p = makeProduction({ referenceCategories: [{ id: "cat-1", name: "characters" }] });
    const categoryId = upsertCharacterSheetRef(p, "Mara", "references/Mara.png");
    expect(categoryId).toBe("cat-1");
    expect(p.referenceCategories).toHaveLength(1);
  });

  it("upserts an existing same-named reference in place", () => {
    const p = makeProduction({ references: [{ id: "ref-1", name: "Mara", imagePath: "references/Mara.png", shotIds: [] }] });
    const categoryId = upsertCharacterSheetRef(p, "Mara", "references/Mara (2).png");
    expect(p.references).toHaveLength(1);
    expect(p.references?.[0].imagePath).toBe("references/Mara (2).png");
    expect(p.references?.[0].categoryId).toBe(categoryId);
  });
});

describe("boardPrompt", () => {
  it("composes style, brand, character key, and action paragraphs when brand is opted in", () => {
    const p = makeProduction({
      brand: { colors: ["#112233"] },
      characters: [{ id: "c-gandalf", name: "Gandalf", key: "grey wizard with a staff" }],
      scenes: [makeScene([makeShot({ number: "0100", audio: "Gandalf speaks", visual: "A hero walks through the valley.", includeBrandIdentity: true })])],
    });
    const prompt = boardPrompt(p, p.scenes[0].shots[0]);
    expect(prompt).toContain("Style: Heroic 3D render style");
    expect(prompt).toContain("Brand identity: Color palette: #112233.");
    expect(prompt).toContain("Gandalf: grey wizard with a staff.");
    expect(prompt).toContain("A hero walks through the valley.");
  });

  it("omits the brand paragraph by default (brand identity is opt-in)", () => {
    const p = makeProduction({ brand: { colors: ["#112233"] } });
    const prompt = boardPrompt(p, makeShot());
    expect(prompt).not.toContain("Brand identity:");
  });

  it("uses the per-shot style override over the master", () => {
    const p = makeProduction({
      styles: [
        { id: "s-master", index: 1, name: "Master", prompt: "Master style" },
        { id: "s-2d", index: 2, name: "2D", prompt: "Flat 2D style" },
      ],
    });
    const prompt = boardPrompt(p, makeShot({ style: "s-2d" }));
    expect(prompt).toContain("Style: Flat 2D style");
    expect(prompt).not.toContain("Master style");
  });

  it("omits the brand paragraph when includeBrandIdentity is false", () => {
    const p = makeProduction({ brand: { colors: ["#112233"] } });
    const prompt = boardPrompt(p, makeShot({ includeBrandIdentity: false }));
    expect(prompt).not.toContain("Brand identity:");
  });

  it("skips excluded characters", () => {
    const p = makeProduction({
      characters: [
        { id: "c-gandalf", name: "Gandalf", key: "grey wizard with a staff" },
        { id: "c-aragorn", name: "Aragorn", key: "ranger" },
      ],
    });
    const prompt = boardPrompt(p, makeShot({ visual: "Gandalf meets Aragorn", refExcluded: ["c-aragorn"] }));
    expect(prompt).toContain("Gandalf: grey wizard with a staff.");
    expect(prompt).not.toContain("Aragorn:");
  });
});

describe("effectivePrompt", () => {
  it("prefers the manual prompt and appends the brand exactly once when brand is opted in", () => {
    const p = makeProduction({ brand: { colors: ["#112233"] } });
    const shot = makeShot({ prompt: "My custom prompt", promptManual: true, includeBrandIdentity: true });
    const prompt = effectivePrompt(p, shot);
    expect(prompt).toContain("My custom prompt");
    expect(prompt.match(/Brand identity:/g)).toHaveLength(1);
    expect(prompt).toContain("Brand identity: Color palette: #112233.");
  });

  it("leaves a manual prompt untouched when brand is not opted in", () => {
    const p = makeProduction({ brand: { colors: ["#112233"] } });
    const shot = makeShot({ prompt: "My custom prompt", promptManual: true });
    expect(effectivePrompt(p, shot)).toBe("My custom prompt");
  });

  it("does not duplicate a brand the manual prompt already carries (regression)", () => {
    const p = makeProduction({ brand: { colors: ["#112233"] } });
    const shot = makeShot({ prompt: "Manual\n\nBrand identity: Color palette: #aabbcc.", promptManual: true });
    const prompt = effectivePrompt(p, shot);
    expect(prompt.match(/Brand identity:/g)).toHaveLength(1);
    expect(prompt).toContain("Color palette: #aabbcc."); // manual wording wins
  });

  it("strips the brand when includeBrandIdentity is false", () => {
    const p = makeProduction({ brand: { colors: ["#112233"] } });
    const shot = makeShot({ prompt: "Manual\n\nBrand identity: Color palette: #aabbcc.", promptManual: true, includeBrandIdentity: false });
    expect(effectivePrompt(p, shot)).toBe("Manual");
  });

  it("falls back to the auto-derived boardPrompt when no manual prompt is set", () => {
    const p = makeProduction({ brand: { colors: ["#112233"] } });
    const prompt = effectivePrompt(p, makeShot());
    expect(prompt).toContain("Style: Heroic 3D render style");
  });

  it("frame-drop tag on shot.prompt is invisible while Magic Prompt is ON", () => {
    // attachReferenceToPrompt (the frame-over-frame drop) writes the @[name] tag
    // to shot.prompt — but in magic mode effectivePrompt reads magicPrompts
    // first and never sees it, so the reference block never appears.
    const shot = makeShot({ prompt: "The villain looms over the ridge.\n\n@[Frame 0001]", promptManual: true });
    const p = makeProduction({ magicEnabled: true, magicPrompts: { [shot.id]: "The villain looms over the ridge." } });
    expect(effectivePrompt(p, shot)).not.toContain("@[Frame 0001]");
    expect(effectivePrompt(p, shot)).toContain("The villain looms over the ridge.");
  });

  it("frame-drop tag written to magicPrompts DOES surface (the fix)", () => {
    const shot = makeShot();
    const p = makeProduction({
      magicEnabled: true,
      magicPrompts: { [shot.id]: "The villain looms over the ridge.\n\n@[Frame 0001]" },
      references: [{ id: "r-frame", name: "Frame 0001", artwork: "data:image/png;base64,QUFBQQ==", shotIds: [shot.id] }],
    });
    expect(effectivePrompt(p, shot)).toContain("@[Frame 0001]");
    expect(shotReferences(p, shot).some((r) => r.name === "Frame 0001")).toBe(true);
    expect(openArtPrompt(p, shot)).toContain("@image1");
  });
});

describe("shotReferences / refTokens / resolveReferenceTags", () => {
  const p = makeProduction({
    characters: [
      { id: "c-gandalf", name: "Gandalf", key: "", artwork: "data:image/png;base64,QUFBQQ==" },
      { id: "c-aragorn", name: "Aragorn", key: "", artwork: "data:image/png;base64,QkJCQg==" },
    ],
    products: [{ id: "p-ring", name: "One Ring", artwork: "data:image/png;base64,Q0NDQw==" }],
  });

  it("matches @[name] tags to artwork-bearing references", () => {
    const shot = makeShot({ prompt: "Focus on @[Gandalf] and @[One Ring]" });
    const refs = shotReferences(p, shot);
    expect(refs.map((r) => r.name)).toEqual(["Gandalf", "One Ring"]);
  });

  it("maps references to stable tokens in document order", () => {
    const shot = makeShot({ prompt: "@[Gandalf] and @[Aragorn] and @[Gandalf]" });
    const tokens = refTokens(p, shot);
    expect(tokens.get("Gandalf")).toBe("@image1");
    expect(tokens.get("Aragorn")).toBe("@image2");
  });

  it("resolves human tags to tokens", () => {
    const shot = makeShot({ prompt: "Show @[Gandalf] with @[Aragorn]" });
    expect(resolveReferenceTags(p, shot, "Show @[Gandalf] with @[Aragorn]")).toBe("Show @image1 with @image2");
  });

  it("frame-drop reference is never resolved while Magic Prompt is ON", () => {
    // The frame drop tags shot.prompt, but shotReferences/openArtPrompt read
    // magicPrompts in magic mode — the dropped frame reference is dropped.
    const shot = makeShot({ prompt: "The villain looms over the ridge.\n\n@[Frame 0001]", promptManual: true });
    const mp = makeProduction({
      magicEnabled: true,
      magicPrompts: { [shot.id]: "The villain looms over the ridge." },
      references: [{ id: "r-frame", name: "Frame 0001", imagePath: "references/Frame 0001.png", shotIds: [shot.id] }],
    });
    expect(shotReferences(mp, shot).some((r) => r.name === "Frame 0001")).toBe(false);
    expect(openArtPrompt(mp, shot)).not.toContain("@[Frame 0001]");
  });
});

describe("scriptMarkdown", () => {
  it("renders one two-column table per scene", () => {
    const md = scriptMarkdown("Test", [
      makeScene([makeShot({ number: "0100", audio: "Hi there", visual: "Wide shot" })], "Arrival"),
    ]);
    expect(md).toContain("# Test — Shot Breakdown");
    expect(md).toContain("## Scene 1 — Arrival");
    expect(md).toContain("| Shot | Audio | Visual |");
    expect(md).toContain("| 0100 | Hi there | Wide shot |");
  });
});

describe("formatRuntime", () => {
  it("renders mm:ss", () => {
    expect(formatRuntime(0)).toBe("0:00");
    expect(formatRuntime(65)).toBe("1:05");
    expect(formatRuntime(120)).toBe("2:00");
    expect(formatRuntime(3661)).toBe("61:01");
  });
});

describe("applyVideoOutput", () => {
  it("adopts the image node's current frame as the still when the shot has no artwork", () => {
    const shot = makeShot({
      graphImageGens: [{ path: "boards/0100/shot-0100-abc.jpg", prompt: "p", model: "m", at: "" }],
      graphImageGenIndex: 0,
    });
    applyVideoOutput(shot, "videos/shot-0100-abc.mp4");
    expect(shot.videoPath).toBe("videos/shot-0100-abc.mp4");
    expect(shot.artwork).toBe("boards/0100/shot-0100-abc.jpg");
  });

  it("uses the piped source fallback when the image node has no stored frame", () => {
    const shot = makeShot();
    applyVideoOutput(shot, "videos/shot-0100-abc.mp4", "boards/0100/shot-0100-abc.jpg");
    expect(shot.artwork).toBe("boards/0100/shot-0100-abc.jpg");
  });

  it("leaves an existing artwork untouched", () => {
    const shot = makeShot({
      artwork: "boards/0100/shot-0100-existing.jpg",
      graphImageGens: [{ path: "boards/0100/shot-0100-gen.jpg", prompt: "p", model: "m", at: "" }],
    });
    applyVideoOutput(shot, "videos/shot-0100-abc.mp4");
    expect(shot.artwork).toBe("boards/0100/shot-0100-existing.jpg");
  });

  it("keeps the shot frameless when no source is available", () => {
    const shot = makeShot();
    applyVideoOutput(shot, "videos/shot-0100-abc.mp4");
    expect(shot.videoPath).toBe("videos/shot-0100-abc.mp4");
    expect(shot.artwork).toBeUndefined();
  });
});

describe("recordGraphEditGen", () => {
  it("stores the edit newest-first and selects it", () => {
    const shot = makeShot();
    recordGraphEditGen(shot, "boards/0100/shot-0100-edit1.jpg", "make it night", "auto");
    recordGraphEditGen(shot, "boards/0100/shot-0100-edit2.jpg", "add rain", "auto");
    expect(shot.graphEditGens?.[0].path).toBe("boards/0100/shot-0100-edit2.jpg");
    expect(shot.graphEditGens?.[1].path).toBe("boards/0100/shot-0100-edit1.jpg");
    expect(shot.graphEditGenIndex).toBe(0);
  });

  it("caps the stored edits at GRAPH_HISTORY_CAP", () => {
    const shot = makeShot();
    for (let i = 0; i < 25; i++) recordGraphEditGen(shot, `boards/0100/edit-${i}.jpg`, "p", "auto");
    expect(shot.graphEditGens?.length).toBe(20);
  });
});

describe("hookImageGenToOutput / hookVideoGenToOutput", () => {
  it("never displaces a deliberate edit-image pipe", () => {
    const shot = makeShot({
      graphOutputSource: "editgen",
      graphEditGens: [{ path: "boards/0100/shot-0100-edit.jpg", prompt: "p", model: "m", at: "" }],
      graphEditGenIndex: 0,
    });
    hookImageGenToOutput(shot);
    expect(shot.graphOutputSource).toBe("editgen");
    hookVideoGenToOutput(shot);
    expect(shot.graphOutputSource).toBe("editgen");
  });

  it("hooks a classic image generation when nothing is piped", () => {
    const shot = makeShot({
      graphImageGens: [{ path: "boards/0100/shot-0100-gen.jpg", prompt: "p", model: "m", at: "" }],
      graphImageGenIndex: 0,
    });
    hookImageGenToOutput(shot);
    expect(shot.graphOutputSource).toBe("imagegen");
    expect(shot.artwork).toBe("boards/0100/shot-0100-gen.jpg");
  });
});

describe("syncBoardOutputToPipe", () => {
  const edit = { path: "boards/0100/shot-0100-edit.jpg", prompt: "make it night", model: "auto", at: "" };
  const frame = { path: "boards/0100/shot-0100-frame.jpg", prompt: "p", model: "auto", at: "" };
  const clip = { path: "videos/shot-0100-clip.mp4", prompt: "p", model: "auto", at: "" };

  it("applies a piped edit-image node's selected edit as the storyboard frame", () => {
    const shot = makeShot({ graphOutputSource: "editgen", graphEditGens: [edit], graphEditGenIndex: 0 });
    expect(syncBoardOutputToPipe(shot)).toBe(true);
    expect(shot.artwork).toBe(edit.path);
  });

  it("re-derives the frame when a stale/missing artwork raced a renderer save", () => {
    const shot = makeShot({ graphOutputSource: "editgen", graphEditGens: [edit], graphEditGenIndex: 0, artwork: "boards/0100/shot-0100-stale.jpg", videoPath: "videos/stale.mp4" });
    expect(syncBoardOutputToPipe(shot)).toBe(true);
    expect(shot.artwork).toBe(edit.path);
    expect(shot.videoPath).toBeUndefined();
  });

  it("is a no-op when artwork already mirrors the piped edit", () => {
    const shot = makeShot({ graphOutputSource: "editgen", graphEditGens: [edit], graphEditGenIndex: 0, artwork: edit.path });
    expect(syncBoardOutputToPipe(shot)).toBe(false);
    expect(shot.artwork).toBe(edit.path);
  });

  it("clears the frame when the piped node has no generation yet", () => {
    const shot = makeShot({ graphOutputSource: "editgen", graphEditGens: [], artwork: "boards/0100/old.jpg", videoPath: "videos/old.mp4" });
    expect(syncBoardOutputToPipe(shot)).toBe(true);
    expect(shot.artwork).toBeUndefined();
    expect(shot.videoPath).toBeUndefined();
  });

  it("mirrors the image generation node's selected frame", () => {
    const shot = makeShot({ graphOutputSource: "imagegen", graphImageGens: [frame], graphImageGenIndex: 0 });
    expect(syncBoardOutputToPipe(shot)).toBe(true);
    expect(shot.artwork).toBe(frame.path);
  });

  it("mirrors the video generation node's selected clip and its still", () => {
    const shot = makeShot({ graphOutputSource: "videogen", graphVideoGens: [clip], graphVideoGenIndex: 0 });
    expect(syncBoardOutputToPipe(shot)).toBe(true);
    expect(shot.videoPath).toBe(clip.path);
  });

  it("uses the image pipe as the videogen still when the shot has no frame", () => {
    const shot = makeShot({ graphOutputSource: "videogen", graphVideoGens: [clip], graphVideoGenIndex: 0, graphImageGens: [frame], graphImageGenIndex: 0 });
    expect(syncBoardOutputToPipe(shot)).toBe(true);
    expect(shot.videoPath).toBe(clip.path);
    expect(shot.artwork).toBe(frame.path);
  });

  it("leaves unpiped/classic shots untouched", () => {
    const shot = makeShot({ artwork: "boards/0100/shot-0100-classic.jpg" });
    expect(syncBoardOutputToPipe(shot)).toBe(false);
    expect(shot.artwork).toBe("boards/0100/shot-0100-classic.jpg");
  });
});