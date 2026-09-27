/**
 * Image Suite style application (generate flow): picking a Design style mirrors
 * its text into the draft prompt's Style paragraph so the read-only preview
 * matches the picker; None clears it. The look frame + LOOK clause are applied
 * main-side at generation.
 */
import { describe, expect, it } from "vitest";
import { withSuiteStyle } from "../src/renderer/src/features/suite/suite-style.js";
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

  it("is a no-op for a style with blank text", () => {
    expect(withSuiteStyle("a red gondola", style({ prompt: "   " }))).toBe("a red gondola");
  });
});
