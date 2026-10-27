/**
 * Storyboard color tags — the right-click panel menu sets a shot's green /
 * yellow / red tag (or removes it), and a tagged card carries the `tag-*`
 * class that paints the colored frame border. The menu must open with only
 * the tag handler wired (no delete/disable handlers needed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { BoardCard } from "../src/renderer/src/components/production/boards.js";
import type { Production, ProductionShot, ShotColorTag } from "../src/shared/ipc.js";

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

function renderCard(shot: ProductionShot, onSetColorTag: (id: string, tag: ShotColorTag | undefined) => void) {
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
        onSetColorTag,
      }),
    );
  });
}

function menuItems() {
  const figure = container.querySelector("figure.prod-board");
  expect(figure).not.toBeNull();
  act(() => {
    figure!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  return [...container.querySelectorAll(".ctx-item")] as HTMLButtonElement[];
}

function clickItem(label: string) {
  const item = menuItems().find((b) => b.textContent?.trim() === label);
  expect(item, `menu item "${label}"`).not.toBeUndefined();
  act(() => {
    item!.click();
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

describe("BoardCard color tags", () => {
  it("sets a tag from the right-click menu", () => {
    const onSetColorTag = vi.fn();
    renderCard(makeShot({}), onSetColorTag);
    const figure = container.querySelector("figure.prod-board")!;
    expect(figure.className).not.toContain("tag-");
    const labels = menuItems().map((b) => b.textContent?.trim());
    expect(labels).toContain("Green tag");
    expect(labels).toContain("Yellow tag");
    expect(labels).toContain("Red tag");
    expect(labels).not.toContain("Remove color tag");
    clickItem("Yellow tag");
    expect(onSetColorTag).toHaveBeenCalledWith("shot-1", "yellow");
  });

  it("shows the tag class, checks the current color, and removes the tag", () => {
    const onSetColorTag = vi.fn();
    renderCard(makeShot({ colorTag: "red" }), onSetColorTag);
    expect(container.querySelector("figure.prod-board.tag-red")).not.toBeNull();
    const labels = menuItems().map((b) => b.textContent?.trim());
    expect(labels).toContain("✓ Red tag");
    clickItem("Remove color tag");
    expect(onSetColorTag).toHaveBeenCalledWith("shot-1", undefined);
  });
});
