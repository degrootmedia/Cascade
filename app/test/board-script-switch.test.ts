/**
 * Board-card Audio/Visual script boxes: the same direct-switch regression as
 * the Step 1 shot table (see shot-table.test.ts "direct Visual -> Audio").
 * Edit one box, click DIRECTLY into the other, edit there — the box being
 * left must commit on the switch and neither edit may be wiped by the
 * focus gap or overwritten by the other's commit. The first commit's
 * snapshot is applied mid-sequence, the way ProductionWorkspace applies the
 * async IPC result while the second box is being edited.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Production, ProductionShot } from "../src/shared/ipc.js";
import { BoardCard } from "../src/renderer/src/components/production/boards.js";
import { resetBoardThumbSchedulerForTests } from "../src/renderer/src/components/production/board-thumbs.js";

type BoardCardProps = Parameters<typeof BoardCard>[0];

function makeShot(audio: string, visual: string): ProductionShot {
  return { id: "shot1", number: "0100", audio, visual };
}

function makeProduction(shot: ProductionShot): Production {
  return {
    meta: {
      id: "prod1", name: "Script switch", folder: "C:/test", stepDone: 3, shotCount: 1,
      createdAt: "2026-09-27T00:00:00Z", updatedAt: "2026-09-27T00:00:00Z",
    },
    currentStep: 3, visualStyle: "", styles: [], characters: [], products: [], references: [], status: {},
    scenes: [{ number: 1, title: "Scene 1", shots: [shot] }],
    assets: {
      scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music",
      videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models",
    },
  };
}

describe("BoardCard script direct switch", () => {
  let host: HTMLDivElement;
  let root: Root;
  let restoreCascade: () => void;
  let prevRaf: unknown;
  let prevObserver: unknown;
  const boardThumbnail = vi.fn(async () => null);
  const boardImageFull = vi.fn(async () => null);
  let textChanges: unknown[][];

  const propsFor = (shot: ProductionShot): BoardCardProps => ({
    prod: makeProduction(shot), shot, bust: 0, regenerating: false, videoBusy: false,
    onRegenerate: vi.fn(), onImport: vi.fn(), onEdit: vi.fn(), onVideo: vi.fn(),
    onTextChange: (...args: unknown[]) => { textChanges.push(args); },
    showScript: true, selected: false,
    onDropFrame: vi.fn(), onPromoteHistory: vi.fn(), onPromptFocus: vi.fn(),
    zoomOpen: false, onZoomChange: vi.fn(), onZoomNavigate: vi.fn(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    textChanges = [];
    resetBoardThumbSchedulerForTests();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    prevRaf = (globalThis as Record<string, unknown>).requestAnimationFrame;
    (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: () => void) => {
      cb();
      return 0;
    };
    prevObserver = (globalThis as Record<string, unknown>).IntersectionObserver;
    (globalThis as Record<string, unknown>).IntersectionObserver = class {
      constructor(private cb: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe() { this.cb([{ isIntersecting: true }]); }
      unobserve() {}
      disconnect() {}
    };
    vi.stubGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
    const previous = Object.getOwnPropertyDescriptor(window, "cascade");
    Object.defineProperty(window, "cascade", {
      configurable: true, value: { boardThumbnail, boardImageFull },
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
    (globalThis as Record<string, unknown>).requestAnimationFrame = prevRaf;
    (globalThis as Record<string, unknown>).IntersectionObserver = prevObserver;
    vi.unstubAllGlobals();
  });

  async function renderShot(audio: string, visual: string) {
    await act(async () => {
      root.render(createElement(BoardCard, propsFor(makeShot(audio, visual))));
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  const audioBox = () => host.querySelector<HTMLTextAreaElement>(".prod-board-script-input.audio")!;
  const visualBox = () => host.querySelector<HTMLTextAreaElement>(".prod-board-script-input.visual")!;

  function typeInto(el: HTMLTextAreaElement, text: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    act(() => {
      setter!.call(el, text);
      el.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  }

  // One click in the browser dispatches focusout and focusin as separate
  // events and React flushes between them — separate acts model that.
  function switchDirectly(from: HTMLTextAreaElement, to: HTMLTextAreaElement) {
    act(() => { from.blur(); });
    act(() => { to.focus(); });
  }

  it("Visual -> Audio: commits Visual on the switch and keeps both edits", async () => {
    await renderShot("a-old", "v-old");
    const visual = visualBox();
    act(() => { visual.focus(); });
    typeInto(visual, "v-new");
    switchDirectly(visual, audioBox());
    expect(textChanges).toEqual([["shot1", { audio: "a-old", visual: "v-new" }]]);
    expect(visualBox().value).toBe("v-new");
    typeInto(audioBox(), "a-new");
    await renderShot("a-old", "v-new"); // first commit's snapshot lands
    expect(audioBox().value).toBe("a-new");
    expect(visualBox().value).toBe("v-new");
    act(() => { audioBox().blur(); });
    expect(textChanges).toEqual([
      ["shot1", { audio: "a-old", visual: "v-new" }],
      ["shot1", { audio: "a-new", visual: "v-new" }],
    ]);
  });

  it("Audio -> Visual: commits Audio on the switch and keeps both edits", async () => {
    await renderShot("a-old", "v-old");
    const audio = audioBox();
    act(() => { audio.focus(); });
    typeInto(audio, "a-new");
    switchDirectly(audio, visualBox());
    expect(textChanges).toEqual([["shot1", { audio: "a-new", visual: "v-old" }]]);
    expect(audioBox().value).toBe("a-new");
    typeInto(visualBox(), "v-new");
    await renderShot("a-new", "v-old"); // first commit's snapshot lands
    expect(visualBox().value).toBe("v-new");
    expect(audioBox().value).toBe("a-new");
    act(() => { visualBox().blur(); });
    expect(textChanges).toEqual([
      ["shot1", { audio: "a-new", visual: "v-old" }],
      ["shot1", { audio: "a-new", visual: "v-new" }],
    ]);
  });
});
