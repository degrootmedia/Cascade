/**
 * Shared MediaLightbox (components/common): image stage zooms with the
 * wheel once the natural size is known, Esc closes, and a video that
 * fails to load falls back to its poster still instead of a black box.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { MediaLightbox } from "../src/renderer/src/components/common/MediaLightbox.js";

const W = globalThis.window as unknown as {
  Event: typeof Event;
  KeyboardEvent: typeof KeyboardEvent;
  WheelEvent: typeof WheelEvent;
};

function render(props: Record<string, unknown>): { root: ReturnType<typeof createRoot>; host: HTMLDivElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MediaLightbox, props as never)); });
  return { root, host };
}

function cleanup(root: ReturnType<typeof createRoot>, host: HTMLDivElement): void {
  act(() => { root.unmount(); });
  document.body.removeChild(host);
}

/** jsdom never loads images: fake the natural size, then fire `load`. */
function fakeLoaded(img: HTMLImageElement, w: number, h: number): void {
  Object.defineProperty(img, "naturalWidth", { value: w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: h, configurable: true });
  act(() => { img.dispatchEvent(new W.Event("load", { bubbles: true })); });
}

describe("MediaLightbox", () => {
  it("zooms an image with the wheel and closes on Escape", () => {
    const onClose = vi.fn();
    const { root, host } = render({
      name: "Frame", src: "cascade-media://p1/boards%2Ff.png", kind: "image", onClose,
    });
    // The close button's icon is a 13px cascade-icon (the card's media img
    // rule excludes .cascade-icon, so the 365pt source art can't blow up).
    const closeIcon = document.body.querySelector(".media-lightbox-close img.cascade-icon") as HTMLImageElement;
    expect(closeIcon).toBeTruthy();
    expect(closeIcon.getAttribute("width")).toBe("13");
    const img = document.body.querySelector(".media-lightbox-stage img") as HTMLImageElement;
    expect(img).toBeTruthy();
    fakeLoaded(img, 2000, 1000);

    expect(document.body.querySelector(".media-lightbox-pct")?.textContent).toBe("100%");
    const stage = document.body.querySelector(".media-lightbox-stage") as HTMLElement;
    act(() => {
      stage.dispatchEvent(new W.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -240, clientX: 10, clientY: 10 }));
    });
    const pct = document.body.querySelector(".media-lightbox-pct")?.textContent ?? "";
    expect(parseInt(pct, 10)).toBeGreaterThan(100);

    act(() => { window.dispatchEvent(new W.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);

    cleanup(root, host);
  });

  it("shows native video controls and falls back to a poster on error", () => {
    const { root, host } = render({
      name: "Clip", src: "cascade-media://p1/references%2Fc.mp4", kind: "video", onClose: () => {},
    });
    const video = document.body.querySelector("video.prod-ref-lightbox-video") as HTMLVideoElement;
    expect(video).toBeTruthy();
    expect(video.hasAttribute("controls")).toBe(true);

    act(() => { video.dispatchEvent(new W.Event("error", { bubbles: true })); });
    expect(document.body.querySelector("video.prod-ref-lightbox-video")).toBeFalsy();
    const still = document.body.querySelector('.prod-ref-lightbox-card img[alt="Clip"]') as HTMLImageElement;
    expect(still).toBeTruthy();
    expect(still.getAttribute("src")).toContain("thumb=1");

    cleanup(root, host);
  });
});
