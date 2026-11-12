/**
 * Ctrl+Mouse Wheel zoom, panel-aware:
 *  - over a panel with its own zoom control (a slider zone such as a Design
 *    reference category, clamped to that panel's existing range) the wheel
 *    zooms only that panel;
 *  - over a canvas that already owns the wheel (its handler calls
 *    preventDefault: moodboard, timeline, lightbox, node graph) the page
 *    zoom stays out of it;
 *  - everywhere else the wheel steps the whole-page zoom;
 *  - a Ctrl+wheel is always claimed (preventDefault) so it never also
 *    scrolls, and a plain wheel is never touched.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement, act, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  installCtrlWheelPageZoom,
  useCtrlWheelZoom,
  wheelZoomFactor,
  zoomedSliderValue,
} from "../src/renderer/src/components/common/ctrl-wheel-zoom.js";
import { ReferenceCategorySection, REF_TILE_MAX } from "../src/renderer/src/components/production/references.js";
import { nextPageZoomLevel } from "../src/shared/ipc/window.js";
import { ipcContract } from "../src/shared/ipc.js";
import { validateIpcArgs } from "../src/shared/ipc-schemas.js";

const W = globalThis.window as unknown as { WheelEvent: typeof WheelEvent };

(globalThis.window as unknown as Record<string, unknown>).cascade = {
  showImageMenu: async () => {},
};

function wheel(init: WheelEventInit): WheelEvent {
  return new W.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
}

describe("wheel zoom math", () => {
  it("zooms in on wheel-up and out on wheel-down, deltaMode-normalized", () => {
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0 }, 800)).toBeGreaterThan(1);
    expect(wheelZoomFactor({ deltaY: 100, deltaMode: 0 }, 800)).toBeLessThan(1);
    // One line (deltaMode 1) counts as 16px, like the lightbox wheel.
    expect(wheelZoomFactor({ deltaY: -3, deltaMode: 1 }, 800))
      .toBeCloseTo(wheelZoomFactor({ deltaY: -48, deltaMode: 0 }, 800), 10);
  });

  it("clamps a slider value to its panel's existing range", () => {
    expect(zoomedSliderValue(140, 2, 80, 320)).toBe(280);
    expect(zoomedSliderValue(140, 10, 80, 320)).toBe(320);
    expect(zoomedSliderValue(140, 0.01, 80, 320)).toBe(80);
  });

  it("clamps the page zoom level to the keyboard zoom's range", () => {
    expect(nextPageZoomLevel(0, 0.5)).toBe(0.5);
    expect(nextPageZoomLevel(4.9, 0.5)).toBe(5);
    expect(nextPageZoomLevel(-4.9, -0.5)).toBe(-5);
    expect(nextPageZoomLevel(1, Number.NaN)).toBe(1);
  });
});

describe("page zoom fallback (empty space / panels without their own zoom)", () => {
  it("steps the page zoom on Ctrl+wheel and claims the event (no scroll)", () => {
    const zoomPageBy = vi.fn();
    const uninstall = installCtrlWheelPageZoom(window, zoomPageBy);
    const host = document.createElement("div");
    document.body.appendChild(host);

    const up = wheel({ deltaY: -100, ctrlKey: true });
    act(() => { host.dispatchEvent(up); });
    expect(zoomPageBy).toHaveBeenCalledTimes(1);
    expect(zoomPageBy.mock.calls[0][0]).toBeGreaterThan(0);
    expect(up.defaultPrevented).toBe(true);

    const down = wheel({ deltaY: 100, ctrlKey: true });
    act(() => { host.dispatchEvent(down); });
    expect(zoomPageBy.mock.calls[1][0]).toBeLessThan(0);
    expect(down.defaultPrevented).toBe(true);

    uninstall();
    document.body.removeChild(host);
  });

  it("leaves plain wheel scrolling untouched", () => {
    const zoomPageBy = vi.fn();
    const uninstall = installCtrlWheelPageZoom(window, zoomPageBy);
    const host = document.createElement("div");
    document.body.appendChild(host);

    const plain = wheel({ deltaY: -100 });
    act(() => { host.dispatchEvent(plain); });
    expect(zoomPageBy).not.toHaveBeenCalled();
    expect(plain.defaultPrevented).toBe(false);

    uninstall();
    document.body.removeChild(host);
  });

  it("stays out of a canvas that already claimed the wheel (defaultPrevented)", () => {
    const zoomPageBy = vi.fn();
    const uninstall = installCtrlWheelPageZoom(window, zoomPageBy);
    const host = document.createElement("div");
    const ownZoom = vi.fn();
    // Stands in for moodboard / timeline / lightbox / node-graph handlers:
    // they zoom themselves and preventDefault the wheel event.
    host.addEventListener("wheel", (e) => { e.preventDefault(); ownZoom(e.deltaY); }, { passive: false });
    document.body.appendChild(host);

    act(() => { host.dispatchEvent(wheel({ deltaY: -100, ctrlKey: true })); });
    expect(ownZoom).toHaveBeenCalledTimes(1);
    expect(zoomPageBy).not.toHaveBeenCalled();

    uninstall();
    document.body.removeChild(host);
  });
});

function ZoomZone({ onZoom, children, show = true }: { onZoom: (factor: number) => void; children?: unknown; show?: boolean }) {
  const ref = useCtrlWheelZoom<HTMLDivElement>(onZoom);
  // A conditionally rendered panel (Script/Storyboard inside the long-lived
  // workspace) must pick the listener up when it appears, not only if it
  // was on screen when its parent first mounted.
  return show ? createElement("div", { ref, className: "zone" }, children as never) : createElement("div", { className: "no-zone" }, "empty");
}

function OwnWheelChild() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  return createElement("div", { ref, className: "own-wheel" }, "canvas");
}

describe("panel zoom zones", () => {
  it("zooms only the panel on Ctrl+wheel; plain wheel passes through", () => {
    const factors: number[] = [];
    const zoomPageBy = vi.fn();
    const uninstall = installCtrlWheelPageZoom(window, zoomPageBy);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(ZoomZone, { onZoom: (f: number) => factors.push(f) })); });
    const zone = host.querySelector(".zone") as HTMLElement;

    const ctrl = wheel({ deltaY: -100, ctrlKey: true });
    act(() => { zone.dispatchEvent(ctrl); });
    expect(factors).toHaveLength(1);
    expect(factors[0]).toBeGreaterThan(1);
    expect(ctrl.defaultPrevented).toBe(true);
    expect(zoomPageBy).not.toHaveBeenCalled();

    const plain = wheel({ deltaY: -100 });
    act(() => { zone.dispatchEvent(plain); });
    expect(factors).toHaveLength(1);
    expect(plain.defaultPrevented).toBe(false);
    expect(zoomPageBy).not.toHaveBeenCalled();

    act(() => { root.unmount(); });
    uninstall();
    document.body.removeChild(host);
  });

  it("claims the wheel once a conditionally rendered panel appears", () => {
    const onZoom = vi.fn();
    const zoomPageBy = vi.fn();
    const uninstall = installCtrlWheelPageZoom(window, zoomPageBy);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(ZoomZone, { onZoom, show: false })); });

    act(() => { host.dispatchEvent(wheel({ deltaY: -100, ctrlKey: true })); });
    expect(onZoom).not.toHaveBeenCalled();
    expect(zoomPageBy).toHaveBeenCalledTimes(1);

    act(() => { root.render(createElement(ZoomZone, { onZoom, show: true })); });
    const zone = host.querySelector(".zone") as HTMLElement;
    act(() => { zone.dispatchEvent(wheel({ deltaY: -100, ctrlKey: true })); });
    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(zoomPageBy).toHaveBeenCalledTimes(1);

    act(() => { root.unmount(); });
    uninstall();
    document.body.removeChild(host);
  });

  it("lets a nested wheel-owning canvas keep its own zoom (node graph over storyboard)", () => {
    const onZoom = vi.fn();
    const zoomPageBy = vi.fn();
    const uninstall = installCtrlWheelPageZoom(window, zoomPageBy);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(ZoomZone, { onZoom }, createElement(OwnWheelChild)));
    });
    const inner = host.querySelector(".own-wheel") as HTMLElement;

    act(() => { inner.dispatchEvent(wheel({ deltaY: -100, ctrlKey: true })); });
    expect(onZoom).not.toHaveBeenCalled();
    expect(zoomPageBy).not.toHaveBeenCalled();

    act(() => { root.unmount(); });
    uninstall();
    document.body.removeChild(host);
  });
});

describe("Design reference categories (the cited zoomable panel)", () => {
  function renderCategories(tileSize: number, onSetCategoryTileSize: (id: string, size: number) => void) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const noop = () => {};
    act(() => {
      root.render(createElement(ReferenceCategorySection, {
        prodId: "p1",
        categories: [{ id: "c1", name: "Heroes", tileSize }],
        items: [{ id: "r1", name: "Hero", imagePath: "references/hero.png", categoryId: "c1", shotIds: [] }],
        onAddCategory: noop,
        onRenameCategory: noop,
        onSetCategoryTileSize,
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
    return { host, root };
  }

  function categoryPanel(host: HTMLElement): HTMLElement {
    const panels = Array.from(host.querySelectorAll(".prod-category"));
    const panel = panels.find((p) => p.querySelector(".prod-ref"));
    expect(panel).toBeTruthy();
    return panel as HTMLElement;
  }

  it("Ctrl+wheel changes only that category's tile size, within its range", () => {
    const onSet = vi.fn();
    const zoomPageBy = vi.fn();
    const uninstall = installCtrlWheelPageZoom(window, zoomPageBy);
    const { host, root } = renderCategories(140, onSet);
    const panel = categoryPanel(host);

    const ctrl = wheel({ deltaY: -100, ctrlKey: true });
    act(() => { panel.dispatchEvent(ctrl); });
    expect(onSet).toHaveBeenCalledTimes(1);
    expect(onSet.mock.calls[0][0]).toBe("c1");
    expect(onSet.mock.calls[0][1]).toBeGreaterThan(140);
    expect(onSet.mock.calls[0][1]).toBeLessThanOrEqual(REF_TILE_MAX);
    expect(ctrl.defaultPrevented).toBe(true);
    expect(zoomPageBy).not.toHaveBeenCalled();

    const plain = wheel({ deltaY: -100 });
    act(() => { panel.dispatchEvent(plain); });
    expect(onSet).toHaveBeenCalledTimes(1);
    expect(plain.defaultPrevented).toBe(false);

    act(() => { root.unmount(); });
    uninstall();
    document.body.removeChild(host);
  });

  it("at the top of the range the panel still claims Ctrl+wheel (no page zoom, no scroll)", () => {
    const onSet = vi.fn();
    const zoomPageBy = vi.fn();
    const uninstall = installCtrlWheelPageZoom(window, zoomPageBy);
    const { host, root } = renderCategories(REF_TILE_MAX, onSet);
    const panel = categoryPanel(host);

    const ctrl = wheel({ deltaY: -100, ctrlKey: true });
    act(() => { panel.dispatchEvent(ctrl); });
    expect(onSet).not.toHaveBeenCalled();
    expect(ctrl.defaultPrevented).toBe(true);
    expect(zoomPageBy).not.toHaveBeenCalled();

    act(() => { root.unmount(); });
    uninstall();
    document.body.removeChild(host);
  });
});

describe("zoom handlers never touch clicks", () => {
  it("a Ctrl+click after a Ctrl+wheel still reaches click handlers, claimed by neither zoom", () => {
    // Regression guard: the zoom claim is wheel-only. A following
    // Ctrl+click (e.g. storyboard toggle-select under a zoom zone, or the
    // node graph's CTRL+Click wiring) must arrive unclaimed — no
    // preventDefault, no stopPropagation, no zoom state left behind.
    const onZoom = vi.fn();
    const zoomPageBy = vi.fn();
    const uninstall = installCtrlWheelPageZoom(window, zoomPageBy);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(ZoomZone, { onZoom })); });
    const zone = host.querySelector(".zone") as HTMLElement;
    const clicks: MouseEvent[] = [];
    zone.addEventListener("click", (e) => clicks.push(e));

    act(() => { zone.dispatchEvent(wheel({ deltaY: -100, ctrlKey: true })); });
    expect(onZoom).toHaveBeenCalledTimes(1);

    const click = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    act(() => { zone.dispatchEvent(click); });
    expect(clicks).toHaveLength(1);
    expect(clicks[0].ctrlKey).toBe(true);
    expect(click.defaultPrevented).toBe(false);
    // The click zoomed nothing (panel or page).
    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(zoomPageBy).not.toHaveBeenCalled();

    act(() => { root.unmount(); });
    uninstall();
    document.body.removeChild(host);
  });
});

describe("page zoom IPC", () => {
  it("is a fire-and-forget window channel with a finite-number payload", () => {
    expect(ipcContract["window:zoomPageBy" as keyof typeof ipcContract])
      .toEqual({ method: "zoomPageBy", kind: "send" });
    expect(() => validateIpcArgs("window:zoomPageBy", [0.5])).not.toThrow();
    expect(() => validateIpcArgs("window:zoomPageBy", [Number.NaN])).toThrow();
    expect(() => validateIpcArgs("window:zoomPageBy", ["in"])).toThrow();
    expect(() => validateIpcArgs("window:zoomPageBy", [])).toThrow();
  });
});
