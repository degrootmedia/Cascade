/**
 * Design-page reference tiles (`RefFigure` row variant) paint the compressed
 * `?thumb=1` JPEG instead of decoding the full-resolution file, so a large
 * reference library no longer holds one full-size bitmap per visible tile.
 * Zoom keeps the full-res URL, the node/graph variant stays full-res (a working
 * canvas), and legacy inline data URLs pass through unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { RefFigure } from "../src/renderer/src/components/production/references.js";

(globalThis as Record<string, unknown>).window = (globalThis as Record<string, unknown>).window ?? {};
(globalThis.window as unknown as Record<string, unknown>).cascade = {
  showImageMenu: async () => {},
};

const DISK_REF = { id: "r1", name: "Hero", imagePath: "references/hero.png", categoryId: "" } as never;
const DATA_REF = { id: "r2", name: "Legacy", artwork: "data:image/png;base64,LEGACY" } as never;

function render(refItem: unknown, variant: "row" | "node" = "row"): { root: ReturnType<typeof createRoot>; host: HTMLDivElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(RefFigure, {
      prodId: "p1",
      refItem: refItem as never,
      variant,
      onAttach: () => {},
      onRemove: () => {},
      onRename: () => {},
      onReorder: () => {},
    }));
  });
  return { root, host };
}

describe("design-page reference tiles use thumbnails", () => {
  it("paints the tile with ?thumb=1 while the zoom lightbox keeps full-res", () => {
    const { root, host } = render(DISK_REF);
    const tile = host.querySelector(".prod-ref > img") as HTMLImageElement;
    expect(tile).toBeTruthy();
    expect(tile.getAttribute("src")).toBe("cascade-media://p1/references%2Fhero.png?thumb=1");

    const zoomBtn = host.querySelector(".prod-ref-zoom") as HTMLButtonElement;
    expect(zoomBtn).toBeTruthy();
    act(() => { zoomBtn.click(); });
    const lightboxImg = document.body.querySelector('.prod-ref-lightbox img[alt="Hero"]') as HTMLImageElement;
    expect(lightboxImg).toBeTruthy();
    expect(lightboxImg.getAttribute("src")).toBe("cascade-media://p1/references%2Fhero.png");

    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("passes legacy inline data URLs through unchanged", () => {
    const { root, host } = render(DATA_REF);
    const tile = host.querySelector(".prod-ref > img") as HTMLImageElement;
    expect(tile.getAttribute("src")).toBe("data:image/png;base64,LEGACY");

    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("keeps the node (canvas) variant at full resolution", () => {
    const { root, host } = render(DISK_REF, "node");
    const tile = host.querySelector(".prod-ref-node > img") as HTMLImageElement;
    expect(tile.getAttribute("src")).toBe("cascade-media://p1/references%2Fhero.png");

    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });
});

const VIDEO_REF = { id: "r3", name: "Clip", media: "video", mediaPath: "references/clip.mp4", categoryId: "" } as never;
const MISFILED_VIDEO_REF = { id: "r4", name: "Misfiled", imagePath: "references/clip.mp4", categoryId: "" } as never;

// jsdom media elements can't actually play; stub the transport so hover
// handlers can be observed without "not implemented" noise.
const playSpy = vi.fn(() => Promise.resolve());
const pauseSpy = vi.fn();
const mediaProto = (globalThis.window as unknown as { HTMLMediaElement: { prototype: Record<string, unknown> } }).HTMLMediaElement.prototype;
mediaProto.play = playSpy;
mediaProto.pause = pauseSpy;

function hover(el: Element): void {
  const MouseEventCtor = (globalThis.window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
  act(() => { el.dispatchEvent(new MouseEventCtor("mouseover", { bubbles: true })); });
}
function leave(el: Element): void {
  const MouseEventCtor = (globalThis.window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
  act(() => { el.dispatchEvent(new MouseEventCtor("mouseout", { bubbles: true })); });
}

describe("design-page video reference tiles", () => {
  it("lazy-mounts a metadata-preloaded video on hover and re-plays on re-hover", () => {
    playSpy.mockClear(); pauseSpy.mockClear();
    const { root, host } = render(VIDEO_REF);
    expect(host.querySelector("video")).toBeFalsy();
    const placeholder = host.querySelector(".prod-ref-blank") as HTMLElement;
    expect(placeholder).toBeTruthy();

    hover(placeholder);
    const video = host.querySelector("video.prod-ref-video") as HTMLVideoElement;
    expect(video).toBeTruthy();
    expect(video.getAttribute("src")).toBe("cascade-media://p1/references%2Fclip.mp4");
    expect(video.getAttribute("preload")).toBe("metadata");

    // The regression: mouse-leave pauses, and re-hover must play again
    // (previously nothing ever resumed it — a permanent black frame).
    leave(video);
    expect(pauseSpy).toHaveBeenCalled();
    playSpy.mockClear();
    hover(video);
    expect(playSpy).toHaveBeenCalled();

    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("falls back to the poster thumbnail when the video fails to load", () => {
    const { root, host } = render(VIDEO_REF);
    hover(host.querySelector(".prod-ref-blank") as HTMLElement);
    const video = host.querySelector("video.prod-ref-video") as HTMLVideoElement;
    expect(video).toBeTruthy();

    const EventCtor = (globalThis.window as unknown as { Event: typeof Event }).Event;
    act(() => { video.dispatchEvent(new EventCtor("error", { bubbles: true })); });

    expect(host.querySelector("video.prod-ref-video")).toBeFalsy();
    const poster = host.querySelector('.prod-ref-video-thumb img[alt="Clip"]') as HTMLImageElement;
    expect(poster).toBeTruthy();
    expect(poster.getAttribute("src")).toContain("thumb=1");

    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("treats a video file stored under imagePath as a video", () => {
    const { root, host } = render(MISFILED_VIDEO_REF);
    // Not an <img> tile: the hover-to-load placeholder stands in, and the
    // magnifier is offered (previously neither happened without media:"video").
    expect(host.querySelector(".prod-ref > img")).toBeFalsy();
    expect(host.querySelector(".prod-ref-blank")).toBeTruthy();
    expect(host.querySelector(".prod-ref-zoom")).toBeTruthy();

    const zoomBtn = host.querySelector(".prod-ref-zoom") as HTMLButtonElement;
    act(() => { zoomBtn.click(); });
    const lightboxVideo = document.body.querySelector(".prod-ref-lightbox video") as HTMLVideoElement;
    expect(lightboxVideo).toBeTruthy();
    expect(lightboxVideo.getAttribute("src")).toBe("cascade-media://p1/references%2Fclip.mp4");

    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });
});

describe("moodboard node LOD tiers", () => {
  it("paints the settled-zoom tier on the canvas, full-res in the lightbox", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(RefFigure, {
        prodId: "p1",
        refItem: DISK_REF as never,
        variant: "node",
        thumbEdge: 512,
        onAttach: () => {},
        onRemove: () => {},
        onRename: () => {},
        onReorder: () => {},
      } as never));
    });
    const tile = host.querySelector(".prod-ref-node > img") as HTMLImageElement;
    expect(tile.getAttribute("src")).toBe("cascade-media://p1/references%2Fhero.png?thumb=512");

    const zoomBtn = host.querySelector(".prod-ref-zoom") as HTMLButtonElement;
    act(() => { zoomBtn.click(); });
    const lightboxImg = document.body.querySelector('.prod-ref-lightbox img[alt="Hero"]') as HTMLImageElement;
    expect(lightboxImg.getAttribute("src")).toBe("cascade-media://p1/references%2Fhero.png");

    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });
});
