import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Production, ProductionShot } from "../src/shared/ipc.js";
import { BoardCard } from "../src/renderer/src/components/production/boards.js";
import { resetBoardThumbSchedulerForTests } from "../src/renderer/src/components/production/board-thumbs.js";

type BoardCardProps = Parameters<typeof BoardCard>[0];

/** Mirrors ProductionWorkspace: the workspace owns which shot's frame is
 *  enlarged so the lightbox can move between cards. */
function ControlledBoard(props: BoardCardProps) {
  const [zoomId, setZoomId] = useState<string | null>(null);
  return createElement(BoardCard, {
    ...props,
    zoomOpen: zoomId === props.shot.id,
    onZoomChange: setZoomId,
    onZoomNavigate: () => {},
  });
}

/** A multi-shot storyboard strip with the workspace's ← / → stepping. */
function BoardStrip({ shots }:{ shots: ProductionShot[] }) {
  const [zoomId, setZoomId] = useState<string | null>(null);
  const navigate = (id: string, dir: -1 | 1) => {
    const i = shots.findIndex((s) => s.id === id);
    for (let j = i + dir; j >= 0 && j < shots.length; j += dir) {
      const s = shots[j];
      if (s.artwork || s.videoPath) { setZoomId(s.id); return; }
    }
  };
  return createElement(
    "div",
    null,
    shots.map((shot) => createElement(BoardCard, {
      key: shot.id,
      prod: makeProduction(shot), shot, bust: 0, regenerating: false, videoBusy: false,
      onRegenerate: vi.fn(), onImport: vi.fn(), onEdit: vi.fn(), onVideo: vi.fn(),
      onTextChange: vi.fn(), showScript: false, selected: false,
      onDropFrame: vi.fn(), onPromoteHistory: vi.fn(), onPromptFocus: vi.fn(),
      zoomOpen: zoomId === shot.id,
      onZoomChange: setZoomId,
      onZoomNavigate: navigate,
    })),
  );
}

const PRIMARY = "boards/0100/current.jpg";
const EDIT = "boards/0100/edits/never primary #2.jpg";
const GENERATED = "boards/0100/images/regular gen %1.jpg";
const LEGACY = "boards/0100/legacy.jpg";
const NEW_EDIT = "boards/0100/edits/newest.jpg";
const VIDEO = "videos/0100/clip one.mp4";
const thumbnail = (path: string) => `data:image/png;base64,${btoa(`thumbnail:${path}`)}`;
const fullImage = (path: string) => `data:image/png;base64,${btoa(`full:${path}`)}`;

function makeShot(overrides: Partial<ProductionShot> = {}): ProductionShot {
  return {
    id: "shot1", number: "0100", audio: "", visual: "A hero walks.",
    artwork: PRIMARY, graphOutputSource: "imagegen", graphImageGenIndex: 0,
    graphImageGens: [
      { path: PRIMARY, prompt: "Current", model: "auto", at: "2026-09-07T11:00:00Z" },
      { path: GENERATED, prompt: "Regular generation", model: "auto", at: "2026-09-07T10:00:00Z" },
    ],
    graphEditGens: [
      { path: EDIT, prompt: "Never primary edit", model: "auto", at: "2026-09-07T12:00:00Z" },
    ],
    artworkHistory: [],
    ...overrides,
  };
}

function makeProduction(shot: ProductionShot): Production {
  return {
    meta: {
      id: "prod1", name: "Board history", folder: "C:/test", stepDone: 3, shotCount: 1,
      createdAt: "2026-09-07T00:00:00Z", updatedAt: "2026-09-07T00:00:00Z",
    },
    currentStep: 3, visualStyle: "", styles: [], characters: [], products: [], references: [], status: {},
    scenes: [{ number: 1, title: "Scene 1", shots: [shot] }],
    assets: {
      scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music",
      videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models",
    },
  };
}

