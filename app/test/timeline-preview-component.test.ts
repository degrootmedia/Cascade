/**
 * TimelinePreview component tests — old-animatic replacement.
 *
 * The preview above the editor is timeline-only and playhead-controlled:
 * the Step 4 section owns {playheadSec, playing}; the preview renders the
 * frame at that position, reports scrub/stop through callbacks, and has
 * no shot strip of its own (the TimelineEditor below is the only strip).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TimelinePreview } from "../src/renderer/src/components/production/animatic.js";
import { buildTimelineOverride } from "../src/renderer/src/components/production/timeline-preview.js";
import type { ProductionTimeline } from "../src/shared/ipc.js";

const timeline: ProductionTimeline = {
  version: 1,
  tracks: [{ id: "v1", kind: "video", name: "V1" }],
  clips: [
    { id: "c1", trackId: "v1", sourceKind: "video", srcRel: "clips/one.mp4", sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 0 },
  ],
};

describe("TimelinePreview", () => {
  let root: Root;
  let host: HTMLDivElement;
  let restoreCascade: () => void;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    window.HTMLElement.prototype.setPointerCapture = vi.fn() as unknown as typeof window.HTMLElement.prototype.setPointerCapture;
    window.HTMLElement.prototype.releasePointerCapture = vi.fn() as unknown as typeof window.HTMLElement.prototype.releasePointerCapture;
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
    vi.unstubAllGlobals();
  });

  async function renderPreview(over: Record<string, unknown> = {}) {
    const override = buildTimelineOverride(timeline, undefined, {}, new Map());
    await act(async () => {
      root.render(createElement(TimelinePreview, {
        prodId: "prod1",
        timelineOverride: override,
        playheadSec: 5,
        onPlayheadChange: () => {},
        playing: false,
        onPlayingChange: () => {},
        ...over,
      }));
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  it("shows the controlled playhead against the timeline total", async () => {
    await renderPreview();
    expect(host.querySelector(".prod-animatic-time")?.textContent).toContain("0:05 / 0:08");
    const fill = host.querySelector(".prod-animatic-scrub-fill") as HTMLElement;
    expect(fill.style.width).toBe("62.5%");
  });

  it("has no shot strip and no strip-era controls", async () => {
    await renderPreview();
    expect(host.querySelector(".prod-animatic-strip")).toBeNull();
    expect(host.querySelector(".prod-animatic-block")).toBeNull();
    expect(host.querySelector(".prod-animatic-edittools")).toBeNull();
    const texts = [...host.querySelectorAll("button")].map((b) => b.textContent);
    expect(texts).not.toContain("Fit to VO");
    expect(host.querySelector(".prod-animatic-total-input")).toBeNull();
  });

  it("plays audio-track clips from hidden per-clip players (no VO/music beds)", async () => {
    const playStub = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const tl2: ProductionTimeline = {
      ...timeline,
      tracks: [...timeline.tracks, { id: "a1", kind: "audio", name: "A1" }],
      clips: [
        ...timeline.clips,
        { id: "au", trackId: "a1", sourceKind: "audio", srcRel: "audio/tone.mp3", sourceInSec: 0, sourceOutSec: 6, timelineStartSec: 1, volume: 0.5 },
      ],
    };
    const override = buildTimelineOverride(tl2, undefined, {}, new Map());
    await renderPreview({ timelineOverride: override, playing: true, playheadSec: 2 });
    const els = [...host.querySelectorAll("audio")] as HTMLAudioElement[];
    expect(els).toHaveLength(1);
    expect(els[0].getAttribute("src")).toContain("audio%2Ftone.mp3");
    expect(els[0].volume).toBeCloseTo(0.5, 6);
    expect(playStub).toHaveBeenCalled();
    // The legacy under-preview VO waveform strip and bed meter are gone.
    expect(host.querySelector(".prod-animatic-wave-row")).toBeNull();
    expect(host.querySelector(".prod-animatic-meter")).toBeNull();
    playStub.mockRestore();
  });

  it("scrubbing the transport reports seek + pause through the callbacks", async () => {
    const heads: number[] = [];
    const plays: boolean[] = [];
    await renderPreview({
      onPlayheadChange: (s: number) => heads.push(s),
      onPlayingChange: (p: boolean) => plays.push(p),
    });
    const scrub = host.querySelector(".prod-animatic-scrub") as HTMLElement;
    scrub.getBoundingClientRect = () =>
      ({ left: 0, right: 200, top: 0, bottom: 10, width: 200, height: 10, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    await act(async () => {
      scrub.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 100 }));
    });
    expect(heads[heads.length - 1]).toBeCloseTo(4, 6);
    expect(plays).toContain(false);
  });

  it("playback advances the playhead at wall-clock rate (1x)", async () => {
    // Stateful harness mirroring TimelineSection: the preview reports the
    // head up, the parent feeds it straight back down as a prop.
    const heads: number[] = [];
    const override = buildTimelineOverride(timeline, undefined, {}, new Map());
    function Harness() {
      const [head, setHead] = useState(0);
      const [playing, setPlaying] = useState(false);
      return createElement(TimelinePreview, {
        prodId: "prod1",
        timelineOverride: override,
        playheadSec: head,
        onPlayheadChange: (s: number) => { heads.push(s); setHead(s); },
        playing,
        onPlayingChange: setPlaying,
      });
    }
    // Media elements report themselves ready so play() doesn't wait, and
    // jsdom's play() (returns undefined) becomes a resolved promise.
    const playStub = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pauseStub = vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const prevReady = Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, "readyState");
    Object.defineProperty(window.HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
    // Manual RAF + clock.
    let rafCb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", ((cb: FrameRequestCallback) => { rafCb = cb; return 1; }) as typeof window.requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", (() => { rafCb = null; }) as typeof window.cancelAnimationFrame);
    let nowMs = 100000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    try {
      await act(async () => {
        root.render(createElement(Harness));
        await new Promise((r) => setTimeout(r, 20));
      });
      const playBtn = [...host.querySelectorAll("button")].find((b) => b.title === "Play from playhead") as HTMLButtonElement;
      await act(async () => { playBtn.click(); await new Promise((r) => setTimeout(r, 20)); });
      expect(rafCb).not.toBeNull();
      // Simulate 2.0s of playback in 100ms frames.
      for (let i = 0; i < 20; i++) {
        nowMs += 100;
        const cb = rafCb;
        rafCb = null;
        await act(async () => { cb?.(nowMs); });
      }
      const last = heads[heads.length - 1];
      expect(last).toBeGreaterThan(1.8);
      expect(last).toBeLessThan(2.2);
    } finally {
      nowSpy.mockRestore();
      playStub.mockRestore();
      pauseStub.mockRestore();
      if (prevReady) Object.defineProperty(window.HTMLMediaElement.prototype, "readyState", prevReady);
    }
  });

  it("loop region wraps playback from Out back to In and keeps playing", async () => {
    const heads: number[] = [];
    const override = buildTimelineOverride(timeline, undefined, {}, new Map());
    function Harness() {
      const [head, setHead] = useState(0);
      const [playing, setPlaying] = useState(false);
      return createElement(TimelinePreview, {
        prodId: "prod1",
        timelineOverride: override,
        playheadSec: head,
        onPlayheadChange: (s: number) => { heads.push(s); setHead(s); },
        playing,
        onPlayingChange: setPlaying,
        loopRegion: { inSec: 2, outSec: 4, enabled: true },
      });
    }
    const playStub = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pauseStub = vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const prevReady = Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, "readyState");
    Object.defineProperty(window.HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
    const raf: { cb: FrameRequestCallback | null } = { cb: null };
    vi.stubGlobal("requestAnimationFrame", ((cb: FrameRequestCallback) => { raf.cb = cb; return 1; }) as typeof window.requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", (() => { raf.cb = null; }) as typeof window.cancelAnimationFrame);
    let nowMs = 100000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    try {
      await act(async () => {
        root.render(createElement(Harness));
        await new Promise((r) => setTimeout(r, 20));
      });
      const playBtn = [...host.querySelectorAll("button")].find((b) => b.title === "Play from playhead") as HTMLButtonElement;
      await act(async () => { playBtn.click(); await new Promise((r) => setTimeout(r, 20)); });
      // 10s of playback in 250ms frames, starting before the region.
      for (let i = 0; i < 40; i++) {
        nowMs += 250;
        const cb = raf.cb;
        raf.cb = null;
        await act(async () => { cb?.(nowMs); });
      }
      // Entered the region, wrapped at Out (a head near In follows a
      // head near Out), never ran past Out, still playing at the end.
      const nearOut = heads.findIndex((h) => h > 3.7);
      expect(nearOut).toBeGreaterThanOrEqual(0);
      expect(heads.slice(nearOut + 1).some((h) => h >= 2 && h < 2.3)).toBe(true);
      expect(Math.max(...heads)).toBeLessThanOrEqual(4.001);
      expect(raf.cb).not.toBeNull();
    } finally {
      nowSpy.mockRestore();
      playStub.mockRestore();
      pauseStub.mockRestore();
      if (prevReady) Object.defineProperty(window.HTMLMediaElement.prototype, "readyState", prevReady);
    }
  });

  it("still-to-still dissolve stacks the outgoing still and fades the incoming in", async () => {
    const stills: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "v1", kind: "video", name: "V1" }],
      clips: [
        { id: "a", trackId: "v1", sourceKind: "still", srcRel: "stills/a.jpg", holdSec: 4, timelineStartSec: 0 },
        { id: "b", trackId: "v1", sourceKind: "still", srcRel: "stills/b.jpg", holdSec: 4, timelineStartSec: 4 },
      ],
      transitions: [{ id: "t1", type: "dissolve", outgoingClipId: "a", incomingClipId: "b", durationSec: 2 }],
    };
    const override = buildTimelineOverride(stills, undefined, {}, new Map());
    // Park mid-dissolve (window 3..5): outgoing still underneath,
    // incoming at half opacity — a blend, not a cut or a dip.
    await renderPreview({ timelineOverride: override, playheadSec: 4 });
    const under = host.querySelector("img.blend-under") as HTMLImageElement;
    expect(under).toBeTruthy();
    expect(under.getAttribute("src")).toContain("a.jpg");
    const top = host.querySelector(".prod-timeline-thumb") as HTMLElement;
    expect(top).toBeTruthy();
    expect(Number(top.style.opacity)).toBeCloseTo(0.5, 5);
  });

  it("stop rewinds the shared playhead to 0", async () => {
    const heads: number[] = [];
    await renderPreview({ onPlayheadChange: (s: number) => heads.push(s) });
    const stopBtn = [...host.querySelectorAll("button")].find((b) => b.title === "Stop and rewind") as HTMLButtonElement;
    await act(async () => { stopBtn.click(); });
    expect(heads).toContain(0);
  });
});
