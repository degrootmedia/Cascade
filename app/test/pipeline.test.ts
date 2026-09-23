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
import type { Production, ProductionScene, ProductionShot, GraphGenItem, GraphEditNode } from "../src/shared/ipc.js";
import { materializeGraph } from "../src/shared/graph/materialize.js";
import { setBrandEdge } from "../src/shared/graph/connect.js";
import { renderShotPrompt } from "../src/shared/graph/render.js";

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
  recordBoardArtwork,
  recordBoardEdit,
  buildEditGenPrompt,
  wireEditNodeToCurrentFrame,
  recordGraphEditGen,
  rebaseGenIndex,
  refTokens,
  resolveReferenceTags,
  resolveShotStyle,
  scriptMarkdown,
  selectBoardFrame,
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

  it("replaces a stale brand copy with the canonical clause, exactly once (step 04)", () => {
    const p = makeProduction({ brand: { colors: ["#112233"] } });
    const shot = makeShot({ prompt: "Manual\n\nBrand identity: Color palette: #aabbcc.", promptManual: true });
    const prompt = effectivePrompt(p, shot);
    expect(prompt.match(/Brand identity:/g)).toHaveLength(1);
    expect(prompt).toContain("Color palette: #112233."); // reference wins over the stored copy
    expect(prompt).toBe("Brand identity: Color palette: #112233.\n\nManual");
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

  it("adopts the edit node's selected frame as the still when it feeds the video source", () => {
    const shot = makeShot({
      graphEditToVideo: true,
      graphVideoSourceEditNodeId: "edit0",
      graphImageGens: [{ path: "boards/0100/stale-image.jpg", prompt: "p", model: "m", at: "" }],
      graphImageGenIndex: 0,
      graphEditNodes: [{ id: "edit0", prompt: "", gens: [{ path: "boards/0100/shot-0100-edit.jpg", prompt: "p", model: "m", at: "" }], genIndex: 0 }],
    });
    applyVideoOutput(shot, "videos/shot-0100-abc.mp4");
    expect(shot.artwork).toBe("boards/0100/shot-0100-edit.jpg");
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

describe("recordBoardArtwork", () => {
  it("dedupes history and removes the newly selected frame before applying the classic cap", () => {
    const shot = makeShot({
      artwork: "current.jpg",
      artworkHistory: ["selected.jpg", "current.jpg", "", "older.jpg", "older.jpg", "oldest.jpg"],
    });
    recordBoardArtwork(shot, "selected.jpg");
    expect(shot.artwork).toBe("selected.jpg");
    expect(shot.artworkHistory).toEqual(["current.jpg", "older.jpg", "oldest.jpg"]);
  });

  it("excludes the selected frame even when artwork already matches or was absent", () => {
    for (const artwork of ["selected.jpg", undefined]) {
      const shot = makeShot({ artwork, artworkHistory: ["selected.jpg", "older.jpg"] });
      recordBoardArtwork(shot, "selected.jpg");
      expect(shot.artworkHistory).toEqual(["older.jpg"]);
    }
  });

  it("retains the existing cap for the legacy fallback history", () => {
    const shot = makeShot();
    for (let i = 0; i < 10; i++) recordBoardArtwork(shot, `frame-${i}.jpg`);
    expect(shot.artworkHistory).toEqual(["frame-8.jpg", "frame-7.jpg", "frame-6.jpg", "frame-5.jpg", "frame-4.jpg"]);
  });
});

describe("selectBoardFrame", () => {
  it("switches image/edit primaries at their exact indices without rewriting generation history or other pipes", () => {
    const images = [0, 1, 2].map((i) => ({ path: `image-${i}.jpg`, prompt: `image ${i}`, model: "image-model", at: `2026-09-0${3 - i}T00:00:00.000Z` }));
    const edits = [0, 1, 2].map((i) => ({ path: `edit-${i}.jpg`, prompt: `edit ${i}`, model: "edit-model", at: `2026-09-0${6 - i}T00:00:00.000Z` }));
    const videos = [{ path: "clip.mp4", prompt: "motion", model: "video-model", at: "" }];
    const shot = makeShot({
      graphImageGens: images, graphImageGenIndex: 0,
      graphEditNodes: [{ id: "edit0", prompt: "", gens: edits, genIndex: 0, source: { kind: "ref", refId: "edit-ref" } }],
      graphVideoGens: videos, graphVideoGenIndex: 0,
      artwork: "legacy.jpg", artworkHistory: ["older.jpg"], videoPath: "clip.mp4",
      graphOutputSource: "ref", graphOutputRefId: "ref-1",
      graphImageToVideo: true,
    });
    const before = structuredClone({ images, edits, videos });
    Object.freeze(images);
    Object.freeze(edits);
    for (const gen of [...images, ...edits]) Object.freeze(gen);
    for (const [rel, source, imageIndex, editIndex] of [
      ["image-1.jpg", "imagegen", 1, 0],
      ["edit-2.jpg", "editgen", 1, 2],
      ["image-2.jpg", "imagegen", 2, 2],
      ["edit-1.jpg", "editgen", 2, 1],
    ] as const) {
      selectBoardFrame(shot, rel);
      expect(shot.artwork).toBe(rel);
      expect(shot.graphOutputSource).toBe(source);
      expect(shot.graphImageGenIndex).toBe(imageIndex);
      expect(shot.graphEditNodes?.[0].genIndex).toBe(editIndex);
      expect(shot.graphOutputEditNodeId).toBe(source === "editgen" ? "edit0" : undefined);
      expect(shot.graphOutputRefId).toBeUndefined();
      expect(shot.videoPath).toBeUndefined();
      expect(shot.artworkHistory).not.toContain(rel);
      expect(syncBoardOutputToPipe(shot)).toBe(false);
    }
    expect(shot.artworkHistory).toEqual(["image-2.jpg", "edit-2.jpg", "image-1.jpg", "legacy.jpg", "older.jpg"]);
    expect(shot.graphImageGens).toBe(images);
    expect(shot.graphEditNodes?.[0].gens).toBe(edits);
    expect(shot.graphVideoGens).toBe(videos);
    expect({ images, edits, videos }).toEqual(before);
    expect(shot.graphImageToVideo).toBe(true);
    expect(shot.graphEditNodes?.[0].source).toEqual({ kind: "ref", refId: "edit-ref" });
    expect(shot.graphVideoGenIndex).toBe(0);
  });

  it("gives the edit node priority when both nodes contain the same path", () => {
    const shot = makeShot({
      graphImageGens: [{ path: "shared.jpg", prompt: "image", model: "m", at: "" }],
      graphImageGenIndex: 0,
      graphEditNodes: [{ id: "edit0", prompt: "", genIndex: 0, gens: [
        { path: "other.jpg", prompt: "other", model: "m", at: "" },
        { path: "shared.jpg", prompt: "edit", model: "m", at: "" },
      ] }],
    });
    selectBoardFrame(shot, "shared.jpg");
    expect(shot.graphOutputSource).toBe("editgen");
    expect(shot.graphEditNodes?.[0].genIndex).toBe(1);
    expect(shot.graphImageGenIndex).toBe(0);
    expect(syncBoardOutputToPipe(shot)).toBe(false);
  });

  it.each(["unknown.jpg", "clip.mp4", ""])("rejects invalid path %j without any mutation", (rel) => {
    const shot = makeShot({
      artwork: "current.jpg", artworkHistory: ["legacy.jpg", ""], videoPath: "clip.mp4",
      graphOutputSource: "ref", graphOutputRefId: "ref-1",
      graphImageGens: [{ path: "image.jpg", prompt: "image", model: "m", at: "" }],
      graphEditNodes: [{ id: "edit0", prompt: "", gens: [{ path: "edit.jpg", prompt: "edit", model: "m", at: "" }] }],
      graphVideoGens: [{ path: "clip.mp4", prompt: "video", model: "m", at: "" }],
    });
    const before = structuredClone(shot);
    const { graphImageGens, artworkHistory } = shot;
    const editGens = shot.graphEditNodes![0].gens;
    expect(() => selectBoardFrame(shot, rel)).toThrow(/Cannot select board frame.*not in this shot's/);
    expect(shot).toEqual(before);
    expect(shot.graphImageGens).toBe(graphImageGens);
    expect(shot.graphEditNodes?.[0].gens).toBe(editGens);
    expect(shot.artworkHistory).toBe(artworkHistory);
  });

  it("appends a legacy placeholder without discarding a full image history or shifting existing entries", () => {
    const images = Array.from({ length: 20 }, (_, i) => ({ path: `image-${i}.jpg`, prompt: `prompt ${i}`, model: "m", at: "" }));
    const originalItems = [...images];
    const shot = makeShot({
      artwork: "image-3.jpg", artworkHistory: ["legacy.jpg"],
      graphImageGens: images, graphImageGenIndex: 3, graphImageToVideo: true,
      graphEditNodes: [{ id: "edit0", prompt: "", genIndex: 2, gens: [{ path: "edit.jpg", prompt: "p", model: "m", at: "" }] }],
    });
    selectBoardFrame(shot, "legacy.jpg");
    expect(shot.graphImageGens).toBe(images);
    expect(shot.graphImageGens).toHaveLength(21);
    for (let i = 0; i < originalItems.length; i++) expect(shot.graphImageGens?.[i]).toBe(originalItems[i]);
    expect(shot.graphImageGens?.[20]).toEqual({ path: "legacy.jpg", prompt: "", model: "", at: "" });
    expect(shot.graphImageGenIndex).toBe(20);
    expect(shot.graphEditNodes?.[0].genIndex).toBe(2);
    expect(shot.graphImageToVideo).toBe(true);
    expect(shot.graphOutputSource).toBe("imagegen");
    expect(shot.artworkHistory).toEqual(["image-3.jpg"]);
    expect(syncBoardOutputToPipe(shot)).toBe(false);
    selectBoardFrame(shot, "legacy.jpg");
    expect(shot.graphImageGens).toHaveLength(21);
  });

  it("makes a current legacy still a real node selection and restores it from video output", () => {
    const shot = makeShot({ artwork: "legacy.jpg", videoPath: "clip.mp4", graphOutputSource: "videogen" });
    selectBoardFrame(shot, "legacy.jpg");
    expect(shot.graphImageGens).toEqual([{ path: "legacy.jpg", prompt: "", model: "", at: "" }]);
    expect(shot.graphImageGenIndex).toBe(0);
    expect(shot.graphOutputSource).toBe("imagegen");
    expect(shot.videoPath).toBeUndefined();
    expect(shot.artwork).toBe("legacy.jpg");
    expect(syncBoardOutputToPipe(shot)).toBe(false);
  });
});

describe("recordBoardEdit", () => {
  it("binds the actual current image generation, preserves image history, and always makes the edit primary", () => {
    const images = [0, 1, 2].map((i) => ({ path: `image-${i}.jpg`, prompt: `image ${i}`, model: "image-model", at: "" }));
    const oldEdit = { path: "old-edit.jpg", prompt: "old edit", model: "old-model", at: "2026-09-01T00:00:00.000Z" };
    const shot = makeShot({
      artwork: "image-2.jpg", graphImageGens: images, graphImageGenIndex: 0,
      graphEditNodes: [{ id: "edit0", prompt: "", gens: [oldEdit], genIndex: 0, source: { kind: "ref", refId: "stale-ref" } }],
      graphOutputSource: "videogen", graphOutputRefId: "stale-output-ref", videoPath: "clip.mp4",
      graphImageToVideo: true, prompt: "image prompt", graphVideoPrompt: "motion prompt",
    });
    const before = structuredClone(images);
    const id = recordBoardEdit(shot, "new-edit.jpg", "make it night", "edit-model");
    expect(id).toBe("edit1");
    const node = shot.graphEditNodes?.find((n) => n.id === id)!;
    expect(shot.graphImageGens).toBe(images);
    expect(shot.graphImageGens).toEqual(before);
    expect(shot.graphImageGenIndex).toBe(2);
    expect(node.source).toEqual({ kind: "imagegen" });
    expect(node.gens?.[0]).toEqual({ path: "new-edit.jpg", prompt: "make it night", model: "edit-model", at: expect.any(String) });
    expect(Number.isFinite(Date.parse(node.gens![0].at))).toBe(true);
    expect(node.genIndex).toBe(0);
    // The previous edit node is untouched — classic edits append to the chain.
    expect(shot.graphEditNodes?.find((n) => n.id === "edit0")?.gens?.[0]).toBe(oldEdit);
    expect(shot.graphEditPrompt).toBe("make it night");
    expect(shot.graphOutputSource).toBe("editgen");
    expect(shot.graphOutputEditNodeId).toBe(id);
    expect(shot.graphOutputRefId).toBeUndefined();
    expect(shot.artwork).toBe("new-edit.jpg");
    expect(shot.artworkHistory).toEqual(["image-2.jpg"]);
    expect(shot.videoPath).toBeUndefined();
    expect(shot.graphImageToVideo).toBe(true);
    expect(shot.prompt).toBe("image prompt");
    expect(shot.graphVideoPrompt).toBe("motion prompt");
    expect(syncBoardOutputToPipe(shot)).toBe(false);
  });

  it("binds a reference output before replacing that output pipe with the edit", () => {
    const shot = makeShot({
      artwork: "ref-frame.jpg", graphOutputSource: "ref", graphOutputRefId: "ref-1",
      graphImageGenIndex: 2,
    });
    const id = recordBoardEdit(shot, "edit.jpg", "add rain", "auto");
    const node = shot.graphEditNodes?.find((n) => n.id === id)!;
    expect(node.source).toEqual({ kind: "ref", refId: "ref-1" });
    expect(shot.graphImageGenIndex).toBe(2);
    expect(shot.graphImageGens).toBeUndefined();
    expect(shot.graphOutputSource).toBe("editgen");
    expect(shot.graphOutputRefId).toBeUndefined();
    expect(shot.artwork).toBe("edit.jpg");
    expect(shot.artworkHistory).toEqual(["ref-frame.jpg"]);
  });

  it("chains a second classic edit from the first, keeping the current-frame fallback", () => {
    const shot = makeShot({
      artwork: "image.jpg", graphImageGens: [{ path: "image.jpg", prompt: "image", model: "m", at: "" }],
      graphImageGenIndex: 0, graphOutputSource: "imagegen", graphImageToVideo: true,
    });
    const firstId = recordBoardEdit(shot, "first-edit.jpg", "make it night", "auto");
    expect(shot.graphEditNodes?.find((n) => n.id === firstId)?.source).toEqual({ kind: "imagegen" });
    const secondId = recordBoardEdit(shot, "second-edit.jpg", "add rain", "auto");
    const second = shot.graphEditNodes?.find((n) => n.id === secondId)!;
    expect(second.source).toEqual({ kind: "editgen", nodeId: firstId });
    expect(shot.graphEditNodes?.length).toBe(2);
    expect(shot.graphImageGens).toHaveLength(1);
    expect(shot.graphImageGenIndex).toBe(0);
    expect(shot.graphImageToVideo).toBe(true);
    expect(shot.artwork).toBe("second-edit.jpg");
    expect(shot.artworkHistory).toEqual(["first-edit.jpg", "image.jpg"]);
    expect(shot.graphEditPrompt).toBe("add rain");
    expect(syncBoardOutputToPipe(shot)).toBe(false);
  });

  it("uses the current-frame fallback for legacy artwork instead of an unrelated image selection", () => {
    const shot = makeShot({
      artwork: "legacy.jpg", graphImageGens: [{ path: "unrelated.jpg", prompt: "p", model: "m", at: "" }],
      graphImageGenIndex: 0,
    });
    const id = recordBoardEdit(shot, "edit.jpg", "add rain", "auto");
    const node = shot.graphEditNodes?.find((n) => n.id === id)!;
    expect(node.source).toBeUndefined();
    expect(shot.graphImageGens).toHaveLength(1);
    expect(shot.graphImageGenIndex).toBe(0);
    expect(shot.artworkHistory).toEqual(["legacy.jpg"]);
    expect(shot.artwork).toBe("edit.jpg");
  });

  it("chains from the output edit node rather than claiming an image-node source for a shared path", () => {
    const shot = makeShot({
      artwork: "shared.jpg", graphOutputSource: "editgen", graphOutputEditNodeId: "edit0",
      graphImageGens: [{ path: "shared.jpg", prompt: "image", model: "m", at: "" }],
      graphEditNodes: [{ id: "edit0", prompt: "edit", gens: [{ path: "shared.jpg", prompt: "edit", model: "m", at: "" }] }],
    });
    const id = recordBoardEdit(shot, "edit.jpg", "add rain", "auto");
    const node = shot.graphEditNodes?.find((n) => n.id === id)!;
    expect(node.source).toEqual({ kind: "editgen", nodeId: "edit0" });
    expect(shot.artwork).toBe("edit.jpg");
  });

  it("stores the dialog's advanced params on the created node (absent stays absent)", () => {
    const withParams = makeShot({ artwork: "a.jpg" });
    const id = recordBoardEdit(withParams, "edit.jpg", "add rain", "auto", undefined, { variant: "sunburst", seed: "7" });
    expect(withParams.graphEditNodes?.find((n) => n.id === id)?.params).toEqual({ variant: "sunburst", seed: "7" });
    const bare = makeShot({ artwork: "a.jpg" });
    const bareId = recordBoardEdit(bare, "edit.jpg", "add rain", "auto");
    expect(bare.graphEditNodes?.find((n) => n.id === bareId)?.params).toBeUndefined();
  });

  it("stores the dialog's resolution tier on the created node", () => {
    const shot = makeShot({ artwork: "a.jpg" });
    const id = recordBoardEdit(shot, "edit.jpg", "add rain", "auto", undefined, undefined, "2k");
    expect(shot.graphEditNodes?.find((n) => n.id === id)?.resolution).toBe("2k");
  });
});

describe("wireEditNodeToCurrentFrame", () => {
  it("wires image→edit when the current frame is an image-node generation", () => {
    const shot = makeShot({
      artwork: "image-1.jpg",
      graphImageGens: [
        { path: "image-0.jpg", prompt: "p0", model: "m", at: "" },
        { path: "image-1.jpg", prompt: "p1", model: "m", at: "" },
      ],
      graphImageGenIndex: 0,
    });
    wireEditNodeToCurrentFrame(shot);
    expect(shot.graphImageGenIndex).toBe(1);
    expect(shot.graphEditNodes?.[0].source).toEqual({ kind: "imagegen" });
  });

  it("wires the output reference into the edit node", () => {
    const shot = makeShot({ artwork: "ref-frame.jpg", graphOutputSource: "ref", graphOutputRefId: "ref-1" });
    wireEditNodeToCurrentFrame(shot);
    expect(shot.graphEditNodes?.[0].source).toEqual({ kind: "ref", refId: "ref-1" });
  });

  it("leaves the source unset for legacy artwork so generation falls back to the current frame", () => {
    const shot = makeShot({
      artwork: "legacy.jpg",
      graphImageGens: [{ path: "unrelated.jpg", prompt: "p", model: "m", at: "" }],
    });
    wireEditNodeToCurrentFrame(shot);
    expect(shot.graphEditNodes?.[0].source).toBeUndefined();
  });
});

describe("buildEditGenPrompt", () => {
  it("frames the source as token 0 and caps instructions at 1200 chars", () => {
    const prompt = buildEditGenPrompt("make it night");
    expect(prompt).toContain("@image1");
    expect(prompt).toContain("make it night");
    const long = buildEditGenPrompt("x".repeat(2000));
    expect(long.endsWith("x".repeat(1200))).toBe(true);
  });
});

describe("recordGraphEditGen", () => {
  it("stores the edit newest-first and selects it", () => {
    const shot = makeShot({ graphEditNodes: [{ id: "edit0", prompt: "" }] });
    recordGraphEditGen(shot, "edit0", "boards/0100/shot-0100-edit1.jpg", "make it night", "auto");
    recordGraphEditGen(shot, "edit0", "boards/0100/shot-0100-edit2.jpg", "add rain", "auto");
    const node = shot.graphEditNodes![0];
    expect(node.gens?.[0].path).toBe("boards/0100/shot-0100-edit2.jpg");
    expect(node.gens?.[1].path).toBe("boards/0100/shot-0100-edit1.jpg");
    expect(node.genIndex).toBe(0);
  });

  it("caps the stored edits at GRAPH_HISTORY_CAP", () => {
    const shot = makeShot({ graphEditNodes: [{ id: "edit0", prompt: "" }] });
    for (let i = 0; i < 25; i++) recordGraphEditGen(shot, "edit0", `boards/0100/edit-${i}.jpg`, "p", "auto");
    expect(shot.graphEditNodes?.[0].gens?.length).toBe(20);
  });
});

describe("hookImageGenToOutput / hookVideoGenToOutput", () => {
  it("never displaces a deliberate edit-image pipe", () => {
    const shot = makeShot({
      graphOutputSource: "editgen",
      graphEditNodes: [{ id: "edit0", prompt: "", genIndex: 0, gens: [{ path: "boards/0100/shot-0100-edit.jpg", prompt: "p", model: "m", at: "" }] }],
    });
    hookImageGenToOutput(shot);
    expect(shot.graphOutputSource).toBe("editgen");
  });

  it("an explicit classic video generation always takes over the output", () => {
    // The storyboard mirrors the output pipe and the animatic plays videoPath,
    // so a video the user asked for must bind videogen (the displaced still
    // lives on in its node's history) or the sync would wipe the clip.
    const shot = makeShot({
      graphOutputSource: "editgen",
      graphEditNodes: [{ id: "edit0", prompt: "", genIndex: 0, gens: [{ path: "boards/0100/shot-0100-edit.jpg", prompt: "p", model: "m", at: "" }] }],
      videoPath: "videos/shot-0100-new.mp4",
    });
    hookVideoGenToOutput(shot);
    expect(shot.graphOutputSource).toBe("videogen");
    expect(shot.videoPath).toBe("videos/shot-0100-new.mp4");
    expect(shot.graphEditNodes).toHaveLength(1);
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

describe("rebaseGenIndex", () => {
  const gen = (p: string): GraphGenItem => ({ path: p, prompt: "p", model: "m", at: "" });

  it("re-anchors the copied index at a mid-job selection change (Make Primary)", () => {
    const before = [gen("A"), gen("B")];
    const fresh = [gen("A"), gen("B")];
    const next = [gen("N"), ...before];
    // User promoted B (index 1) while the job ran; the job prepended N and selected 0.
    expect(rebaseGenIndex(before, 0, fresh, 1, next, 0)).toBe(2);
  });

  it("keeps the job's selection when the user didn't change it mid-job", () => {
    const arr = [gen("A"), gen("B")];
    expect(rebaseGenIndex(arr, 0, arr, 0, [gen("N"), ...arr], 0)).toBe(0);
  });

  it("keeps the job's selection when the user changed the array too (ambiguous)", () => {
    const before = [gen("A")];
    const fresh = [gen("X"), gen("A")];
    expect(rebaseGenIndex(before, 0, fresh, 1, [gen("N"), gen("X"), gen("A")], 0)).toBe(0);
  });

  it("falls back to the job's selection when the user's frame was evicted", () => {
    const before = [gen("A"), gen("B")];
    const fresh = [gen("A"), gen("B")];
    const next = [gen("N"), gen("A")]; // B evicted by the cap
    expect(rebaseGenIndex(before, 0, fresh, 1, next, 0)).toBe(0);
  });
});

describe("syncBoardOutputToPipe", () => {
  const edit = { path: "boards/0100/shot-0100-edit.jpg", prompt: "make it night", model: "auto", at: "" };
  const frame = { path: "boards/0100/shot-0100-frame.jpg", prompt: "p", model: "auto", at: "" };
  const clip = { path: "videos/shot-0100-clip.mp4", prompt: "p", model: "auto", at: "" };
  const editNode = (gens: GraphGenItem[] = [edit], genIndex = 0): GraphEditNode => ({ id: "edit0", prompt: "", gens, genIndex });

  it("applies a piped edit-image node's selected edit as the storyboard frame", () => {
    const shot = makeShot({ graphOutputSource: "editgen", graphOutputEditNodeId: "edit0", graphEditNodes: [editNode()] });
    expect(syncBoardOutputToPipe(shot)).toBe(true);
    expect(shot.artwork).toBe(edit.path);
  });

  it("re-derives the frame when a stale/missing artwork raced a renderer save", () => {
    const shot = makeShot({ graphOutputSource: "editgen", graphOutputEditNodeId: "edit0", graphEditNodes: [editNode()], artwork: "boards/0100/shot-0100-stale.jpg", videoPath: "videos/stale.mp4" });
    expect(syncBoardOutputToPipe(shot)).toBe(true);
    expect(shot.artwork).toBe(edit.path);
    expect(shot.videoPath).toBeUndefined();
    expect(shot.artworkHistory).toEqual(["boards/0100/shot-0100-stale.jpg"]);
  });

  it.each(["imagegen", "editgen"] as const)("clears stale video for a matching %s still without changing history", (source) => {
    const history = ["legacy.jpg"];
    const shot = makeShot({
      graphOutputSource: source, graphImageGens: [frame], graphEditNodes: [editNode()],
      graphOutputEditNodeId: source === "editgen" ? "edit0" : undefined,
      artwork: source === "imagegen" ? frame.path : edit.path, videoPath: "videos/stale.mp4",
      artworkHistory: history,
    });
    expect(syncBoardOutputToPipe(shot)).toBe(true);
    expect(shot.videoPath).toBeUndefined();
    expect(shot.artworkHistory).toBe(history);
    expect(syncBoardOutputToPipe(shot)).toBe(false);
  });

  it.each(["imagegen", "editgen"] as const)("preserves an untracked legacy still when the %s output actually changes", (source) => {
    const shot = makeShot({
      graphOutputSource: source, graphImageGens: [frame], graphEditNodes: [editNode()],
      graphOutputEditNodeId: source === "editgen" ? "edit0" : undefined,
      artwork: "legacy.jpg", artworkHistory: [frame.path, edit.path, "older.jpg"],
    });
    expect(syncBoardOutputToPipe(shot)).toBe(true);
    expect(shot.artwork).toBe(source === "imagegen" ? frame.path : edit.path);
    expect(shot.artworkHistory).toEqual(["legacy.jpg", source === "imagegen" ? edit.path : frame.path, "older.jpg"]);
    expect(syncBoardOutputToPipe(shot)).toBe(false);
  });

  it("is a no-op when artwork already mirrors the piped edit", () => {
    const shot = makeShot({ graphOutputSource: "editgen", graphOutputEditNodeId: "edit0", graphEditNodes: [editNode()], artwork: edit.path });
    expect(syncBoardOutputToPipe(shot)).toBe(false);
    expect(shot.artwork).toBe(edit.path);
  });

  it("clears the frame when the piped node has no generation yet", () => {
    const shot = makeShot({ graphOutputSource: "editgen", graphOutputEditNodeId: "edit0", graphEditNodes: [editNode([])], artwork: "boards/0100/old.jpg", videoPath: "videos/old.mp4" });
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

  it("uses the edit pipe as the videogen still when the edit node feeds the video source", () => {
    const shot = makeShot({
      graphOutputSource: "videogen", graphVideoGens: [clip], graphVideoGenIndex: 0,
      graphEditToVideo: true, graphVideoSourceEditNodeId: "edit0", graphImageGens: [frame], graphImageGenIndex: 0,
      graphEditNodes: [editNode()],
    });
    expect(syncBoardOutputToPipe(shot)).toBe(true);
    expect(shot.videoPath).toBe(clip.path);
    expect(shot.artwork).toBe(edit.path);
  });

  it("leaves unpiped/classic shots untouched", () => {
    const shot = makeShot({ artwork: "boards/0100/shot-0100-classic.jpg" });
    expect(syncBoardOutputToPipe(shot)).toBe(false);
    expect(shot.artwork).toBe("boards/0100/shot-0100-classic.jpg");
  });
});

describe("prompt as projection (step 05)", () => {
  it("the preview and the submitted string come from the same renderer", () => {
    const p = makeProduction({ brand: { colors: ["#112233"], font: "Baskerville" } });
    const base = makeShot({ prompt: "hold the line", promptManual: true, graphStyleConnected: true, includeBrandIdentity: true });
    // A stored graph (post step-03/04): style edge from the flag, brand edge
    // explicit — the shared sections render from the references.
    const graph = setBrandEdge(materializeGraph(base, [{ id: "c-gandalf", name: "Gandalf" }]), "composer", true);
    const shot = { ...base, graph };
    const submitted = effectivePrompt(p, shot);
    const previewed = renderShotPrompt(p, shot, "composer");
    expect(submitted).toBe(previewed);
    expect(submitted).toBe(
      "Style: Heroic 3D render style\n\nBrand identity: Color palette: #112233. Font: Baskerville.\n\nhold the line"
    );
  });

  it("editing the style library updates the submitted string with no stored copy", () => {
    const p = makeProduction();
    const base = makeShot({ prompt: "hold the line", promptManual: true, graphStyleConnected: true });
    const shot = { ...base, graph: materializeGraph(base, []) };
    expect(effectivePrompt(p, shot)).toBe("Style: Heroic 3D render style\n\nhold the line");
    const edited = makeProduction({ styles: [{ id: "s-master", index: 1, name: "Heroic 3D", prompt: "Stop-motion" }] });
    expect(effectivePrompt(edited, shot)).toBe("Style: Stop-motion\n\nhold the line");
    expect(shot.prompt).toBe("hold the line");
  });
});
