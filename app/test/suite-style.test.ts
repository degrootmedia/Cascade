/**
 * Image Suite style application (generate flow): picking a Design style mirrors
 * its text into the draft prompt's Style paragraph so the read-only preview
 * matches the picker; None clears it. The look frame + LOOK clause are applied
 * main-side at generation.
 */
import { describe, expect, it } from "vitest";
import { SUITE_CUSTOM_STYLE_VALUE, reconcileSuiteDraftStyle, stripSuiteStyle, suiteDraftForMode, suiteStyleSelectValue, withSuiteStyle } from "../src/renderer/src/features/suite/suite-style.js";
import { applySuiteSeed, openImageSuite, takePendingSuiteSeed } from "../src/renderer/src/features/suite/suite-handoff.js";
import type { ProductionStyle } from "../src/shared/ipc.js";

const style = (over: Partial<ProductionStyle> = {}): ProductionStyle => ({
  id: "st1",
  index: 1,
  name: "Heroic 3D",
  prompt: "soft-3D render, dramatic rim light",
  ...over,
});

describe("withSuiteStyle", () => {
  it("inserts the style text as a leading Style paragraph", () => {
    expect(withSuiteStyle("a red gondola", style())).toBe(
      "Style: soft-3D render, dramatic rim light\n\na red gondola"
    );
  });

  it("replaces an existing Style paragraph rather than duplicating it", () => {
    const prompt = "Style: old look\n\na red gondola";
    const out = withSuiteStyle(prompt, style());
    expect(out).toBe("Style: soft-3D render, dramatic rim light\n\na red gondola");
    expect(out.match(/^Style:/gm)).toHaveLength(1);
  });

  it("preserves @[name] tags and content order through the recompose", () => {
    const out = withSuiteStyle("a hero @[Gandalf] on a boat", style());
    expect(out).toContain("Style: soft-3D render, dramatic rim light");
    expect(out).toContain("a hero @[Gandalf] on a boat");
  });

  it("clears the Style paragraph when None is picked", () => {
    expect(withSuiteStyle("Style: old look\n\na red gondola", undefined)).toBe("a red gondola");
  });

  it("stripSuiteStyle removes only the Style paragraph", () => {
    expect(stripSuiteStyle("Style: ink wash\n\nbrighten @[Hero]")).toBe("brighten @[Hero]");
    expect(stripSuiteStyle("brighten it")).toBe("brighten it");
  });

  it("suiteDraftForMode strips style from edit drafts only (Item 2)", () => {
    const edit = suiteDraftForMode({ mode: "edit", prompt: "Style: ink wash\n\nbrighten it", model: "m", resolution: "1k", refIds: [], styleId: "st1", sourcePath: "boards/0100/f.png" });
    expect(edit.prompt).toBe("brighten it");
    expect(edit.styleId).toBeUndefined();
    expect(edit.sourcePath).toBe("boards/0100/f.png");
    const gen = { mode: "generate" as const, prompt: "Style: ink wash\n\na gondola", model: "m", resolution: "1k", refIds: [], styleId: "st1" };
    expect(suiteDraftForMode(gen)).toBe(gen);
    const cleanEdit = { mode: "edit" as const, prompt: "brighten it", model: "m", resolution: "1k", refIds: [] };
    expect(suiteDraftForMode(cleanEdit)).toBe(cleanEdit);
  });

  it("suiteStyleSelectValue reflects the applied text, not a stale pick (Item 3)", () => {
    const styles = [style(), style({ id: "st2", index: 2, prompt: "ink wash" })];
    // Pick lost, text applied -> the owning style shows.
    expect(suiteStyleSelectValue("Style: ink wash\n\nx", undefined, styles)).toBe("st2");
    // Pick disagrees with applied text -> text wins.
    expect(suiteStyleSelectValue("Style: ink wash\n\nx", "st1", styles)).toBe("st2");
    // Unowned applied text -> Custom (never a false None).
    expect(suiteStyleSelectValue("Style: old look\n\nx", undefined, styles)).toBe(SUITE_CUSTOM_STYLE_VALUE);
    // Pick only (handoff id) -> its style shows.
    expect(suiteStyleSelectValue("x", "st1", styles)).toBe("st1");
    // Nothing applied or picked (and unknown picks) -> None.
    expect(suiteStyleSelectValue("x", undefined, styles)).toBe("");
    expect(suiteStyleSelectValue("x", "gone", styles)).toBe("");
  });

  it("reconcileSuiteDraftStyle repairs the pick toward the applied text (Item 3)", () => {
    const styles = [style(), style({ id: "st2", index: 2, prompt: "ink wash" })];
    const base = { mode: "generate" as const, model: "m", resolution: "1k", refIds: [] };
    expect(reconcileSuiteDraftStyle({ ...base, prompt: "Style: ink wash\n\nx" }, styles).styleId).toBe("st2");
    expect(reconcileSuiteDraftStyle({ ...base, prompt: "Style: old look\n\nx", styleId: "st1" }, styles).styleId).toBeUndefined();
    expect(reconcileSuiteDraftStyle({ ...base, prompt: "Style: old look\n\nx", styleId: "st1" }, styles).prompt).toBe("Style: old look\n\nx");
    expect(reconcileSuiteDraftStyle({ ...base, prompt: "x", styleId: "st1" }, styles).prompt).toBe("Style: soft-3D render, dramatic rim light\n\nx");
    const consistent = { ...base, prompt: "Style: ink wash\n\nx", styleId: "st2" };
    expect(reconcileSuiteDraftStyle(consistent, styles)).toBe(consistent);
    const edit = { ...base, mode: "edit" as const, prompt: "Style: ink wash\n\nx" };
    expect(reconcileSuiteDraftStyle(edit, styles)).toBe(edit);
  });

  it("applySuiteSeed makes the handed-off source win over a stale draft source (Item 4)", () => {
    const draft = { mode: "edit" as const, prompt: "earlier", model: "m", resolution: "1k", refIds: [], sourceRefId: "rOld", styleId: "st1" };
    const byPath = applySuiteSeed(draft, { mode: "edit", prompt: "", model: "", resolution: "1k", refIds: [], sourcePath: "boards/0100/f.png" });
    expect(byPath.sourcePath).toBe("boards/0100/f.png");
    expect(byPath.sourceRefId).toBeUndefined();
    expect(byPath.styleId).toBeUndefined();
    const byRef = applySuiteSeed({ ...draft, sourceRefId: undefined, sourcePath: "boards/old.png" }, { mode: "edit", prompt: "", model: "", resolution: "1k", refIds: [], sourceRefId: "rNew" });
    expect(byRef.sourceRefId).toBe("rNew");
    expect(byRef.sourcePath).toBeUndefined();
  });

  it("a suite handoff carries the style pick, not just the styled prompt (Item 3)", () => {
    openImageSuite("p1", { mode: "generate", prompt: "Style: ink wash\n\nx", styleId: "st2" });
    const taken = takePendingSuiteSeed("p1");
    expect(taken?.seed.styleId).toBe("st2");
  });

  it("is a no-op for a style with blank text", () => {
    expect(withSuiteStyle("a red gondola", style({ prompt: "   " }))).toBe("a red gondola");
  });
});
