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
  effectivePrompt,
  formatRuntime,
  mergeCharacters,
  mergeProducts,
  normalizeScenes,
  parseBreakdownJson,
  refTokens,
  resolveReferenceTags,
  resolveShotStyle,
  scriptMarkdown,
  shotReferences,
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
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references" },
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

describe("boardPrompt", () => {
  it("composes style, brand, character key, and action paragraphs", () => {
    const p = makeProduction({
      brand: { colors: ["#112233"] },
      characters: [{ id: "c-gandalf", name: "Gandalf", key: "grey wizard with a staff" }],
      scenes: [makeScene([makeShot({ number: "0100", audio: "Gandalf speaks", visual: "A hero walks through the valley." })])],
    });
    const prompt = boardPrompt(p, p.scenes[0].shots[0]);
    expect(prompt).toContain("Style: Heroic 3D render style");
    expect(prompt).toContain("Brand identity: Color palette: #112233.");
    expect(prompt).toContain("Gandalf: grey wizard with a staff.");
    expect(prompt).toContain("A hero walks through the valley.");
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
  it("prefers the manual prompt and appends the brand exactly once", () => {
    const p = makeProduction({ brand: { colors: ["#112233"] } });
    const shot = makeShot({ prompt: "My custom prompt", promptManual: true });
    const prompt = effectivePrompt(p, shot);
    expect(prompt).toContain("My custom prompt");
    expect(prompt.match(/Brand identity:/g)).toHaveLength(1);
    expect(prompt).toContain("Brand identity: Color palette: #112233.");
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