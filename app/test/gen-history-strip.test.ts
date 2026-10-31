/**
 * Take-strip order — a generator node's inline strip reads oldest to newest
 * (left to right), so the "show every stored take" button, which stands for
 * the takes OLDER than the strip shows, leads the strip instead of trailing
 * it. At or under the strip limit there is no button at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { GenHistoryStrip } from "../src/renderer/src/components/NodeGraphModal.js";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root | null = null;

const noop = () => {};

/** Stored takes are newest-first: index 0 is the latest generation. */
function makeItems(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    url: "data:image/png;base64,AAAA",
    prompt: `Take ${i}`,
    path: `boards/0100/take-${i}.jpg`,
  }));
}

function renderStrip(n: number) {
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(GenHistoryStrip, {
        items: makeItems(n),
        selected: 0,
        media: "image" as const,
        onSelect: noop,
        onContextMenu: noop,
        history: { kind: "image" as const, title: "Image generations" },
      }),
    );
  });
  return [...container.querySelectorAll(".prod-graph-gen-strip > button")];
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

describe("GenHistoryStrip order", () => {
  it("leads with the history button, then the newest takes oldest-first", () => {
    const buttons = renderStrip(8);
    // History button first (it holds the older generations), then the newest
    // 6 takes in generation order: stored indexes 5,4,3,2,1,0.
    expect(buttons).toHaveLength(7);
    expect(buttons[0].classList.contains("prod-graph-gen-history")).toBe(true);
    expect(buttons[0].getAttribute("title")).toBe("Show every stored take (8)");
    expect(buttons.slice(1).map((b) => b.getAttribute("title"))).toEqual([
      "Take 5 — right-click for options",
      "Take 4 — right-click for options",
      "Take 3 — right-click for options",
      "Take 2 — right-click for options",
      "Take 1 — right-click for options",
      "Take 0 — right-click for options",
    ]);
  });

  it("shows no history button at the strip limit", () => {
    const buttons = renderStrip(6);
    expect(buttons).toHaveLength(6);
    expect(container.querySelector(".prod-graph-gen-history")).toBeNull();
  });
});
