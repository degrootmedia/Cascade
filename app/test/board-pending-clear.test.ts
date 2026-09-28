import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Production, ProductionShot } from "../src/shared/ipc.js";
import { BoardCard } from "../src/renderer/src/components/production/boards.js";
import { resetBoardThumbSchedulerForTests } from "../src/renderer/src/components/production/board-thumbs.js";

type BoardCardProps = Parameters<typeof BoardCard>[0];

const PENDING = { historyId: "h-stuck", prompt: "Draw a castle", model: "m", at: "2026-09-27T00:00:00Z" };

function makeShot(): ProductionShot {
  return {
    id: "shot1", number: "0100", audio: "", visual: "A hero walks.",
    pendingImageGen: { ...PENDING },
  };
}

function makeProduction(shot: ProductionShot): Production {
  return {
    meta: {
      id: "prod1", name: "Pending clear", folder: "C:/test", stepDone: 3, shotCount: 1,
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

describe("BoardCard pending clear", () => {
  let host: HTMLDivElement;
  let root: Root;
  let restoreCascade: () => void;
  let prevRaf: unknown;
  let prevObserver: unknown;
  let prevConfirm: unknown;
  let confirmFn: () => boolean;
  const boardThumbnail = vi.fn(async () => null);
  const boardImageFull = vi.fn(async () => null);

  const baseProps = (shot: ProductionShot, extra: Partial<BoardCardProps> = {}): BoardCardProps => ({
    prod: makeProduction(shot), shot, bust: 0, regenerating: false, videoBusy: false,
    pending: !!shot.pendingImageGen, videoPending: false,
    onRegenerate: vi.fn(), onImport: vi.fn(), onEdit: vi.fn(), onVideo: vi.fn(),
    onTextChange: vi.fn(), showScript: false, selected: false,
    onDropFrame: vi.fn(), onPromoteHistory: vi.fn(), onPromptFocus: vi.fn(),
    onDelete: vi.fn(),
    zoomOpen: null as never, onZoomChange: vi.fn(), onZoomNavigate: vi.fn(),
    ...extra,
  });

  beforeEach(() => {
    vi.clearAllMocks();
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
    confirmFn = () => true;
    prevConfirm = Object.getOwnPropertyDescriptor(window, "confirm");
    Object.defineProperty(window, "confirm", {
      configurable: true, value: (...args: unknown[]) => confirmFn(...(args as [])),
    });
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
    if (prevConfirm) Object.defineProperty(window, "confirm", prevConfirm);
    else Reflect.deleteProperty(window, "confirm");
    vi.unstubAllGlobals();
  });

  async function renderCard(props: BoardCardProps) {
    await act(async () => {
      root.render(createElement(BoardCard, props));
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  function openMenu() {
    const figure = host.querySelector("figure.prod-board");
    expect(figure, "board figure").not.toBeNull();
    act(() => {
      figure!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
  }

  function menuItem(label: string): HTMLButtonElement | null {
    for (const el of host.querySelectorAll<HTMLButtonElement>(".session-context-menu .ctx-item")) {
      if (el.textContent?.trim() === label) return el;
    }
    return null;
  }

  it("shows the pending badge and fetch icon only while the shot is pending", async () => {
    const shot = makeShot();
    await renderCard(baseProps(shot, { pending: true }));
    expect(host.querySelector(".prod-board-pending")?.textContent?.trim()).toBe("pending");
    expect(host.querySelector("button.prod-board-recheck")).not.toBeNull();

    // Clearing the pending record (what production:clearPending persists)
    // removes BOTH the badge and the fetch icon — they share the one flag.
    await renderCard(baseProps({ ...shot, pendingImageGen: undefined }, { pending: false }));
    expect(host.querySelector(".prod-board-pending")).toBeNull();
    expect(host.querySelector("button.prod-board-recheck")).toBeNull();
  });

  it("right-click offers Clear pending frame and calls back with (shotId, image) on confirm", async () => {
    const onClearPending = vi.fn();
    await renderCard(baseProps(makeShot(), { pending: true, onClearPending }));
    openMenu();
    const item = menuItem("Clear pending frame…");
    expect(item, "Clear pending frame menu item").not.toBeNull();
    await act(async () => { item!.click(); });
    expect(onClearPending).toHaveBeenCalledWith("shot1", "image");
  });

  it("cancelling the confirm leaves the pending job alone", async () => {
    confirmFn = () => false;
    const onClearPending = vi.fn();
    await renderCard(baseProps(makeShot(), { pending: true, onClearPending }));
    openMenu();
    const item = menuItem("Clear pending frame…");
    expect(item, "Clear pending frame menu item").not.toBeNull();
    await act(async () => { item!.click(); });
    expect(onClearPending).not.toHaveBeenCalled();
  });

  it("a pending video offers Clear pending video with the video kind", async () => {
    const onClearPending = vi.fn();
    await renderCard(baseProps(makeShot(), { pending: false, videoPending: true, onClearPending }));
    expect(host.querySelector(".prod-board-pending-video")).not.toBeNull();
    openMenu();
    expect(menuItem("Clear pending frame…")).toBeNull();
    const item = menuItem("Clear pending video…");
    expect(item, "Clear pending video menu item").not.toBeNull();
    await act(async () => { item!.click(); });
    expect(onClearPending).toHaveBeenCalledWith("shot1", "video");
  });

  it("offers no clear items when nothing is pending", async () => {
    const shot = { ...makeShot(), pendingImageGen: undefined };
    await renderCard(baseProps(shot, { pending: false, videoPending: false, onClearPending: vi.fn() }));
    openMenu();
    expect(menuItem("Clear pending frame…")).toBeNull();
    expect(menuItem("Clear pending video…")).toBeNull();
    // The menu itself still opens (Delete shot… is always there).
    expect(menuItem("Delete shot…")).not.toBeNull();
  });
});
