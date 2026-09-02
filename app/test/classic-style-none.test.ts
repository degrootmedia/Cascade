/**
 * Classic (storyboard) view: changing a shot's style dropdown to "None" must
 * remove the Style section from the prompt that gets submitted for generation.
 *
 * updateShotStyle() persists `style: undefined, prompt: <stripped>,
 * promptManual: true`; this suite verifies that effectivePrompt (the prompt
 * generateBoards/openArtPrompt submit) then carries no Style section — for
 * auto-derived, manual, and Magic-Prompt productions alike.
 */
import { describe, it, expect, vi } from "vitest";
import type { Production, ProductionScene, ProductionShot } from "../src/shared/ipc.js";
import { stripStyleParagraph } from "../src/shared/prompt-grammar.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { boardPrompt, effectivePrompt, resolveShotStyle } from "../src/main/pipeline.js";

const MASTER = "Heroic 3D render style";
const CONTENT = "A hero walks through the valley.";

function makeShot(overrides: Partial<ProductionShot> = {}): ProductionShot {
  return { id: "s1", number: "0100", audio: "", visual: CONTENT, ...overrides };
}
function makeProduction(overrides: Partial<Production> = {}): Production {
  return {
    meta: { id: "prod-1", name: "T", folder: "C:/workspace/t", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 1 },
    currentStep: 3,
    visualStyle: "",
    styles: [{ id: "st-master", index: 1, name: "Master", prompt: MASTER }],
    scenes: [{ number: 1, title: "S", shots: [makeShot()] }],
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
    ...overrides,
  };
}

/** What updateShotStyle's "None" branch persists onto the shot. */
function noneOverlay(p: Production, shotId: string): Production {
  const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
  if (!shot) throw new Error("no shot");
  const base = shot.prompt?.trim()
    ? shot.prompt
    : boardPrompt(p, shot);
  const stripped = stripStyleParagraph(base);
  return {
    ...p,
    scenes: p.scenes.map((sc) => ({ ...sc, shots: sc.shots.map((s) => s.id === shotId ? { ...s, style: undefined, styleNone: true, prompt: stripped, promptManual: true } : s) })),
  };
}

function shotOf(p: Production): ProductionShot {
  return p.scenes[0].shots[0];
}

describe("classic style dropdown → None", () => {
  it("keeps the master style in an auto-derived shot's prompt until None is picked", () => {
    const p = makeProduction();
    expect(effectivePrompt(p, shotOf(p))).toContain(`Style: ${MASTER}`);
  });

  it("removes the Style section from an auto-derived shot after None", () => {
    const p = noneOverlay(makeProduction(), "s1");
    expect(shotOf(p).style).toBeUndefined();
    expect(shotOf(p).promptManual).toBe(true);
    expect(effectivePrompt(p, shotOf(p))).not.toContain("Style:");
    expect(effectivePrompt(p, shotOf(p))).toContain(CONTENT);
  });

  it("removes the Style section from a manual shot after None", () => {
    const base = makeProduction({
      scenes: [{ number: 1, title: "S", shots: [makeShot({ prompt: `Style: ${MASTER}\n\n${CONTENT}`, promptManual: true, style: "st-master" })] }],
    });
    const p = noneOverlay(base, "s1");
    expect(effectivePrompt(p, shotOf(p))).not.toContain("Style:");
    expect(effectivePrompt(p, shotOf(p))).toContain(CONTENT);
  });

  it("removes the Style section from a Magic-Prompt shot after None", () => {
    const base = makeProduction({
      magicEnabled: true,
      magicPrompts: { s1: CONTENT },
      scenes: [{ number: 1, title: "S", shots: [makeShot({ style: "st-master" })] }],
    });
    // Sanity: while a style is selected the magic prompt carries the style.
    expect(effectivePrompt(base, shotOf(base))).toContain(`Style: ${MASTER}`);
    const p = noneOverlay(base, "s1");
    expect(shotOf(p).style).toBeUndefined();
    expect(effectivePrompt(p, shotOf(p))).not.toContain("Style:");
  });

  it("resolveShotStyle with an empty style yields no paragraph", () => {
    expect(resolveShotStyle(makeProduction(), { ...makeShot(), style: undefined })).toBe("");
  });

  it("styleNone suppresses the master style even for an auto-derived shot", () => {
    // A shot that stayed auto (no manual prompt) but has styleNone: true must
    // not get the master Style paragraph back.
    const p = makeProduction({ scenes: [{ number: 1, title: "S", shots: [makeShot({ styleNone: true })] }] });
    expect(shotOf(p).style).toBeUndefined();
    expect(effectivePrompt(p, shotOf(p))).not.toContain("Style:");
    expect(effectivePrompt(p, shotOf(p))).toContain(CONTENT);
  });

  it("choosing a style clears styleNone and re-applies the master fallback", () => {
    const p = makeProduction({ scenes: [{ number: 1, title: "S", shots: [makeShot({ style: "st-master", styleNone: false })] }] });
    expect(effectivePrompt(p, shotOf(p))).toContain(`Style: ${MASTER}`);
  });
});