describe("BoardCard history", () => {
  let host: HTMLDivElement;
  let root: Root;
  let currentPath: string;
  let restoreCascade: () => void;
  // Thumbnails are scheduler-gated in production (first paint + viewport +
  // queue) — the harness simulates an already-painted, visible card so tests
  // observe the loaded state without real timers.
  let prevRaf: unknown;
  let prevObserver: unknown;
  const getBoardPrompt = vi.fn(async () => "A hero walks.");
  // Per-shot artwork so a strip of several cards resolves each shot's own full
  // frame (the workspace passes the shot id, not a path, to boardImageFull).
  const shotArtwork: Record<string, string> = {};
  const boardThumbnail = vi.fn(async (_prodId: string, shotId: string, path?: string): Promise<string | null> => thumbnail(path ?? shotArtwork[shotId] ?? currentPath));
  const boardImageFull = vi.fn(async (_prodId: string, shotId: string, path?: string) => fullImage(path ?? shotArtwork[shotId] ?? currentPath));
  const onPromoteHistory = vi.fn();
  const onPromptFocus = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(shotArtwork)) delete shotArtwork[k];
    resetBoardThumbSchedulerForTests();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // setup-dom stubs rAF as a never-firing no-op — fire callbacks
    // synchronously so the thumbnail scheduler's first-paint gate resolves
    // in microtasks (which act drains), not macrotasks (which escape act).
    prevRaf = (globalThis as Record<string, unknown>).requestAnimationFrame;
    (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: () => void) => {
      cb();
      return 0;
    };
    // jsdom has no IntersectionObserver — report every card as visible.
    prevObserver = (globalThis as Record<string, unknown>).IntersectionObserver;
    (globalThis as Record<string, unknown>).IntersectionObserver = class {
      constructor(private cb: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe() { this.cb([{ isIntersecting: true }]); }
      unobserve() {}
      disconnect() {}
    };
    // setup-dom supplies the DOM; BoardCard's prompt effect also needs this constructor.
    vi.stubGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
    const previous = Object.getOwnPropertyDescriptor(window, "cascade");
    Object.defineProperty(window, "cascade", {
      configurable: true, value: { getBoardPrompt, boardThumbnail, boardImageFull },
    });
    restoreCascade = () => {
      if (previous) Object.defineProperty(window, "cascade", previous);
      else Reflect.deleteProperty(window, "cascade");
    };
    currentPath = PRIMARY;
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

  async function render(shot: ProductionShot) {
    currentPath = shot.artwork ?? "";
    shotArtwork[shot.id] = shot.artwork ?? "";
    await act(async () => {
      root.render(createElement(ControlledBoard, {
        prod: makeProduction(shot), shot, bust: 0, regenerating: false, videoBusy: false,
        onRegenerate: vi.fn(), onImport: vi.fn(), onEdit: vi.fn(), onVideo: vi.fn(),
        onTextChange: vi.fn(), showScript: false, selected: false,
        onDropFrame: vi.fn(), onPromoteHistory, onPromptFocus,
      }));
      // Flush the scheduler chain (paint gate → queue → mocked IPC → setState).
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  function button(selector: string): HTMLButtonElement {
    const element = host.querySelector<HTMLButtonElement>(selector);
    expect(element, selector).not.toBeNull();
    return element!;
  }

  async function click(selector: string) {
    const element = button(selector);
    expect(element.disabled).toBe(false);
    await act(async () => { element.click(); });
  }

  function expectFrame(path: string) {
    expect(host.querySelector(".prod-board-frame-img")?.getAttribute("src")).toBe(thumbnail(path));
    expect(host.querySelector(".prod-board-frame-video")).toBeNull();
  }

  it("browses never-primary edits and regular generations, loading and promoting exact paths", async () => {
    await render(makeShot());
    expectFrame(PRIMARY);
    // Prompts load on demand via the parent's focused-shot fetch — mounting a
    // card must not fire its own prompt IPC.
    expect(getBoardPrompt).not.toHaveBeenCalled();
    expect(boardThumbnail.mock.calls).toEqual([["prod1", "shot1"]]);
    expect(button(".prod-board-hist.prev").title).toBe("Previous frame (2 in history)");
    expect(host.querySelector(".prod-board-promote")).toBeNull();

    await click(".prod-board-hist.prev");
    expectFrame(EDIT);
    expect(boardThumbnail).toHaveBeenLastCalledWith("prod1", "shot1", EDIT);
    expect(button(".prod-board-promote").textContent?.trim()).toBe("Make Primary");
    expect(host.querySelector(".prod-board-hist-tag")).toBeNull();
    await click(".prod-board-promote");
    expect(onPromoteHistory).toHaveBeenLastCalledWith("shot1", EDIT);

    await click(".prod-board-hist.prev");
    expectFrame(GENERATED);
    expect(boardThumbnail).toHaveBeenLastCalledWith("prod1", "shot1", GENERATED);
    expect(button(".prod-board-hist.prev").disabled).toBe(true);
    expect(button(".prod-board-hist.prev").title).toBe("Start of history");
    await click(".prod-board-promote");
    expect(onPromoteHistory.mock.calls).toEqual([["shot1", EDIT], ["shot1", GENERATED]]);

    await click(".prod-board-hist.next");
    expectFrame(EDIT);
    expect(button(".prod-board-hist.next").title).toBe("Back to current frame");
    await click(".prod-board-hist.next");
    expectFrame(PRIMARY);
    expect(host.querySelector(".prod-board-promote")).toBeNull();
    expect(boardThumbnail.mock.calls).toEqual([
      ["prod1", "shot1"], ["prod1", "shot1", EDIT], ["prod1", "shot1", GENERATED],
    ]);
    expect(onPromptFocus).not.toHaveBeenCalled();
  });

  it("deduplicates legacy and node histories and excludes the current still", async () => {
    const shot = makeShot();
    shot.graphEditGens!.push({ path: GENERATED, prompt: "Duplicate", model: "auto", at: "2026-09-07T09:00:00Z" });
    shot.artworkHistory = [GENERATED, EDIT, PRIMARY, LEGACY, LEGACY];
    await render(shot);
    expect(button(".prod-board-hist.prev").title).toBe("Previous frame (3 in history)");

    for (const path of [EDIT, GENERATED, LEGACY]) {
      await click(".prod-board-hist.prev");
      expectFrame(path);
      expect(boardThumbnail).toHaveBeenLastCalledWith("prod1", "shot1", path);
      await click(".prod-board-promote");
    }
    expect(button(".prod-board-hist.prev").disabled).toBe(true);
    expect(onPromoteHistory.mock.calls).toEqual([["shot1", EDIT], ["shot1", GENERATED], ["shot1", LEGACY]]);
    expect(boardThumbnail).toHaveBeenCalledTimes(4);
  });

  it.each(["loaded", "pending"])("keeps the browsed path when history is inserted with its thumbnail %s", async (state) => {
    const shot = makeShot();
    await render(shot);
    let resolveThumbnail!: (value: string) => void;
    if (state === "pending") {
      boardThumbnail.mockImplementationOnce(() => new Promise((resolve) => { resolveThumbnail = resolve; }));
    }
    await click(".prod-board-hist.prev");
    expect(boardThumbnail).toHaveBeenLastCalledWith("prod1", "shot1", EDIT);
    if (state === "pending") {
      expect(host.querySelector(".prod-board-promote")).toBeNull();
      expect(button(".prod-board-zoom").disabled).toBe(true);
    } else {
      expectFrame(EDIT);
    }

    await render({
      ...shot,
      graphEditGens: [{ path: NEW_EDIT, prompt: "New edit", model: "auto", at: "2026-09-07T13:00:00Z" }, ...shot.graphEditGens!],
    });
    if (state === "pending") {
      await act(async () => { resolveThumbnail(thumbnail(EDIT)); });
    }
    expectFrame(EDIT);
    expect(button(".prod-board-hist.next").title).toBe("Newer frame");
    expect(boardThumbnail.mock.calls).toEqual([["prod1", "shot1"], ["prod1", "shot1", EDIT]]);
    await click(".prod-board-promote");
    expect(onPromoteHistory.mock.calls).toEqual([["shot1", EDIT]]);

    await click(".prod-board-hist.next");
    expectFrame(NEW_EDIT);
    expect(boardThumbnail).toHaveBeenLastCalledWith("prod1", "shot1", NEW_EDIT);
    await click(".prod-board-hist.prev");
    expectFrame(EDIT);
    expect(boardThumbnail).toHaveBeenCalledTimes(3);
  });

  it("zooms the browsed still rather than the shot's video, then restores video zoom at current", async () => {
    await render(makeShot({ videoPath: VIDEO, graphOutputSource: "videogen" }));
    const videoSrc = `cascade-media://prod1/${encodeURIComponent(VIDEO)}`;
    expect(host.querySelector(".prod-board-frame-video")?.getAttribute("src")).toBe(videoSrc);
    expect(button(".prod-board-zoom").title).toBe("Play this shot's video");
    await click(".prod-board-zoom");
    expect(host.querySelector(".prod-ref-lightbox-video")?.getAttribute("src")).toBe(videoSrc);
    expect(boardImageFull).not.toHaveBeenCalled();
    await act(async () => { host.querySelector<HTMLElement>(".prod-ref-lightbox")!.click(); });

    await click(".prod-board-hist.prev");
    expectFrame(EDIT);
    expect(button(".prod-board-zoom").title).toBe("Enlarge this frame");
    await click(".prod-board-zoom");
    expect(boardImageFull.mock.calls).toEqual([["prod1", "shot1", EDIT]]);
    expect(host.querySelector(".prod-ref-lightbox img")?.getAttribute("src")).toBe(fullImage(EDIT));
    expect(host.querySelector(".prod-ref-lightbox video")).toBeNull();
    await act(async () => { host.querySelector<HTMLElement>(".prod-ref-lightbox")!.click(); });

    await click(".prod-board-hist.next");
    expect(button(".prod-board-zoom").title).toBe("Play this shot's video");
    await click(".prod-board-zoom");
    expect(host.querySelector(".prod-ref-lightbox-video")?.getAttribute("src")).toBe(videoSrc);
    expect(host.querySelector(".prod-ref-lightbox img")).toBeNull();
    expect(boardImageFull).toHaveBeenCalledTimes(1);
    expect(onPromptFocus).not.toHaveBeenCalled();
  });

  it.each(["editgen", "imagegen"] as const)("returns to current after an %s primary prop update without remounting", async (source) => {
    const shot = makeShot();
    await render(shot);
    await click(".prod-board-hist.prev");
    expectFrame(EDIT);
    await click(".prod-board-promote");
    expect(onPromoteHistory.mock.calls).toEqual([["shot1", EDIT]]);

    // Also cover an external primary change where the browsed edit stays in history.
    const newPrimary = source === "editgen" ? EDIT : GENERATED;
    await render({
      ...shot, artwork: newPrimary, graphOutputSource: source,
      graphImageGenIndex: source === "imagegen" ? 1 : 0, graphEditGenIndex: 0,
      artworkHistory: [PRIMARY],
    });
    expectFrame(newPrimary);
    expect(boardThumbnail).toHaveBeenLastCalledWith("prod1", "shot1");
    expect(host.querySelector(".prod-board-promote")).toBeNull();
    expect(host.querySelector(".prod-board-hist.next")).toBeNull();
    expect(button(".prod-board-hist.prev").title).toBe("Previous frame (2 in history)");
    await click(".prod-board-zoom");
    expect(boardImageFull.mock.calls).toEqual([["prod1", "shot1", undefined]]);
    expect(host.querySelector(".prod-ref-lightbox img")?.getAttribute("src")).toBe(fullImage(newPrimary));
  });

  it("steps the enlarged frame between shots with the arrow keys, skipping blanks", async () => {
    const firstArt = "boards/0100/a.jpg";
    const secondArt = "boards/0110/b.jpg";
    const first = makeShot({ id: "shot1", number: "0100", artwork: firstArt, videoPath: undefined });
    const blank = makeShot({ id: "blank", number: "0105", artwork: undefined, videoPath: undefined, graphImageGens: [], graphEditGens: [], graphOutputSource: undefined });
    const second = makeShot({ id: "shot2", number: "0110", artwork: secondArt, videoPath: undefined });
    shotArtwork[first.id] = firstArt;
    shotArtwork[second.id] = secondArt;
    await act(async () => {
      root.render(createElement(BoardStrip, { shots: [first, blank, second] }));
      await new Promise((r) => setTimeout(r, 20));
    });
    const zooms = host.querySelectorAll<HTMLButtonElement>(".prod-board-zoom");
    expect(zooms.length).toBe(3);
    expect(zooms[1].disabled).toBe(true);
    expect(zooms[0].disabled).toBe(false);
    await act(async () => { zooms[0].click(); });
    expect(host.querySelector(".prod-ref-lightbox img")?.getAttribute("src")).toBe(fullImage(firstArt));

    // The blank panel in between is skipped — the lightbox lands on shot2.
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    expect(host.querySelector(".prod-ref-lightbox img")?.getAttribute("src")).toBe(fullImage(secondArt));
    expect(boardImageFull).toHaveBeenLastCalledWith("prod1", "shot2", undefined);

    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft" }));
    });
    expect(host.querySelector(".prod-ref-lightbox img")?.getAttribute("src")).toBe(fullImage(firstArt));

    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(host.querySelector(".prod-ref-lightbox")).toBeNull();
  });
});
