/**
 * Context-menu viewport clamping (Issue 2): right-clicking near the
 * bottom/right window edge must shift the menu back inside the viewport so
 * every item stays clickable. Exercises the shared `useClampedMenuStyle`
 * hook through the portaled `GenerationMenu`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { GenerationMenu } from "../src/renderer/src/components/generation-menu.js";

const g = globalThis as Record<string, any>;
let root: Root | null = null;
let host: HTMLElement | null = null;
let origRect: (() => DOMRect) | undefined;
let origW: number;
let origH: number;

function setViewport(w: number, h: number) {
  Object.defineProperty(g.window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(g.window, "innerHeight", { value: h, configurable: true });
}

/** Every measured box reports a 200×220 menu. */
function stubMenuBox() {
  origRect = g.window.Element.prototype.getBoundingClientRect;
  g.window.Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, width: 200, height: 220, top: 0, left: 0, right: 200, bottom: 220, toJSON: () => {} };
  };
}

function menuEl(): HTMLElement {
  const el = g.document.body.querySelector(".session-context-menu") as HTMLElement | null;
  expect(el, "menu element").toBeTruthy();
  return el!;
}

async function renderMenu(x: number, y: number): Promise<void> {
  host = g.document.createElement("div");
  g.document.body.appendChild(host);
  root = createRoot(host!);
  await act(async () => {
    root!.render(
      createElement(GenerationMenu, {
        menu: { x, y, rel: "boards/0100/frame.png" },
        onClose: () => {},
        onSaveAsReference: () => {},
      }),
    );
  });
}

beforeEach(() => {
  origW = g.window.innerWidth;
  origH = g.window.innerHeight;
  setViewport(1280, 800);
  stubMenuBox();
});

afterEach(async () => {
  if (root) { await act(async () => { root!.unmount(); }); root = null; }
  host?.remove();
  host = null;
  g.document.body.innerHTML = "";
  if (origRect) g.window.Element.prototype.getBoundingClientRect = origRect;
  setViewport(origW, origH);
  vi.unstubAllGlobals();
});

describe("useClampedMenuStyle", () => {
  it("pulls a bottom-right-corner menu inside the viewport", async () => {
    await renderMenu(1270, 790);
    const el = menuEl();
    // 1280 - 200 - 8 = 1072; 800 - 220 - 8 = 572.
    expect(el.style.left).toBe("1072px");
    expect(el.style.top).toBe("572px");
    expect(parseFloat(el.style.left)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(el.style.top)).toBeGreaterThanOrEqual(8);
  });

  it("leaves an in-bounds position unchanged", async () => {
    await renderMenu(100, 100);
    const el = menuEl();
    expect(el.style.left).toBe("100px");
    expect(el.style.top).toBe("100px");
  });
});
