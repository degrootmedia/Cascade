/**
 * Storyboard Nodes shortcut — each board card carries a Nodes button
 * immediately right of Import in the frame action row; clicking it opens the
 * node graph for THAT shot via `onOpenGraph`. Without the handler (embedders
 * with no graph host) the button does not render.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BoardCard } from "../src/renderer/src/components/production/boards.js";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root | null = null;

const noop = () => {};

function renderCard(onOpenGraph?: (id: string) => void) {
  const prod = {
    meta: { id: "p1", name: "T", folder: "", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 1 },
    currentStep: 3,
    scenes: [],
  } as unknown as Production;
  const shot: ProductionShot = { id: "shot-1", number: "0100", audio: "", visual: "" };
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(BoardCard, {
        prod,
        shot,
        bust: 0,
        regenerating: false,
        videoBusy: false,
        onRegenerate: noop,
        onImport: noop,
        onOpenGraph,
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
  act(() => { root?.unmount(); });
  root = null;
  container.remove();
});

describe("BoardCard Nodes button", () => {
  it("renders right of Import and opens the graph for its own shot", () => {
    const onOpenGraph = vi.fn();
    renderCard(onOpenGraph);

    const actions = container.querySelector(".prod-board-actions");
    expect(actions).not.toBeNull();
    const buttons = [...actions!.querySelectorAll("button")];
    const importIdx = buttons.findIndex((b) => b.className.includes("prod-board-import"));
    const nodesIdx = buttons.findIndex((b) => b.className.includes("prod-board-nodes"));
    expect(importIdx).toBeGreaterThanOrEqual(0);
    expect(nodesIdx).toBe(importIdx + 1);
    expect(buttons[nodesIdx].title).toBe("Open the node graph for this shot");
    expect(buttons[nodesIdx].querySelector("img.cascade-icon")).not.toBeNull();

    act(() => { buttons[nodesIdx].click(); });
    expect(onOpenGraph).toHaveBeenCalledTimes(1);
    expect(onOpenGraph).toHaveBeenCalledWith("shot-1");
  });

  it("does not render the button when no graph handler is wired", () => {
    renderCard(undefined);
    expect(container.querySelector(".prod-board-nodes")).toBeNull();
    expect(container.querySelector(".prod-board-import")).not.toBeNull();
  });
});
