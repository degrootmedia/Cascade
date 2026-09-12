/**
 * Storyboard video loading — board cards fetch only the container header
 * (`preload="metadata"`) at mount so hover preview starts instantly, while
 * the film-strip badge keeps marking clips exactly as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { BoardCard } from "../src/renderer/src/components/production/boards.js";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root | null = null;

const noop = () => {};

function makeProd(): Production {
  return {
    meta: { id: "p1", name: "T", folder: "", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 1 },
    currentStep: 3,
    scenes: [],
  } as unknown as Production;
}

function makeShot(overrides: Partial<ProductionShot> = {}): ProductionShot {
  return {
    id: "shot-1",
    number: "0100",
    audio: "",
    visual: "",
    ...overrides,
  };
}

function renderCard(shot: ProductionShot) {
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(BoardCard, {
        prod: makeProd(),
        shot,
        bust: 0,
        regenerating: false,
        videoBusy: false,
        onRegenerate: noop,
        onImport: noop,
        onEdit: noop,
        onVideo: noop,
        onTextChange: noop,
        showScript: false,
        onPromptFocus: noop,
        selected: false,
        onDropFrame: noop,
        onPromoteHistory: noop,
      }),
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
});

describe("BoardCard video loading", () => {
  it("renders the clip with preload=metadata for instant hover preview", () => {
    renderCard(makeShot({ videoPath: "videos/0100/shot-0100-a.mp4" }));
    const video = container.querySelector("video.prod-board-frame-video");
    expect(video).not.toBeNull();
    expect(video!.getAttribute("preload")).toBe("metadata");
  });

  it("keeps the film-strip badge above the video layer", () => {
    renderCard(makeShot({ videoPath: "videos/0100/shot-0100-a.mp4" }));
    const badge = container.querySelector(".prod-board-video-badge");
    expect(badge).not.toBeNull();
  });

  it("still renders the empty fallback for a board with no media", () => {
    renderCard(makeShot({}));
    expect(container.querySelector("video.prod-board-frame-video")).toBeNull();
    const empty = container.querySelector(".prod-board-empty");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toBe("no frame");
  });
});
