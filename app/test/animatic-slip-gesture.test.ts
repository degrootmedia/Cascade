/**
 * animatic-slip-gesture tests — right-drag slip on the animatic timeline.
 *
 * Mounts `AnimaticTimeline` with a video block and drives the real gesture
 * (right-button pointerdown → pointermove → pointerup) to prove the wiring:
 * a drag with source room commits one offset update, a plain right-click
 * commits nothing, and a block with no slip room never moves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AnimaticTimeline } from "../src/renderer/src/components/production/animatic.js";
import type { ProductionScene, ProductionShot } from "../src/shared/ipc.js";

function makeShot(overrides: Partial<ProductionShot> = {}): ProductionShot {
  return {
    id: "shot1",
    number: "0100",
    audio: "",
    visual: "A hero walks.",
    ...overrides,
  };
}

const props = {
  prodId: "prod1",
  voUrl: null as string | null,
  voDuration: null as number | null,
  onVoDurationKnown: () => {},
  musicUrl: null as string | null,
  musicVolume: 0.5,
  voiceoverVolume: 1,
  onFitToVo: () => {},
  onUpdateTotal: () => {},
  onRemoveVideo: () => {},
  onToggleMute: () => {},
};

describe("AnimaticTimeline slip gesture", () => {
  let root: Root;
  let host: HTMLDivElement;
  let restoreCascade: () => void;
  let onUpdateDurations: ReturnType<typeof vi.fn>;
  let onUpdateVideoOffsets: ReturnType<typeof vi.fn>;
  let probeVideos: HTMLVideoElement[];
  let prevCreateElement: typeof document.createElement;
  let prevClientWidth: PropertyDescriptor | undefined;
  let prevRaf: unknown;
  let prevCancelRaf: unknown;

  function fireProbeMetadata(durationSec: number) {
    for (const v of probeVideos) {
      Object.defineProperty(v, "duration", { configurable: true, value: durationSec });
      (v as unknown as { onloadedmetadata: (() => void) | null }).onloadedmetadata?.();
    }
  }

  function pointer(el: Element, type: string, init: PointerEventInit) {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }));
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // jsdom here has no PointerEvent: React listens by event-type string, so
    // a MouseEvent-flavored stand-in carrying button/buttons/clientX drives
    // the same synthetic handlers.
    if (typeof (globalThis as Record<string, unknown>).PointerEvent === "undefined") {
      class FakePointerEvent extends MouseEvent {
        readonly pointerId: number;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 1;
        }
      }
      vi.stubGlobal("PointerEvent", FakePointerEvent as unknown as typeof PointerEvent);
    }
    // The waveform's scroll/redraw effects use rAF; fire synchronously.
    prevRaf = (window as unknown as Record<string, unknown>).requestAnimationFrame;
    prevCancelRaf = (window as unknown as Record<string, unknown>).cancelAnimationFrame;
    (window as unknown as Record<string, unknown>).requestAnimationFrame = (cb: () => void) => {
      cb();
      return 0;
    };
    (window as unknown as Record<string, unknown>).cancelAnimationFrame = () => {};
    onUpdateDurations = vi.fn();
    onUpdateVideoOffsets = vi.fn();
    probeVideos = [];
    // The strip sizes itself from the scroll viewport: no layout in jsdom, so
    // report a fixed viewport width (800px over a 4s window = 200px/s).
    prevClientWidth = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "clientWidth");
    Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    // jsdom has no pointer capture — the gesture only needs it not to throw.
    window.HTMLElement.prototype.setPointerCapture = vi.fn() as unknown as typeof window.HTMLElement.prototype.setPointerCapture;
    // Collect the metadata-probe <video> elements so tests can resolve them.
    prevCreateElement = document.createElement;
    const origCreate = document.createElement.bind(document);
    document.createElement = ((tag: string, options?: ElementCreationOptions) => {
      const el = origCreate(tag as keyof HTMLElementTagNameMap, options);
      if (tag === "video") probeVideos.push(el as HTMLVideoElement);
      return el;
    }) as typeof document.createElement;
    const previous = Object.getOwnPropertyDescriptor(window, "cascade");
    Object.defineProperty(window, "cascade", {
      configurable: true,
      value: { boardThumbnail: async () => null, onZoomChanged: () => () => {} },
    });
    restoreCascade = () => {
      if (previous) Object.defineProperty(window, "cascade", previous);
      else Reflect.deleteProperty(window, "cascade");
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    restoreCascade();
    document.createElement = prevCreateElement;
    vi.unstubAllGlobals();
    (window as unknown as Record<string, unknown>).requestAnimationFrame = prevRaf;
    (window as unknown as Record<string, unknown>).cancelAnimationFrame = prevCancelRaf;
    if (prevClientWidth) Object.defineProperty(window.HTMLElement.prototype, "clientWidth", prevClientWidth);
  });

  async function renderTimeline(shot: ProductionShot) {
    const scenes: ProductionScene[] = [{ number: 1, title: "Arrival", shots: [shot] }];
    await act(async () => {
      root.render(createElement(AnimaticTimeline, {
        ...props,
        scenes,
        onUpdateDurations,
        onUpdateVideoOffsets,
      }));
      await new Promise((r) => setTimeout(r, 20));
    });
    const block = host.querySelector(".prod-animatic-block");
    if (!block) throw new Error("timeline block did not render");
    return block as HTMLElement;
  }

  it("commits one slip update for a right-drag with source room", async () => {
    const block = await renderTimeline(makeShot({ videoPath: "videos/clip-room.mp4", durationSec: 4 }));
    await act(async () => { fireProbeMetadata(10); });
    await act(async () => {
      // Drag left 100px at 200px/s: the source window opens 0.5s further in.
      pointer(block, "pointerdown", { button: 2, buttons: 2, clientX: 400 });
    });
    await act(async () => {
      pointer(block, "pointermove", { button: -1, buttons: 2, clientX: 300 });
    });
    // Mid-gesture the badge previews the live offset.
    expect(host.querySelector(".prod-animatic-slip-badge")?.textContent).toBe("+0.5s");
    await act(async () => {
      pointer(block, "pointerup", { button: 2, buttons: 0, clientX: 300 });
    });
    expect(onUpdateVideoOffsets).toHaveBeenCalledTimes(1);
    expect(onUpdateVideoOffsets).toHaveBeenCalledWith([{ shotId: "shot1", videoOffsetSec: 0.5 }]);
    expect(onUpdateDurations).not.toHaveBeenCalled();
  });

  it("commits nothing for a plain right-click (no drag)", async () => {
    const block = await renderTimeline(makeShot({ videoPath: "videos/clip-click.mp4", durationSec: 4 }));
    await act(async () => { fireProbeMetadata(10); });
    await act(async () => {
      pointer(block, "pointerdown", { button: 2, buttons: 2, clientX: 400 });
    });
    await act(async () => {
      pointer(block, "pointerup", { button: 2, buttons: 0, clientX: 400 });
    });
    expect(onUpdateVideoOffsets).not.toHaveBeenCalled();
  });

  it("never slips when the source fills the window", async () => {
    const block = await renderTimeline(makeShot({ videoPath: "videos/clip-full.mp4", durationSec: 4 }));
    await act(async () => { fireProbeMetadata(4); });
    await act(async () => {
      pointer(block, "pointerdown", { button: 2, buttons: 2, clientX: 400 });
    });
    await act(async () => {
      pointer(block, "pointermove", { button: -1, buttons: 2, clientX: 100 });
    });
    await act(async () => {
      pointer(block, "pointerup", { button: 2, buttons: 0, clientX: 100 });
    });
    expect(onUpdateVideoOffsets).not.toHaveBeenCalled();
    expect(host.querySelector(".prod-animatic-slip-badge")).toBeNull();
  });

  it("resets to the top from the slip badge", async () => {
    const shot = makeShot({ videoPath: "videos/clip-badge.mp4", durationSec: 4, videoOffsetSec: 1 });
    const scenes: ProductionScene[] = [{ number: 1, title: "Arrival", shots: [shot] }];
    await act(async () => {
      root.render(createElement(AnimaticTimeline, {
        ...props,
        scenes,
        onUpdateDurations,
        onUpdateVideoOffsets,
      }));
      await new Promise((r) => setTimeout(r, 20));
    });
    const badge = host.querySelector(".prod-animatic-slip-badge") as HTMLElement;
    expect(badge?.textContent).toBe("+1.0s");
    await act(async () => {
      badge.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onUpdateVideoOffsets).toHaveBeenCalledWith([{ shotId: "shot1", videoOffsetSec: 0 }]);
  });

  it("ignores right-drags on blocks without a video", async () => {
    const block = await renderTimeline(makeShot({ durationSec: 4 }));
    await act(async () => {
      pointer(block, "pointerdown", { button: 2, buttons: 2, clientX: 400 });
    });
    await act(async () => {
      pointer(block, "pointermove", { button: -1, buttons: 2, clientX: 100 });
    });
    await act(async () => {
      pointer(block, "pointerup", { button: 2, buttons: 0, clientX: 100 });
    });
    expect(onUpdateVideoOffsets).not.toHaveBeenCalled();
  });
});
