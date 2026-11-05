/**
 * Item 2 regression (revised): the Design step keeps the centered panel
 * column — defaulting to the old 1100px fixed width — with a bottom
 * "Panel width" slider, modeled on Storyboard's fixed "Frame size" bar,
 * that widens or narrows the panels to taste (UI-only state, like
 * Storyboard's). Reference tiles lay out in a responsive
 * grid that shares each row evenly, with the image height scaling
 * proportionally (~140:110) instead of fixed 140x110 tiles in a ragged wrap.
 * jsdom has no layout engine, so layout intent is asserted on styles.css —
 * the same pattern as the graph-lightbox / in-use-badge CSS tests — plus a
 * render smoke test that the category grid still mounts its tiles.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ReferenceCategorySection } from "../src/renderer/src/components/production/references.js";

(globalThis as Record<string, unknown>).window = (globalThis as Record<string, unknown>).window ?? {};
(globalThis.window as unknown as Record<string, unknown>).cascade = {
  showImageMenu: async () => {},
};

const css = fs.readFileSync(path.resolve(__dirname, "../src/renderer/src/styles.css"), "utf8");
const workspace = fs.readFileSync(path.resolve(__dirname, "../src/renderer/src/components/ProductionWorkspace.tsx"), "utf8");
const refsSrc = fs.readFileSync(path.resolve(__dirname, "../src/renderer/src/components/production/references.tsx"), "utf8");

/** The declaration block of the first rule whose selector matches `re`. */
function ruleBody(re: RegExp): string {
  const m = css.match(re);
  expect(m, `rule ${re}`).toBeTruthy();
  return m![1];
}

describe("Design step panel width (Item 2, revised)", () => {
  it("keeps the centered panel column, its width driven by --design-panel-width (1100px default)", () => {
    const body = ruleBody(/\.prod-design-panel\s*\{([^}]*)\}/);
    expect(body).toContain("max-width: var(--design-panel-width, 1100px)");
    expect(body).toContain("margin: 0 auto");
    expect(body).not.toContain("max-width: none");
    // Storyboard keeps its own full-width panel; only Design reverted.
    expect(ruleBody(/\.prod-storyboard-panel\s*\{([^}]*)\}/)).toContain("max-width: none");
  });

  it("feeds the panel width variable from slider state defaulting to 1100", () => {
    expect(workspace).toMatch(/className="prod-panel prod-design-panel"/);
    expect(workspace).toMatch(/"--design-panel-width": `\$\{designPanelWidth\}px`/);
    expect(workspace).toMatch(/useState\(1100\)/);
  });

  it("has a bottom 'Panel width' slider bar like Storyboard's 'Frame size' bar", () => {
    // Same fixed bottom-bar class Storyboard uses, so the two pages match.
    expect(workspace).toMatch(/<label className="prod-frame-zoom">Panel width <input type="range" min=\{720\} max=\{3200\} step=\{20\} value=\{designPanelWidth\}/);
    expect(workspace).toContain('aria-label="Panel width"');
    // The bar's fixed-bottom styling is the shared Storyboard rule.
    const bar = ruleBody(/\.prod-frame-zoom\s*\{([^}]*)\}/);
    expect(bar).toContain("position: fixed");
    expect(bar).toContain("bottom: 0");
  });

  it("shows no px readout next to any production slider", () => {
    expect(workspace).not.toContain("<span>{designPanelWidth}px</span>");
    expect(workspace).not.toContain("<span>{frameZoom}px</span>");
    expect(workspace).not.toContain("<span>{scriptZoom}px</span>");
    expect(refsSrc).not.toContain("prod-category-size-value");
    expect(css).not.toContain(".prod-category-size-value");
    expect(css).not.toContain(".prod-frame-zoom span");
  });

  it("groups count, size slider, and generate button in one aligned tools cluster", () => {
    const tools = ruleBody(/\.prod-category-tools\s*\{([^}]*)\}/);
    expect(tools).toContain("display: flex");
    expect(tools).toContain("align-items: center");
    expect(refsSrc).toContain('className="prod-category-tools"');
    expect(refsSrc).toContain('className="hint prod-category-count"');
  });

  it("shows the References help tip in the panel title bar, not inside the body", () => {
    expect(workspace).toMatch(/<DesignSection title="References" prodId=\{prod\.meta\.id\} help="Create categories for your references/);
    expect(refsSrc).not.toContain("HelpTip");
    expect(refsSrc).toContain('<label className="prod-label">Reference images</label>');
  });
});

describe("responsive reference grid (Item 2)", () => {
  it("lays tiles out with an auto-fill grid that shares the row width", () => {
    const body = ruleBody(/\.prod-ref-grid\s*\{([^}]*)\}/);
    expect(body).toContain("display: grid");
    expect(body).toMatch(/repeat\(auto-fill,\s*minmax\(var\(--ref-tile-min,\s*140px\),\s*1fr\)\)/);
    expect(body).not.toContain("flex-wrap");
  });

  it("no longer fixes the tile width at 140px", () => {
    const body = ruleBody(/\.prod-ref\s*\{([^}]*)\}/);
    expect(body).not.toContain("width: 140px");
  });

  it("scales row-tile media height proportionally (~140:110) instead of a fixed 110px", () => {
    const img = ruleBody(/\.prod-ref:not\(\.prod-ref-node\) > img\s*\{([^}]*)\}/);
    expect(img).toContain("aspect-ratio: 14 / 11");
    expect(img).not.toContain("height: 110px");
  });

  it("still renders category tiles inside the grid", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const noop = () => {};
    act(() => {
      root.render(createElement(ReferenceCategorySection, {
        prodId: "p1",
        categories: [{ id: "c1", name: "Heroes" }],
        items: [
          { id: "r1", name: "Hero", imagePath: "references/hero.png", categoryId: "c1", shotIds: [] },
          { id: "r2", name: "Sidekick", imagePath: "references/side.png", categoryId: "c1", shotIds: [] },
        ],
        onAddCategory: noop,
        onRenameCategory: noop,
        onAddReference: noop,
        onAttach: noop,
        onRemove: noop,
        onRename: noop,
        onMove: noop,
        onReorder: noop,
        onGenerate: noop,
        onRescan: noop,
      } as never));
    });
    // The first panel is the empty Uncategorized group; the Heroes panel holds both tiles.
    const grids = host.querySelectorAll(".prod-category .prod-ref-grid");
    const grid = Array.from(grids).find((g) => g.querySelectorAll(".prod-ref").length > 0);
    expect(grid).toBeTruthy();
    expect(grid!.querySelectorAll(".prod-ref").length).toBe(2);
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });
});
