/**
 * Audio reference tile: right-click opens the waveform-color swatch menu
 * (the shared accent palette), the current color is marked, and picking a
 * swatch reports the palette id once. Without a persist handler there is
 * no menu. Playback itself needs real media machinery jsdom lacks, so
 * this pins the menu contract only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { AudioRefTile } from "../src/renderer/src/components/graph/audio-ref-tile.js";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root | null = null;

function renderTile(props: { colorId?: string; onPickColor?: (colorId: string) => void }) {
  root = createRoot(container);
  act(() => {
    root!.render(createElement(AudioRefTile, {
      url: "cascade-media://p1/references/vo.mp3",
      name: "Voiceover",
      ...props,
    }));
  });
}

function openMenu(): HTMLButtonElement[] {
  const tile = container.querySelector(".prod-graph-audio");
  expect(tile).not.toBeNull();
  act(() => {
    tile!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  return [...document.body.querySelectorAll(".seq-accent-swatch")] as HTMLButtonElement[];
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

describe("AudioRefTile waveform color menu", () => {
  it("offers every accent color, marks blue current by default, and reports the pick", () => {
    const onPickColor = vi.fn();
    renderTile({ onPickColor });
    const swatches = openMenu();
    expect(swatches.map((b) => b.title)).toEqual(["Blue", "Violet", "Pink", "Red", "Orange", "Amber", "Green", "Teal"]);
    expect(swatches[0].className).toContain("current");
    const teal = swatches.find((b) => b.title === "Teal")!;
    act(() => {
      teal.click();
    });
    expect(onPickColor).toHaveBeenCalledTimes(1);
    expect(onPickColor).toHaveBeenCalledWith("teal");
    expect(document.body.querySelectorAll(".seq-accent-swatch")).toHaveLength(0);
  });

  it("marks the persisted color current", () => {
    renderTile({ colorId: "pink", onPickColor: vi.fn() });
    const swatches = openMenu();
    const current = swatches.filter((b) => b.className.includes("current"));
    expect(current.map((b) => b.title)).toEqual(["Pink"]);
  });

  it("opens no menu without a persist handler", () => {
    renderTile({});
    expect(openMenu()).toHaveLength(0);
  });
});
