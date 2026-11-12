/**
 * Moodboard image-node handles (MoodboardNode rotate/resize, MoodboardFrame
 * resize): in the minimal icon set every control on the node must show a
 * real masked glyph — never the plain gray dot the handles used to be (they
 * were empty circle spans that bypassed the shared `icons.tsx` system).
 * The handles must still start their gestures, and the colorful set must
 * keep today's plain-nub handles (its glyph <img> is suppressed by CSS —
 * pinned here via the stylesheet, since jsdom does not lay out).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoodboardNode } from "../src/renderer/src/features/moodboard/MoodboardNode.js";
import { MoodboardFrameView } from "../src/renderer/src/features/moodboard/MoodboardFrame.js";
import { applyIconSet } from "../src/renderer/src/theme.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis.window as unknown as Record<string, unknown>).cascade = {
  showImageMenu: async () => {},
};

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

const REF = { id: "r1", name: "Hero", imagePath: "references/hero.png" } as never;
const NODE = { refId: "r1", x: 10, y: 20, w: 200, h: 150, z: 1, rotation: 0 } as never;

function mountNode(handlers: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(MoodboardNode, {
      prodId: "p1",
      refItem: REF,
      node: NODE,
      selected: true,
      dimmed: false,
      thumbEdge: 0,
      onGestureStart: () => {},
      onResizeStart: () => {},
      onRotateStart: () => {},
      onRemoveFromBoard: () => {},
      onAttach: () => {},
      onRename: () => {},
      onOpenViewer: () => {},
      onContextMenu: () => {},
      ...handlers,
    } as never));
  });
  return {
    host,
    unmount() {
      act(() => { root.unmount(); });
      document.body.removeChild(host);
    },
  };
}

function mountFrame() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(MoodboardFrameView, {
      frame: { id: "f1", label: "Group", color: "blue", x: 0, y: 0, w: 300, h: 200 },
      memberCount: 2,
      selected: true,
      z: 0,
      onStartMove: () => {},
      onStartResize: () => {},
      onLabel: () => {},
      onColor: () => {},
      onUngroup: () => {},
      onContextMenu: () => {},
    } as never));
  });
  return {
    host,
    unmount() {
      act(() => { root.unmount(); });
      document.body.removeChild(host);
    },
  };
}

function pointerDown(el: Element) {
  const PE = (globalThis as Record<string, unknown>).PointerEvent as typeof MouseEvent | undefined;
  const Ctor = PE ?? MouseEvent;
  el.dispatchEvent(new Ctor("pointerdown", { bubbles: true, button: 0 } as never));
}

describe("moodboard node handles in the minimal icon set", () => {
  it("rotate and resize handles carry a masked glyph (no gray dots)", () => {
    applyIconSet("minimal");
    const { host, unmount } = mountNode();
    const rotate = host.querySelector(".moodboard-node-rotate")!;
    const resize = host.querySelector(".moodboard-node-resize")!;
    expect(rotate, "rotate handle").toBeTruthy();
    expect(resize, "resize handle").toBeTruthy();
    expect(rotate.querySelector(".cascade-icon-minimal"), "rotate glyph").toBeTruthy();
    expect(resize.querySelector(".cascade-icon-minimal"), "resize glyph").toBeTruthy();
    // The mask URL is what actually paints the glyph.
    const mask = (rotate.querySelector(".cascade-icon-minimal") as HTMLElement).style;
    expect(mask.maskImage || mask.getPropertyValue("-webkit-mask-image") || (mask as CSSStyleDeclaration & { WebkitMaskImage?: string }).WebkitMaskImage).toBeTruthy();
    unmount();
  });

  it("every other control on the node also shows a minimal glyph", () => {
    applyIconSet("minimal");
    const { host, unmount } = mountNode();
    for (const sel of [".prod-ref-zoom", ".prod-ref-del"]) {
      const btn = host.querySelector(sel);
      expect(btn, sel).toBeTruthy();
      expect(btn!.querySelector(".cascade-icon-minimal"), sel).toBeTruthy();
    }
    // No control on the node is an empty placeholder: each carries an icon
    // glyph or (the suite button) its visible text glyph.
    for (const el of host.querySelectorAll(".prod-ref-actions button, .moodboard-node-rotate, .moodboard-node-resize")) {
      expect(el.querySelector(".cascade-icon") || el.textContent?.trim(), el.className).toBeTruthy();
    }
    unmount();
  });

  it("frame resize handle carries the same minimal glyph", () => {
    applyIconSet("minimal");
    const { host, unmount } = mountFrame();
    const resize = host.querySelector(".moodboard-frame-resize")!;
    expect(resize).toBeTruthy();
    expect(resize.querySelector(".cascade-icon-minimal")).toBeTruthy();
    unmount();
  });

  it("pointerdown on the glyph handles still starts rotate and resize", () => {
    applyIconSet("minimal");
    const onRotateStart = vi.fn();
    const onResizeStart = vi.fn();
    const { host, unmount } = mountNode({ onRotateStart, onResizeStart });
    act(() => { pointerDown(host.querySelector(".moodboard-node-rotate")!); });
    expect(onRotateStart).toHaveBeenCalledTimes(1);
    expect(onRotateStart.mock.calls[0][1]).toBe("r1");
    act(() => { pointerDown(host.querySelector(".moodboard-node-resize")!); });
    expect(onResizeStart).toHaveBeenCalledTimes(1);
    expect(onResizeStart.mock.calls[0][1]).toBe("r1");
    unmount();
  });
});

describe("moodboard node handles in the colorful icon set (unchanged)", () => {
  it("renders no minimal glyph anywhere on the node", () => {
    const { host, unmount } = mountNode();
    expect(host.querySelector(".cascade-icon-minimal")).toBeNull();
    expect(host.querySelector(".moodboard-node-rotate")).toBeTruthy();
    expect(host.querySelector(".moodboard-node-resize")).toBeTruthy();
    unmount();
  });

  it("the stylesheet keeps the colorful handle a plain nub (glyph <img> hidden)", () => {
    const css = fs.readFileSync(
      path.resolve(__dirname, "../src/renderer/src/styles.css"),
      "utf8",
    );
    const rule = css.match(/\.moodboard-node-rotate > img\.cascade-icon[^{]*\{[^}]*display:\s*none/);
    expect(rule, "colorful rotate/resize glyph suppressed").toBeTruthy();
    const frameRule = css.match(/\.moodboard-frame-resize > img\.cascade-icon[^{]*\{[^}]*display:\s*none/);
    expect(frameRule, "colorful frame-resize glyph suppressed").toBeTruthy();
  });
});
