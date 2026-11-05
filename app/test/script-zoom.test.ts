/**
 * Script step zoom: a bottom "Script zoom" slider, in the same fixed
 * bottom-right bar as Storyboard's "Frame size" and Design's "Panel width",
 * that zooms the Script panel uniformly — panel size and text size grow
 * together via a single `zoom` factor (`--script-zoom`), not just a wider
 * column. UI-only state like the other bottom sliders (default 100%).
 * jsdom has no layout engine, so intent is asserted on the source/CSS —
 * the same pattern as the other production CSS tests; the live zoom is
 * measured in the seeded Electron verification run.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const css = fs.readFileSync(path.resolve(__dirname, "../src/renderer/src/styles.css"), "utf8");
const workspace = fs.readFileSync(path.resolve(__dirname, "../src/renderer/src/components/ProductionWorkspace.tsx"), "utf8");

function ruleBody(re: RegExp): string {
  const m = css.match(re);
  expect(m, `rule ${re}`).toBeTruthy();
  return m![1];
}

describe("Script step uniform zoom slider", () => {
  it("scales the Script panel uniformly (panel + text) from --script-zoom", () => {
    const body = ruleBody(/\.prod-script-panel\s*\{([^}]*)\}/);
    expect(body).toContain("zoom: var(--script-zoom, 1)");
  });

  it("applies the zoom factor to the Step 1 (Script) section, defaulting to 100%", () => {
    expect(workspace).toMatch(/className="prod-panel prod-script-panel"/);
    expect(workspace).toMatch(/"--script-zoom": `\$\{scriptZoom \/ 100\}`/);
    expect(workspace).toMatch(/\[scriptZoom, setScriptZoom\] = useState\(100\)/);
  });

  it("has a bottom 'Script zoom' slider bar like the other pages, with no readout next to it", () => {
    expect(workspace).toMatch(/<label className="prod-frame-zoom">Script zoom <input type="range" min=\{80\} max=\{180\} step=\{5\} value=\{scriptZoom\}/);
    expect(workspace).toContain('aria-label="Script zoom"');
    expect(workspace).not.toContain("{scriptZoom}px");
    expect(workspace).not.toContain("{scriptZoom}%");
    // Shared fixed bottom bar (bottom-right content) with the other pages.
    const bar = ruleBody(/\.prod-frame-zoom\s*\{([^}]*)\}/);
    expect(bar).toContain("position: fixed");
    expect(bar).toContain("justify-content: flex-end");
  });
});
