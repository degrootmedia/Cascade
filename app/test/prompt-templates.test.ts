/**
 * Prompt-template registry (Settings → Advanced → Prompts): the built-in
 * wording, override resolution, placeholder rendering, and that the main
 * builders honor an override.
 */
import { describe, it, expect, vi } from "vitest";
// pipeline.ts imports scripting.ts, whose dynamic pdf-parse import doesn't
// resolve under Vitest — replace it with a factory (see pipeline.test.ts).
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));
import {
  LOOK_CLAUSE,
  PROMPT_TEMPLATES,
  cameraGridDistribution,
  cameraGridPromptVars,
  promptTemplateDefault,
  renderPromptTemplate,
  resolvePromptTemplate,
  hasTemplateOverrides,
  STYLE_FRAME_SETTING,
  STYLE_FRAME_SUBJECT,
} from "../src/shared/prompt-templates.js";
import { styleFramePrompt } from "../src/shared/look.js";
import { buildEditGenPrompt, characterSheetPrompt } from "../src/main/pipeline.js";

describe("prompt template registry", () => {
  it("has unique ids and non-empty builtins", () => {
    const ids = PROMPT_TEMPLATES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of PROMPT_TEMPLATES) {
      expect(d.builtin.trim().length, d.id).toBeGreaterThan(0);
      expect(d.label.trim().length, d.id).toBeGreaterThan(0);
    }
  });

  it("exposes the shared look vocabulary", () => {
    expect(promptTemplateDefault("lookClause")).toBe(LOOK_CLAUSE);
    expect(promptTemplateDefault("cameraGrid")).toContain("IDENTITY LOCK");
  });

  it("resolves an override, else the built-in (blank falls back)", () => {
    expect(resolvePromptTemplate("videoMotion")).toBe(promptTemplateDefault("videoMotion"));
    expect(resolvePromptTemplate("videoMotion", { videoMotion: "Drift slowly." })).toBe("Drift slowly.");
    expect(resolvePromptTemplate("videoMotion", { videoMotion: "   " })).toBe(promptTemplateDefault("videoMotion"));
    expect(resolvePromptTemplate("nope", { nope: "x" })).toBe("");
  });

  it("renders placeholders and leaves unknown ones intact", () => {
    expect(renderPromptTemplate("a {{x}} b {{ y }}", { x: "1", y: "2" })).toBe("a 1 b 2");
    expect(renderPromptTemplate("{{nope}}", {})).toBe("{{nope}}");
  });

  it("scales the camera-grid shot distribution to the grid size", () => {
    expect(cameraGridDistribution(4, 4)).toContain("AT LEAST 5 wide");
    expect(cameraGridDistribution(4, 4)).toContain("Never exceed 4 face close-ups.");
    expect(cameraGridDistribution(3, 3)).toContain("AT LEAST 3 wide");
    expect(cameraGridDistribution(3, 3)).toContain("Never exceed 2 face close-ups.");
    expect(cameraGridDistribution(2, 2)).toContain("AT LEAST 1 wide");
    expect(cameraGridDistribution(2, 2)).toContain("Never exceed 1 face close-up.");
    // Off-preset geometries get a generic proportional clause.
    expect(cameraGridDistribution(5, 5)).toContain("Spread the 25 cells");
  });

  it("renders the camera-grid template for the chosen geometry", () => {
    const tpl = promptTemplateDefault("cameraGrid");
    const four = renderPromptTemplate(tpl, cameraGridPromptVars(4, 4));
    expect(four).not.toContain("{{");
    expect(four).toContain("the 16 best camera angles");
    expect(four).toContain("clean 4 by 4 grid");
    expect(four).toContain("16:9"); // aspect ratio, never the cell count
    const three = renderPromptTemplate(tpl, cameraGridPromptVars(3, 3));
    expect(three).toContain("the 9 best camera angles");
    expect(three).toContain("clean 3 by 3 grid");
    const two = renderPromptTemplate(tpl, cameraGridPromptVars(2, 2));
    expect(two).toContain("the 4 best camera angles");
    expect(two).toContain("clean 2 by 2 grid");
  });

  it("reports whether overrides actually change a known template", () => {
    expect(hasTemplateOverrides({})).toBe(false);
    expect(hasTemplateOverrides({ videoMotion: promptTemplateDefault("videoMotion") })).toBe(false);
    expect(hasTemplateOverrides({ videoMotion: "custom" })).toBe(true);
  });
});

describe("builders honor a template override", () => {
  it("characterSheetPrompt substitutes {{description}} / {{views}}", () => {
    expect(characterSheetPrompt("a baker", "front", "Sheet: {{description}} / {{views}}")).toBe("Sheet: a baker / Full body front view");
    expect(characterSheetPrompt("a baker", "front-back", "{{views}}")).toBe("Full body front view and full body back view");
  });

  it("buildEditGenPrompt substitutes {{source}} / {{instructions}}", () => {
    expect(buildEditGenPrompt("make it night", "Framing {{source}}: {{instructions}}")).toBe("Framing @image1: make it night");
  });

  it("styleFramePrompt substitutes {{style}} / {{brand}} and keeps the subject scaffold", () => {
    const custom = styleFramePrompt("Noir ink", "Color palette: #fff.", "Style: {{style}} {{brand}}");
    expect(custom).toBe("Style: Noir ink  Production palette/typeface: Color palette: #fff.");
    const builtin = styleFramePrompt("Noir ink", "");
    expect(builtin).toContain(STYLE_FRAME_SUBJECT);
    expect(builtin).toContain(STYLE_FRAME_SETTING);
  });
});
