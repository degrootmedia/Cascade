/**
 * TimelineEditor gesture tests — Animatic Editor Expansion Item A3.
 *
 * Mounts the multi-track editor over a preset ProductionTimeline and
 * drives the real interactions: seed rendering, playhead seek, S split,
 * click-select + Delete, edge-drag trim, snap on/off drag landing, and
 * undo back to the exact start state. Commits are captured through
 * onTimelineChange into a stateful wrapper (the saveField round-trip).
 * jsdom technique mirrors animatic-slip-gesture.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TimelineEditor } from "../src/renderer/src/components/production/timeline-editor.js";
import type { Production, ProductionTimeline } from "../src/shared/ipc.js";
import { clipDurationSec } from "../src/shared/ipc.js";

function presetTimeline(): ProductionTimeline {
  return {
    version: 1,
    tracks: [
      { id: "v1", kind: "video", name: "V1" },
      { id: "a1", kind: "audio", name: "A1" },
    ],
    clips: [
      { id: "c1", trackId: "v1", sourceKind: "video", srcRel: "clips/one.mp4", sourceInSec: 0, sourceOutSec: 4, timelineStartSec: 0 },
      { id: "c2", trackId: "v1", sourceKind: "still", srcRel: "stills/two.jpg", holdSec: 3, timelineStartSec: 6 },
      { id: "c3", trackId: "a1", sourceKind: "audio", srcRel: "audio/vo.mp3", sourceInSec: 0, sourceOutSec: 9, timelineStartSec: 0 },
    ],
  };
}

function makeProduction(timeline: ProductionTimeline): Production {
  return {
    meta: { id: "prod1", name: "Editor Test", folder: "/tmp/prod1", createdAt: "", updatedAt: "", stepDone: 4, shotCount: 0 },
    currentStep: 4,
    visualStyle: "",
    styles: [],
    scenes: [],
    characters: [],
    products: [],
    status: {},
    timeline,
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
  } as Production;
}

describe("TimelineEditor", () => {
  let root: Root;
  let host: HTMLDivElement;
  let restoreCascade: () => void;
  let commits: ProductionTimeline[];
  let latest: ProductionTimeline;
  let prevClientWidth: PropertyDescriptor | undefined;

  function pointer(el: Element, type: string, init: PointerEventInit) {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }));
  }
  function key(el: Element, keyName: string, init: KeyboardEventInit = {}) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...init }));
  }
  const editorEl = (): HTMLElement => host.querySelector('[data-testid="timeline-editor"]') as HTMLElement;
  const pps = (): number => Number(editorEl().dataset.pps);
  const clipEl = (id: string): HTMLElement => host.querySelector(`[data-clip-id="${id}"]`) as HTMLElement;
  const buttonByText = (text: string): HTMLButtonElement =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;
  /** Toolbar action buttons are icon-only since UI cleanup Item 1: they are
   *  found by the aria-label that names the action. */
  const buttonByLabel = (label: string): HTMLButtonElement =>
    [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label) as HTMLButtonElement;

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
    prevClientWidth = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "clientWidth");
    Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
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
    commits = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    restoreCascade();
    vi.unstubAllGlobals();
    if (prevClientWidth) Object.defineProperty(window.HTMLElement.prototype, "clientWidth", prevClientWidth);
  });

  async function renderEditor(timeline: ProductionTimeline) {
    latest = timeline;
    function Harness() {
      const [prod, setProd] = useState<Production>(() => makeProduction(timeline));
      return createElement(TimelineEditor, {
        prodId: "prod1",
        production: prod,
        onTimelineChange: (t: ProductionTimeline) => {
          commits.push(t);
          latest = t;
          setProd((p) => ({ ...p, timeline: t }));
        },
      });
    }
    await act(async () => {
      root.render(createElement(Harness));
      await new Promise((r) => setTimeout(r, 20));
    });
    if (!editorEl()) throw new Error("timeline editor did not render");
  }

  async function seekTo(sec: number) {
    const lanes = host.querySelector(".prod-tl-lanes") as HTMLElement;
    await act(async () => {
      pointer(lanes, "pointerdown", { button: 0, buttons: 1, clientX: sec * pps() });
      pointer(lanes, "pointerup", { button: 0, buttons: 0, clientX: sec * pps() });
    });
  }

  it("renders track headers and clips from the model", async () => {
    await renderEditor(presetTimeline());
    const names = [...host.querySelectorAll(".prod-tl-track-name")].map((i) => (i as HTMLInputElement).value || (i as HTMLInputElement).defaultValue);
    expect(names).toEqual(["V1", "A1"]);
    expect(host.querySelectorAll("[data-clip-id]")).toHaveLength(3);
    expect(host.querySelector(".prod-tl-filmstrip")).not.toBeNull();
    expect(host.querySelector(".prod-tl-wave")).not.toBeNull();
  });

  it("S splits every track at the playhead; Delete removes the selection", async () => {
    await renderEditor(presetTimeline());
    await seekTo(2);
    await act(async () => { key(editorEl(), "s"); });
    const vStarts = latest.clips.filter((c) => c.trackId === "v1").map((c) => c.timelineStartSec).sort((a, b) => a - b);
    expect(vStarts).toEqual([0, 2, 6]);
    expect(latest.clips.filter((c) => c.trackId === "a1")).toHaveLength(2);

    // Select the first video clip by clicking it, then Delete.
    const firstId = latest.clips.find((c) => c.trackId === "v1" && c.timelineStartSec === 0)!.id;
    await act(async () => {
      pointer(clipEl(firstId), "pointerdown", { button: 0, buttons: 1, clientX: 10 });
      pointer(clipEl(firstId), "pointerup", { button: 0, buttons: 0, clientX: 10 });
    });
    expect(clipEl(firstId).className).toContain("selected");
    await act(async () => { key(editorEl(), "Delete"); });
    expect(latest.clips.some((c) => c.id === firstId)).toBe(false);
  });

  it("edge drag trims the tail on the frame grid", async () => {
    await renderEditor(presetTimeline());
    const edge = clipEl("c2").querySelector(".prod-tl-clip-edge.tail") as HTMLElement;
    const x0 = 9 * pps();
    await act(async () => { pointer(edge, "pointerdown", { button: 0, buttons: 1, clientX: x0 }); });
    await act(async () => { pointer(edge, "pointermove", { button: -1, buttons: 1, clientX: x0 + pps() }); });
    await act(async () => { pointer(edge, "pointerup", { button: 0, buttons: 0, clientX: x0 + pps() }); });
    expect(clipDurationSec(latest.clips.find((c) => c.id === "c2")!)).toBe(4);
  });

  it("snapping pulls a move onto a neighboring edge; off lands exactly", async () => {
    await renderEditor(presetTimeline());
    const body = () => clipEl("c2");
    const dragBy = async (dxSec: number) => {
      const x0 = 6 * pps() + 20;
      await act(async () => { pointer(body(), "pointerdown", { button: 0, buttons: 1, clientX: x0 }); });
      await act(async () => { pointer(body(), "pointermove", { button: -1, buttons: 1, clientX: x0 + dxSec * pps() }); });
      await act(async () => { pointer(body(), "pointerup", { button: 0, buttons: 0, clientX: x0 + dxSec * pps() }); });
    };
    // Snap ON: -1.95s from 6 would land at 4.05 — snapped onto c1's end (4).
    await dragBy(-1.95);
    expect(latest.clips.find((c) => c.id === "c2")!.timelineStartSec).toBe(4);
    // Undo, snap OFF, same drag lands on the raw frame grid instead.
    await act(async () => { buttonByLabel("Undo").click(); });
    await act(async () => { buttonByText("Snap").click(); });
    await dragBy(-1.95);
    expect(latest.clips.find((c) => c.id === "c2")!.timelineStartSec).toBeCloseTo(97 / 24, 6);
  });

  it("speed preset retimes the selected clip and labels it", async () => {
    await renderEditor(presetTimeline());
    await act(async () => {
      pointer(clipEl("c1"), "pointerdown", { button: 0, buttons: 1, clientX: 10 });
      pointer(clipEl("c1"), "pointerup", { button: 0, buttons: 0, clientX: 10 });
    });
    const select = host.querySelector(".prod-tl-speed") as HTMLSelectElement;
    await act(async () => {
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const c1 = latest.clips.find((c) => c.id === "c1")!;
    expect(c1.speed).toBe(2);
    expect(clipDurationSec(c1)).toBe(2);
    expect(clipEl("c1").textContent).toContain("2×");
    // Reverse toggles without touching duration.
    await act(async () => { buttonByLabel("Reverse").click(); });
    const rev = latest.clips.find((c) => c.id === "c1")!;
    expect(rev.reversed).toBe(true);
    expect(clipDurationSec(rev)).toBe(2);
  });

  it("Add ramp seeds keyframes; dragging a dot retimes the clip", async () => {
    await renderEditor(presetTimeline());
    await act(async () => {
      pointer(clipEl("c1"), "pointerdown", { button: 0, buttons: 1, clientX: 10 });
      pointer(clipEl("c1"), "pointerup", { button: 0, buttons: 0, clientX: 10 });
    });
    await act(async () => { buttonByLabel("Add ramp").click(); });
    const ramped = latest.clips.find((c) => c.id === "c1")!;
    expect(ramped.speedCurve).toHaveLength(3);
    const dots = host.querySelectorAll(".prod-tl-ramp-dot");
    expect(dots).toHaveLength(3);
    // Drag the middle dot down (slower): duration must grow past 4s.
    const mid = dots[1] as unknown as HTMLElement;
    await act(async () => { pointer(mid, "pointerdown", { button: 0, buttons: 1, clientX: 2 * pps(), clientY: 28 }); });
    await act(async () => { pointer(mid, "pointermove", { button: -1, buttons: 1, clientX: 2 * pps(), clientY: 52 }); });
    await act(async () => { pointer(mid, "pointerup", { button: 0, buttons: 0, clientX: 2 * pps(), clientY: 52 }); });
    const after = latest.clips.find((c) => c.id === "c1")!;
    expect(after.speedCurve![1].speed).toBeLessThan(1);
    expect(clipDurationSec(after)).toBeGreaterThan(4);
    expect(clipEl("c1").textContent).toContain("ramp");
    // Alt+click the middle dot deletes that keyframe.
    const mid2 = host.querySelectorAll(".prod-tl-ramp-dot")[1] as unknown as HTMLElement;
    await act(async () => { pointer(mid2, "pointerdown", { button: 0, buttons: 1, clientX: 2 * pps(), altKey: true }); });
    expect(latest.clips.find((c) => c.id === "c1")!.speedCurve).toHaveLength(2);
  });

  it("proxy badge shows for proxied clips and the Proxies button generates", async () => {
    const gen = vi.fn(async () => {});
    function Harness() {
      const [prod, setProd] = useState<Production>(() => makeProduction(presetTimeline()));
      return createElement(TimelineEditor, {
        prodId: "prod1",
        production: prod,
        onTimelineChange: (t: ProductionTimeline) => {
          commits.push(t);
          latest = t;
          setProd((p) => ({ ...p, timeline: t }));
        },
        proxyBySrc: { "clips/one.mp4": "out/proxies/one-x.mp4" },
        onGenerateProxies: gen,
      });
    }
    await act(async () => {
      root.render(createElement(Harness));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(clipEl("c1").textContent).toContain("proxy");
    expect(clipEl("c2").textContent).not.toContain("proxy");
    await act(async () => { buttonByLabel("Proxies").click(); });
    expect(gen).toHaveBeenCalledTimes(1);
    expect(gen.mock.calls[0]).toEqual([]);
  });

  it("volume line, fade handles, track slider, and pitch toggle edit audio (Item 7)", async () => {
    await renderEditor(presetTimeline());
    // Volume line: drag to mid-height of the audio row (jsdom rects are
    // 0-sized, so the gesture falls back to the 68px audio row height).
    const vol = host.querySelector('[data-vol="c3"]') as HTMLElement;
    expect(vol).not.toBeNull();
    await act(async () => { pointer(vol, "pointerdown", { button: 0, buttons: 1, clientX: 30, clientY: 0 }); });
    await act(async () => { pointer(vol, "pointermove", { button: -1, buttons: 1, clientX: 30, clientY: 34 }); });
    await act(async () => { pointer(vol, "pointerup", { button: 0, buttons: 0, clientX: 30, clientY: 34 }); });
    expect(latest.clips.find((c) => c.id === "c3")!.volume).toBeCloseTo(0.5, 6);

    // Fade-in handle: drag 2 seconds in from the corner.
    const fadeIn = host.querySelector('[data-fade-in="c3"]') as HTMLElement;
    await act(async () => { pointer(fadeIn, "pointerdown", { button: 0, buttons: 1, clientX: 0, clientY: 2 }); });
    await act(async () => { pointer(fadeIn, "pointermove", { button: -1, buttons: 1, clientX: 2 * pps(), clientY: 2 }); });
    await act(async () => { pointer(fadeIn, "pointerup", { button: 0, buttons: 0, clientX: 2 * pps(), clientY: 2 }); });
    expect(latest.clips.find((c) => c.id === "c3")!.fadeInSec).toBeCloseTo(2, 6);
    expect(host.querySelector(".prod-tl-fade.in")).not.toBeNull();

    // Fade-out handle: drag 1 second in from the tail.
    const fadeOut = host.querySelector('[data-fade-out="c3"]') as HTMLElement;
    const xTail = 9 * pps();
    await act(async () => { pointer(fadeOut, "pointerdown", { button: 0, buttons: 1, clientX: xTail, clientY: 2 }); });
    await act(async () => { pointer(fadeOut, "pointermove", { button: -1, buttons: 1, clientX: xTail - pps(), clientY: 2 }); });
    await act(async () => { pointer(fadeOut, "pointerup", { button: 0, buttons: 0, clientX: xTail - pps(), clientY: 2 }); });
    expect(latest.clips.find((c) => c.id === "c3")!.fadeOutSec).toBeCloseTo(1, 6);

    // Track volume slider applies LIVE on input (drag or arrow keys),
    // not only on release — release-only read as "does nothing".
    const slider = host.querySelector(".prod-tl-track-vol") as HTMLInputElement;
    expect(slider).not.toBeNull();
    const setRange = async (v: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(slider), "value")!.set!.call(slider, v);
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await setRange("25");
    // Applied already — no pointerup has happened yet.
    expect(latest.tracks.find((t) => t.id === "a1")!.volume).toBe(0.25);
    // Zero silences the track (volume 0 is kept, not treated as
    // unset); ending the gesture flushes the final throttled step.
    await setRange("0");
    await act(async () => { pointer(slider, "pointerup", { button: 0, buttons: 0 }); });
    expect(latest.tracks.find((t) => t.id === "a1")!.volume).toBe(0);

    // Pitch: speed the video clip up, then toggle preserved -> shifted.
    await act(async () => {
      pointer(clipEl("c1"), "pointerdown", { button: 0, buttons: 1, clientX: 10 });
      pointer(clipEl("c1"), "pointerup", { button: 0, buttons: 0, clientX: 10 });
    });
    const pitchBtn = () => [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Pitch:")) as HTMLButtonElement;
    expect(pitchBtn().disabled).toBe(true); // 1x: pitch handling is moot
    const select = host.querySelector(".prod-tl-speed") as HTMLSelectElement;
    await act(async () => {
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(pitchBtn().disabled).toBe(false);
    expect(pitchBtn().textContent).toBe("Pitch: preserved");
    await act(async () => { pitchBtn().click(); });
    expect(latest.clips.find((c) => c.id === "c1")!.pitchMode).toBe("natural");
    expect(pitchBtn().textContent).toBe("Pitch: shifted");
    expect(clipEl("c1").textContent).toContain("pitch shift");
  });

  it("dissolve select applies/clamps/removes centered transitions (Item 8)", async () => {
    const tl: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "v1", kind: "video", name: "V1" }],
      clips: [
        { id: "a", trackId: "v1", sourceKind: "video", srcRel: "clips/a.mp4", sourceInSec: 1, sourceOutSec: 5, timelineStartSec: 0 },
        { id: "b", trackId: "v1", sourceKind: "video", srcRel: "clips/b.mp4", sourceInSec: 0.2, sourceOutSec: 4.2, timelineStartSec: 4 },
      ],
    };
    await renderEditor(tl);
    await act(async () => {
      pointer(clipEl("a"), "pointerdown", { button: 0, buttons: 1, clientX: 10 });
      pointer(clipEl("a"), "pointerup", { button: 0, buttons: 0, clientX: 10 });
    });
    const sel = host.querySelector(".prod-tl-dissolve") as HTMLSelectElement;
    expect(sel).not.toBeNull();
    expect(sel.disabled).toBe(false);
    // b's head handle is 0.2s → a 2s pick clamps to 0.4s.
    await act(async () => {
      sel.value = "2";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(latest.transitions).toHaveLength(1);
    expect(latest.transitions![0]).toMatchObject({ outgoingClipId: "a", incomingClipId: "b" });
    expect(latest.transitions![0].durationSec).toBeCloseTo(0.4, 6);
    expect(host.querySelector('[data-dissolve-out="a"]')).not.toBeNull();
    expect(host.querySelector('[data-dissolve-in="b"]')).not.toBeNull();
    // Back to a clean cut: exact original timeline, no duration change.
    const sel2 = host.querySelector(".prod-tl-dissolve") as HTMLSelectElement;
    await act(async () => {
      sel2.value = "0";
      sel2.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(latest).toEqual(tl);
  });

  it("undo walks every edit back to the exact start state", async () => {
    const preset = presetTimeline();
    await renderEditor(preset);
    await seekTo(2);
    await act(async () => { key(editorEl(), "s"); });
    const firstId = latest.clips.find((c) => c.trackId === "v1" && c.timelineStartSec === 0)!.id;
    await act(async () => {
      pointer(clipEl(firstId), "pointerdown", { button: 0, buttons: 1, clientX: 10 });
      pointer(clipEl(firstId), "pointerup", { button: 0, buttons: 0, clientX: 10 });
    });
    await act(async () => { key(editorEl(), "Delete"); });
    expect(commits.length).toBe(2);
    await act(async () => { buttonByLabel("Undo").click(); });
    await act(async () => { buttonByLabel("Undo").click(); });
    expect(latest).toEqual(preset);
    expect(buttonByLabel("Undo").disabled).toBe(true);
    // And redo replays the split.
    await act(async () => { buttonByLabel("Redo").click(); });
    expect(latest.clips.filter((c) => c.trackId === "v1")).toHaveLength(3);
  });

  // ---- Old-animatic replacement: shared playhead + strip parity ---------

  async function renderWith(extra: Record<string, unknown>) {
    const timeline = presetTimeline();
    latest = timeline;
    function Harness() {
      const [prod, setProd] = useState<Production>(() => makeProduction(timeline));
      const [head, setHead] = useState((extra.playheadSec as number) ?? 0);
      return createElement(TimelineEditor, {
        prodId: "prod1",
        production: prod,
        onTimelineChange: (t: ProductionTimeline) => {
          commits.push(t);
          latest = t;
          setProd((p) => ({ ...p, timeline: t }));
        },
        ...extra,
        ...(extra.playheadSec != null
          ? {
              playheadSec: head,
              onSeek: (sec: number) => {
                (extra.onSeek as ((s: number) => void) | undefined)?.(sec);
                setHead(sec);
              },
            }
          : {}),
      });
    }
    await act(async () => {
      root.render(createElement(Harness));
      await new Promise((r) => setTimeout(r, 20));
    });
    if (!editorEl()) throw new Error("timeline editor did not render");
  }

  it("controlled playhead: external position moves the line and seeks flow out", async () => {
    const seeks: number[] = [];
    await renderWith({ playheadSec: 2, onSeek: (s: number) => seeks.push(s) });
    const line = host.querySelector(".prod-tl-playhead") as HTMLElement;
    expect(parseFloat(line.style.left)).toBeCloseTo(2 * pps(), 3);
    expect(host.querySelector(".prod-tl-tc")?.textContent).toContain("0:02:00");
    await seekTo(3);
    expect(seeks.length).toBeGreaterThan(0);
    expect(seeks[seeks.length - 1]).toBeCloseTo(3, 1);
    // The harness fed the seek back in, so the line followed.
    const line2 = host.querySelector(".prod-tl-playhead") as HTMLElement;
    expect(parseFloat(line2.style.left)).toBeCloseTo(3 * pps(), 0);
  });

  it("mute toggle flips the selected clips' muted flag through one commit", async () => {
    await renderWith({});
    await act(async () => {
      pointer(clipEl("c1"), "pointerdown", { button: 0, buttons: 1, clientX: 10 });
      pointer(clipEl("c1"), "pointerup", { button: 0, buttons: 0, clientX: 10 });
    });
    expect(buttonByLabel("Mute clips").disabled).toBe(false);
    await act(async () => { buttonByLabel("Mute clips").click(); });
    expect(latest.clips.find((c) => c.id === "c1")?.muted).toBe(true);
    await act(async () => { buttonByLabel("Unmute clips").click(); });
    expect(latest.clips.find((c) => c.id === "c1")?.muted).toBeFalsy();
  });

  it("Import audio places the picked file as a clip on an audio track at the playhead", async () => {
    await renderWith({
      onImportAudio: async () => ({ rel: "audio/tone.mp3", name: "tone.mp3", durationSec: 6 }),
    });
    await seekTo(12); // past the preset audio clip (ends 9) - free at playhead
    await act(async () => { buttonByLabel("Import audio").click(); });
    const clip = latest.clips.find((c) => c.srcRel === "audio/tone.mp3")!;
    expect(clip).toBeTruthy();
    expect(clip.sourceKind).toBe("audio");
    expect(clip.timelineStartSec).toBe(12);
    expect(clipDurationSec(clip)).toBe(6);
    expect(clip.name).toBe("tone.mp3");
    // No Fit to VO control remains (legacy VO workflow removed).
    expect(buttonByLabel("Fit to VO")).toBeUndefined();
  });

  // ---- UI cleanup Item 1: icon toolbar, grouped ---------------------------

  it("toolbar keeps every action reachable as a named icon, toggle, or value control", async () => {
    await renderEditor(presetTimeline());
    const toolbar = host.querySelector(".prod-tl-toolbar") as HTMLElement;
    expect(toolbar).not.toBeNull();

    // Four job clusters, in order, separated in one toolbar.
    const groups = [...toolbar.querySelectorAll('[role="group"]')];
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "Editing actions", "Speed", "Track and clip adding", "View and fit",
    ]);
    expect(toolbar.querySelectorAll(".prod-tl-sep").length).toBeGreaterThanOrEqual(3);
    const groupOf = (el: Element) => el.closest('[role="group"]')?.getAttribute("aria-label");

    // Every pre-cleanup action button is still present as an icon button
    // whose tooltip names it (with its shortcut where one exists).
    const iconActions: [label: string, titlePart: string, group: string][] = [
      ["Undo", "Undo (Ctrl+Z)", "Editing actions"],
      ["Redo", "Redo (Ctrl+Shift+Z)", "Editing actions"],
      ["Split at playhead", "Split at playhead (S)", "Editing actions"],
      ["Delete selected", "Delete selected (Delete)", "Editing actions"],
      ["Reverse", "Reverse", "Speed"],
      ["Mute clips", "Mute clips", "Speed"],
      ["Add ramp", "Add ramp", "Speed"],
      ["Zoom out", "Zoom out", "View and fit"],
      ["Zoom in", "Zoom in", "View and fit"],
      ["Zoom to fit", "Fit", "View and fit"],
      ["Proxies", "Proxies", "Track and clip adding"],
      ["Add video track", "Add video track", "Track and clip adding"],
      ["Add audio track", "Add audio track", "Track and clip adding"],
      ["Add clip", "Add clip", "Track and clip adding"],
      ["Import audio", "Import audio", "Track and clip adding"],
      ["Fit total", "Fit total", "View and fit"],
    ];
    for (const [label, titlePart, group] of iconActions) {
      const btn = buttonByLabel(label);
      expect(btn, label).toBeTruthy();
      expect(btn.title, label).toContain(titlePart);
      expect(groupOf(btn), label).toBe(group);
      // Icon-only: a glyph renders and no text label competes with it
      // (zoom in/out keep their single-character glyphs).
      const glyph = btn.querySelector("svg");
      if (label !== "Zoom out" && label !== "Zoom in") {
        expect(glyph, label).not.toBeNull();
        expect(btn.textContent?.trim(), label).toBe("");
      }
    }

    // Toggles stay textual with at-a-glance state (active class + pressed).
    const snap = buttonByText("Snap");
    expect(snap.classList.contains("active")).toBe(true); // on by default
    expect(snap.getAttribute("aria-pressed")).toBe("true");
    expect(snap.title).toContain("Snap: on");
    expect(groupOf(snap)).toBe("Editing actions");
    await act(async () => { snap.click(); });
    expect(buttonByText("Snap").classList.contains("active")).toBe(false);
    expect(buttonByText("Snap").title).toContain("Snap: off");
    const ripple = buttonByText("Ripple");
    expect(ripple.classList.contains("active")).toBe(false); // off by default
    expect(ripple.title).toContain("Ripple: off");
    const pitch = [...toolbar.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Pitch:")) as HTMLButtonElement;
    expect(pitch.textContent).toBe("Pitch: preserved");
    expect(pitch.classList.contains("active")).toBe(false); // default state unlit
    expect(groupOf(pitch)).toBe("Speed");

    // Value controls keep their text (the text IS the current selection).
    const speedSel = toolbar.querySelector(".prod-tl-speed") as HTMLSelectElement;
    expect(speedSel.options[0].text).toBe("Speed…");
    expect(groupOf(speedSel)).toBe("Speed");
    const interpSel = toolbar.querySelector(".prod-tl-interp") as HTMLSelectElement;
    expect([...interpSel.options].map((o) => o.text)).toContain("Sample");
    const dissolveSel = toolbar.querySelector(".prod-tl-dissolve") as HTMLSelectElement;
    expect(dissolveSel.options[0].text).toBe("Cut");
    expect(groupOf(dissolveSel)).toBe("Editing actions");
    const scopeSel = toolbar.querySelector(".prod-tl-scope") as HTMLSelectElement;
    expect(scopeSel.options[0].text).toBe("All tracks");
    const shotSel = toolbar.querySelector(".prod-tl-addshot") as HTMLSelectElement;
    expect(shotSel.options[0].text).toBe("Add clip from shot…");
    expect(groupOf(shotSel)).toBe("Track and clip adding");
    // Fit-total seconds input survives in the view/fit cluster.
    const fitInput = toolbar.querySelector(".prod-tl-fit-total") as HTMLInputElement;
    expect(fitInput).not.toBeNull();
    expect(groupOf(fitInput)).toBe("View and fit");
  });

  it("slowing a ramp into a neighbor clamps at the fit boundary instead of refusing (regression)", async () => {
    // Back-to-back edit with 1s of headroom: a hard slow-down drag used
    // to be refused outright (op returns null), so the dot felt dead.
    // Now the keyframe speed clamps so the clip exactly fills the room.
    const tl: ProductionTimeline = {
      version: 1,
      tracks: [{ id: "v1", kind: "video", name: "V1" }],
      clips: [
        { id: "c1", trackId: "v1", sourceKind: "video", srcRel: "clips/one.mp4", sourceInSec: 0, sourceOutSec: 4, timelineStartSec: 0 },
        { id: "c2", trackId: "v1", sourceKind: "video", srcRel: "clips/two.mp4", sourceInSec: 0, sourceOutSec: 4, timelineStartSec: 5 },
      ],
    };
    await renderEditor(tl);
    await act(async () => {
      pointer(clipEl("c1"), "pointerdown", { button: 0, buttons: 1, clientX: 10 });
      pointer(clipEl("c1"), "pointerup", { button: 0, buttons: 0, clientX: 10 });
    });
    await act(async () => { buttonByLabel("Add ramp").click(); });
    expect(latest.clips.find((c) => c.id === "c1")!.speedCurve).toHaveLength(3);
    // Drag the middle dot to the very bottom (slowest).
    const mid = host.querySelectorAll(".prod-tl-ramp-dot")[1] as unknown as HTMLElement;
    await act(async () => { pointer(mid, "pointerdown", { button: 0, buttons: 1, clientX: 2 * pps(), clientY: 28 }); });
    await act(async () => { pointer(mid, "pointermove", { button: -1, buttons: 1, clientX: 2 * pps(), clientY: 55 }); });
    await act(async () => { pointer(mid, "pointerup", { button: 0, buttons: 0, clientX: 2 * pps(), clientY: 55 }); });
    const c1 = latest.clips.find((c) => c.id === "c1")!;
    const end = c1.timelineStartSec + clipDurationSec(c1);
    // Slowed (longer than 4s) but clamped at the neighbor, not refused.
    expect(clipDurationSec(c1)).toBeGreaterThan(4.5);
    expect(end).toBeLessThanOrEqual(5 + 1e-6);
    expect(end).toBeGreaterThan(4.9);
    const midKf = c1.speedCurve![1];
    expect(midKf.speed).toBeLessThan(1);
    expect(midKf.speed).toBeGreaterThan(0.2); // clamped up from the 0.1 floor target
    // No keyframe is ever stranded past the clip's end.
    const lastKf = c1.speedCurve![c1.speedCurve!.length - 1];
    expect(lastKf.atSec).toBeLessThanOrEqual(clipDurationSec(c1) + 1e-9);
  });

  it("the standing hint paragraph moved into the toolbar help tooltip (Item 2)", async () => {
    await renderEditor(presetTimeline());
    // No permanent hint block under the toolbar anymore…
    expect(host.querySelector(".prod-tl-hint")).toBeNull();
    // …and every instruction it carried is on the help marker's tooltip.
    const tip = host.querySelector(".prod-tl-toolbar .cascade-helptip") as HTMLElement;
    expect(tip).not.toBeNull();
    const text = tip.getAttribute("title") ?? "";
    for (const part of [
      "Drag a clip to move it (across tracks too)",
      "Edges trim — Alt+edge rolls the edit point",
      "Right-drag slips",
      "S splits at the playhead",
      "Delete removes",
      "Ctrl+Z undoes",
      "24 fps frame grid",
      "drag the dots (up = faster)",
      "double-click a clip to add a keyframe",
      "Alt+click a dot to delete it",
      "Ramp preview here is approximate; the render is exact",
    ]) {
      expect(text, part).toContain(part);
    }
  });

  it("audio track header stacks the volume slider above the buttons (Item 3)", async () => {
    await renderEditor(presetTimeline());
    const audioHeader = [...host.querySelectorAll(".prod-tl-header")]
      .find((h) => h.querySelector(".prod-tl-track-vol")) as HTMLElement;
    expect(audioHeader).toBeTruthy();
    const vol = audioHeader.querySelector(".prod-tl-track-vol") as HTMLElement;
    const btns = audioHeader.querySelector(".prod-tl-header-btns") as HTMLElement;
    // Slider is NOT inside the button row anymore, and precedes it.
    expect(btns.contains(vol)).toBe(false);
    expect(vol.compareDocumentPosition(btns) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Exactly one slider (no leftover duplicate in the button row).
    expect(audioHeader.querySelectorAll(".prod-tl-track-vol")).toHaveLength(1);
  });

  it("track header panel resizes by dragging its right edge and remembers the width", async () => {
    window.localStorage.removeItem("cascade.timeline.headerW");
    await renderEditor(presetTimeline());
    const headers = host.querySelector(".prod-tl-headers") as HTMLElement;
    expect(headers.style.width).toBe("172px");
    const grip = host.querySelector(".prod-tl-resize") as HTMLElement;
    expect(grip).toBeTruthy();
    await act(async () => { pointer(grip, "pointerdown", { button: 0, buttons: 1, clientX: 172 }); });
    await act(async () => { pointer(grip, "pointermove", { button: -1, buttons: 1, clientX: 252 }); });
    expect(headers.style.width).toBe("252px");
    await act(async () => { pointer(grip, "pointerup", { button: 0, buttons: 0, clientX: 252 }); });
    expect(window.localStorage.getItem("cascade.timeline.headerW")).toBe("252");
    // Clamped at the minimum too.
    await act(async () => { pointer(grip, "pointerdown", { button: 0, buttons: 1, clientX: 252 }); });
    await act(async () => { pointer(grip, "pointermove", { button: -1, buttons: 1, clientX: -400 }); });
    expect(headers.style.width).toBe("120px");
    await act(async () => { pointer(grip, "pointerup", { button: 0, buttons: 0, clientX: -400 }); });
    window.localStorage.setItem("cascade.timeline.headerW", "300");
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await renderEditor(presetTimeline());
    expect((host.querySelector(".prod-tl-headers") as HTMLElement).style.width).toBe("300px");
    window.localStorage.removeItem("cascade.timeline.headerW");
  });

  // ---- Animatic batch Item 3: mm:ss length field -------------------------

  it("length field shows mm:ss, Enter sets length (extend/clamp), invalid reverts", async () => {
    await renderEditor(presetTimeline()); // last clip ends at 9s
    const field = host.querySelector('[aria-label="Timeline length"]') as HTMLInputElement;
    expect(field).toBeTruthy();
    expect(field.value).toBe("00:09");

    const typeEnter = async (v: string) => {
      await act(async () => { field.focus(); });
      await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, v);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => { key(field, "Enter"); });
    };

    // Longer: pads to exactly 1:00, clips untouched, field follows.
    await typeEnter("01:00");
    expect(latest.durationSec).toBe(60);
    expect(latest.clips).toEqual(presetTimeline().clips);
    expect(field.value).toBe("01:00");

    // Shorter than the last clip end: clamps to 00:09, nothing lost.
    await typeEnter("00:04");
    expect(latest.durationSec).toBeUndefined();
    expect(latest.clips).toEqual(presetTimeline().clips);
    expect(field.value).toBe("00:09");

    // Invalid: reverts, no commit change.
    const before = latest;
    await typeEnter("abc");
    expect(latest).toBe(before);
    expect(field.value).toBe("00:09");
  });

  // ---- Animatic batch Item 4: loop region -------------------------------

  it("I/O mark loop points on the ruler; Loop toggles; Alt+I/Alt+O clear", async () => {
    await renderEditor(presetTimeline());
    const loopBtn = () => buttonByText("Loop");
    expect(loopBtn()).toBeTruthy();
    expect(loopBtn().getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector(".prod-tl-loop-region")).toBeNull();

    await seekTo(2);
    await act(async () => { key(editorEl(), "i"); });
    // Only In set: marker shows, no region yet.
    expect(host.querySelectorAll(".prod-tl-loop-pt")).toHaveLength(1);
    expect(host.querySelector(".prod-tl-loop-region")).toBeNull();

    await seekTo(5);
    await act(async () => { key(editorEl(), "o"); });
    const region = host.querySelector(".prod-tl-loop-region") as HTMLElement;
    expect(region).toBeTruthy();
    expect(parseFloat(region.style.left)).toBeCloseTo(2 * pps(), 1);
    expect(parseFloat(region.style.width)).toBeCloseTo(3 * pps(), 1);
    expect(host.querySelectorAll(".prod-tl-loop-pt")).toHaveLength(2);

    await act(async () => { loopBtn().click(); });
    expect(loopBtn().getAttribute("aria-pressed")).toBe("true");
    expect(loopBtn().classList.contains("active")).toBe(true);
    expect(loopBtn().title).toContain("Loop: on");

    // Alt+I clears In -> region gone, Out marker remains.
    await act(async () => { key(editorEl(), "i", { altKey: true }); });
    expect(host.querySelector(".prod-tl-loop-region")).toBeNull();
    expect(host.querySelectorAll(".prod-tl-loop-pt")).toHaveLength(1);
    await act(async () => { key(editorEl(), "o", { altKey: true }); });
    expect(host.querySelectorAll(".prod-tl-loop-pt")).toHaveLength(0);
  });

  // ---- Animatic batch Item 5: playhead drag stays a scrub ----------------

  it("dragging from the ruler down across clips stays a scrub (no marquee, selection kept)", async () => {
    await renderEditor(presetTimeline());
    const lanes = host.querySelector(".prod-tl-lanes") as HTMLElement;
    // Pre-select c2 by clicking it.
    await act(async () => {
      pointer(clipEl("c2"), "pointerdown", { button: 0, buttons: 1, clientX: 7 * pps() });
      pointer(clipEl("c2"), "pointerup", { button: 0, buttons: 0, clientX: 7 * pps() });
    });
    expect(host.querySelectorAll(".prod-tl-clip.selected")).toHaveLength(1);

    // Grab in the ruler strip (y < 18), drag down over the tracks to 7s.
    await act(async () => { pointer(lanes, "pointerdown", { button: 0, buttons: 1, clientX: 1 * pps(), clientY: 6 }); });
    await act(async () => { pointer(lanes, "pointermove", { button: -1, buttons: 1, clientX: 4 * pps(), clientY: 90 }); });
    expect(host.querySelector(".prod-tl-marquee")).toBeNull();
    await act(async () => { pointer(lanes, "pointermove", { button: -1, buttons: 1, clientX: 7 * pps(), clientY: 140 }); });
    await act(async () => { pointer(lanes, "pointerup", { button: 0, buttons: 0, clientX: 7 * pps(), clientY: 140 }); });
    expect(host.querySelector(".prod-tl-marquee")).toBeNull();
    // Playhead landed at the release x; the c2 selection survived.
    const line = host.querySelector(".prod-tl-playhead") as HTMLElement;
    expect(parseFloat(line.style.left)).toBeCloseTo(7 * pps(), 1);
    expect([...host.querySelectorAll(".prod-tl-clip.selected")].map((el) => el.getAttribute("data-clip-id"))).toEqual(["c2"]);
  });

  it("box select still starts from empty track area", async () => {
    await renderEditor(presetTimeline());
    const lanes = host.querySelector(".prod-tl-lanes") as HTMLElement;
    // Press below the ruler in empty lane space (clear of the
    // playhead line at 0), drag across both lanes.
    await act(async () => { pointer(lanes, "pointerdown", { button: 0, buttons: 1, clientX: Math.round(0.5 * pps()), clientY: 40 }); });
    await act(async () => { pointer(lanes, "pointermove", { button: -1, buttons: 1, clientX: 8 * pps(), clientY: 120 }); });
    expect(host.querySelector(".prod-tl-marquee")).toBeTruthy();
    await act(async () => { pointer(lanes, "pointerup", { button: 0, buttons: 0, clientX: 8 * pps(), clientY: 120 }); });
    const sel = [...host.querySelectorAll(".prod-tl-clip.selected")].map((el) => el.getAttribute("data-clip-id")).sort();
    expect(sel).toEqual(["c1", "c2", "c3"]);
  });
});
