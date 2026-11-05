/**
 * Item 3 regression: each reference category header carries a "Reference
 * size" slider (80–320px, default 140) that sets that category's grid
 * minimum tile width (`--ref-tile-min`, Item 2's responsive grid) — live,
 * per category, and persisted on the category (`tileSize`) through the same
 * field save as renames. Categories (and older projects) without the field
 * render at 140px.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import {
  ReferenceCategorySection,
  refTileSize,
  applyCategoryTileSize,
  REF_TILE_MIN,
  REF_TILE_MAX,
  REF_TILE_DEFAULT,
} from "../src/renderer/src/components/production/references.js";

(globalThis as Record<string, unknown>).window = (globalThis as Record<string, unknown>).window ?? {};
(globalThis.window as unknown as Record<string, unknown>).cascade = {
  showImageMenu: async () => {},
};

describe("refTileSize (stored category size → effective px)", () => {
  it("defaults to 140 when the category has no stored size (older projects)", () => {
    expect(REF_TILE_DEFAULT).toBe(140);
    expect(refTileSize({})).toBe(140);
    expect(refTileSize({ tileSize: undefined })).toBe(140);
  });

  it("uses the stored size, clamped to the 80–320 range", () => {
    expect(REF_TILE_MIN).toBe(80);
    expect(REF_TILE_MAX).toBe(320);
    expect(refTileSize({ tileSize: 240 })).toBe(240);
    expect(refTileSize({ tileSize: 10 })).toBe(80);
    expect(refTileSize({ tileSize: 9999 })).toBe(320);
    expect(refTileSize({ tileSize: Number.NaN })).toBe(140);
  });
});

describe("applyCategoryTileSize (the save mapping)", () => {
  it("writes the clamped size onto the matching category only", () => {
    const categories = [
      { id: "c1", name: "Heroes" },
      { id: "c2", name: "Sets", tileSize: 100 },
    ] as never[];
    const next = applyCategoryTileSize(categories as never, "c1", 500) as unknown as { tileSize?: number }[];
    expect(next[0].tileSize).toBe(320);
    expect(next[1].tileSize).toBe(100);
  });

  it("survives a JSON round-trip (the production document on disk)", () => {
    const categories = [{ id: "c1", name: "Heroes" }] as never[];
    const saved = applyCategoryTileSize(categories as never, "c1", 212);
    const reloaded = JSON.parse(JSON.stringify(saved)) as { tileSize?: number }[];
    expect(refTileSize(reloaded[0])).toBe(212);
  });
});

function renderSection(categories: unknown[], onSetCategoryTileSize: (id: string, size: number) => void, extra: Record<string, unknown> = {}): { root: ReturnType<typeof createRoot>; host: HTMLDivElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const noop = () => {};
  act(() => {
    root.render(createElement(ReferenceCategorySection, {
      prodId: "p1",
      categories,
      items: [
        { id: "r1", name: "Hero", imagePath: "references/hero.png", categoryId: "c1", shotIds: [] },
        { id: "r2", name: "Harbor", imagePath: "references/harbor.png", categoryId: "c2", shotIds: [] },
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
      onSetCategoryTileSize,
      ...extra,
    } as never));
  });
  return { root, host };
}

function panelsByName(host: HTMLElement): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>();
  for (const panel of Array.from(host.querySelectorAll(".prod-category"))) {
    const name = (panel.querySelector(".prod-category-name") as HTMLInputElement | null)?.value ?? "";
    out.set(name, panel as HTMLElement);
  }
  return out;
}

function setRangeValue(input: HTMLInputElement, value: string): void {
  const proto = (globalThis.window as unknown as { HTMLInputElement: { prototype: object } }).HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new (globalThis.window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
  });
}

describe("CategoryPanel size slider (Item 3)", () => {
  it("renders at 140px with no stored size, the stored size otherwise — independently per category", () => {
    const { root, host } = renderSection([
      { id: "c1", name: "Heroes" },
      { id: "c2", name: "Sets", tileSize: 240 },
    ], () => {});
    const panels = panelsByName(host);

    const heroesGrid = panels.get("Heroes")!.querySelector(".prod-ref-grid") as HTMLElement;
    expect(heroesGrid.getAttribute("style")).toContain("--ref-tile-min: 140px");
    const setsGrid = panels.get("Sets")!.querySelector(".prod-ref-grid") as HTMLElement;
    expect(setsGrid.getAttribute("style")).toContain("--ref-tile-min: 240px");

    const heroesSlider = panels.get("Heroes")!.querySelector('input[type="range"]') as HTMLInputElement;
    expect(heroesSlider).toBeTruthy();
    expect(heroesSlider.getAttribute("aria-label")).toBe("Reference size");
    expect(heroesSlider.min).toBe("80");
    expect(heroesSlider.max).toBe("320");
    expect(heroesSlider.value).toBe("140");
    const setsSlider = panels.get("Sets")!.querySelector('input[type="range"]') as HTMLInputElement;
    expect(setsSlider.value).toBe("240");

    // No px readout next to the sliders, and count + slider + generate sit
    // together in one aligned tools cluster at the header's right edge.
    expect(host.querySelector(".prod-category-size-value")).toBeFalsy();
    expect(panels.get("Heroes")!.textContent).not.toContain("140px");
    const tools = panels.get("Heroes")!.querySelector(".prod-category-tools") as HTMLElement;
    expect(tools).toBeTruthy();
    expect(tools.querySelector(".prod-category-count")?.textContent).toBe("(1)");
    expect(tools.querySelector('input[type="range"]')).toBe(heroesSlider);
    expect(tools.querySelector(".prod-ref-gen-btn")).toBeTruthy();

    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("moving the slider saves that category's size (and only that category's)", () => {
    const onSetCategoryTileSize = vi.fn();
    const { root, host } = renderSection([
      { id: "c1", name: "Heroes" },
      { id: "c2", name: "Sets", tileSize: 240 },
    ], onSetCategoryTileSize);
    const panels = panelsByName(host);
    const heroesSlider = panels.get("Heroes")!.querySelector('input[type="range"]') as HTMLInputElement;
    setRangeValue(heroesSlider, "200");
    expect(onSetCategoryTileSize).toHaveBeenCalledWith("c1", 200);
    expect(onSetCategoryTileSize).not.toHaveBeenCalledWith("c2", expect.anything());
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });
});

describe("Uncategorized size slider", () => {
  it("renders its own slider at the 140 default when no size is stored", () => {
    const { root, host } = renderSection([{ id: "c1", name: "Heroes" }], () => {});
    const panels = panelsByName(host);
    const panel = panels.get("Uncategorized")!;
    expect(panel).toBeTruthy();
    const slider = panel.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider).toBeTruthy();
    expect(slider.getAttribute("aria-label")).toBe("Reference size");
    expect(slider.value).toBe("140");
    const grid = panel.querySelector(".prod-ref-grid") as HTMLElement;
    expect(grid.getAttribute("style")).toContain("--ref-tile-min: 140px");
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("uses its stored size and saves under the empty (uncategorized) id", () => {
    const onSetCategoryTileSize = vi.fn();
    const { root, host } = renderSection(
      [{ id: "c1", name: "Heroes", tileSize: 200 }],
      onSetCategoryTileSize,
      { uncategorizedTileSize: 280 },
    );
    const panels = panelsByName(host);
    const panel = panels.get("Uncategorized")!;
    const slider = panel.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider.value).toBe("280");
    const grid = panel.querySelector(".prod-ref-grid") as HTMLElement;
    expect(grid.getAttribute("style")).toContain("--ref-tile-min: 280px");
    // Independent of the real category's size.
    const heroesGrid = panels.get("Heroes")!.querySelector(".prod-ref-grid") as HTMLElement;
    expect(heroesGrid.getAttribute("style")).toContain("--ref-tile-min: 200px");

    setRangeValue(slider, "160");
    expect(onSetCategoryTileSize).toHaveBeenCalledWith("", 160);
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });
});
