/**
 * Design-page reference tiles (`RefFigure` row variant) paint the compressed
 * `?thumb=1` JPEG instead of decoding the full-resolution file, so a large
 * reference library no longer holds one full-size bitmap per visible tile.
 * Zoom keeps the full-res URL, the node/graph variant stays full-res (a working
 * canvas), and legacy inline data URLs pass through unchanged.
 */
import { describe, it, expect } from "vitest";
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
    const lightboxImg = document.body.querySelector(".prod-ref-lightbox img") as HTMLImageElement;
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
