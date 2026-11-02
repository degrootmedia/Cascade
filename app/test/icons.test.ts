/**
 * Icon sets (renderer/src/components/icons.tsx): every exported icon renders
 * as a full-color <img> in the "colorful" set and as a monochrome masked
 * glyph in the "minimal" set, switching live when the set changes. The
 * minimal artwork files are single-color 24x24 outline SVGs.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as icons from "../src/renderer/src/components/icons.js";
import { applyIconSet } from "../src/renderer/src/theme.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  });
  applyIconSet("colorful");
});

afterEach(() => {
  applyIconSet("colorful");
  delete document.documentElement.dataset.iconSet;
  vi.unstubAllGlobals();
});

async function mount(el: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(el); });
  return {
    container,
    async unmount() {
      await act(async () => { root.unmount(); });
      document.body.removeChild(container);
    },
  };
}

const iconComponents = Object.entries(icons).filter(([, v]) => typeof v === "function");

describe("icon sets", () => {
  it("exports the full 25-icon set", () => {
    expect(iconComponents.length).toBe(25);
  });

  it("colorful renders an <img>; switching to minimal swaps it live, no remount", async () => {
    const { container, unmount } = await mount(createElement(icons.SearchIcon, { size: 18 }));
    const img = container.querySelector("img.cascade-icon");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBeTruthy();
    expect(container.querySelector(".cascade-icon-minimal")).toBeNull();

    await act(async () => { applyIconSet("minimal"); });
    expect(container.querySelector("img.cascade-icon")).toBeNull();
    const glyph = container.querySelector(".cascade-icon-minimal");
    expect(glyph).not.toBeNull();
    expect(glyph?.className).toContain("cascade-icon");

    await act(async () => { applyIconSet("colorful"); });
    expect(container.querySelector("img.cascade-icon")).not.toBeNull();
    await unmount();
  });

  it("every icon renders in both sets", async () => {
    for (const [name, Cmp] of iconComponents) {
      const colorful = await mount(createElement(Cmp as never, { iconSet: "colorful" }));
      expect(colorful.container.querySelector("img.cascade-icon"), `${name} colorful`).not.toBeNull();
      await colorful.unmount();

      const minimal = await mount(createElement(Cmp as never, { iconSet: "minimal" }));
      expect(minimal.container.querySelector(".cascade-icon-minimal"), `${name} minimal`).not.toBeNull();
      expect(minimal.container.querySelector("img"), `${name} minimal has no img`).toBeNull();
      await minimal.unmount();
    }
  });

  it("an explicit iconSet prop wins over the global set (settings previews)", async () => {
    await act(async () => { applyIconSet("minimal"); });
    const { container, unmount } = await mount(createElement(icons.PlusIcon, { iconSet: "colorful" }));
    expect(container.querySelector("img.cascade-icon")).not.toBeNull();
    await unmount();
  });
});

describe("minimal artwork files", () => {
  const dir = path.resolve(__dirname, "../src/renderer/src/assets/icons/minimal");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".svg")) : [];

  it("has one minimal SVG per colorful icon", () => {
    const colorfulDir = path.resolve(__dirname, "../src/renderer/src/assets/icons");
    const colorfulCount = fs.readdirSync(colorfulDir).filter((f) => f.endsWith(".svg")).length;
    expect(files.length).toBe(colorfulCount);
    expect(files.length).toBe(25);
  });

  it("each is a single-color 24x24 outline SVG (mask-ready)", () => {
    for (const f of files) {
      const svg = fs.readFileSync(path.join(dir, f), "utf8");
      expect(svg, f).toContain('viewBox="0 0 24 24"');
      const hexes = [...new Set([...svg.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase()))];
      expect(hexes, f).toEqual(["#000"]);
    }
  });
});
