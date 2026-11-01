/**
 * In-use reference badge — a reference tile shows the node icon exactly while
 * it is in use (tag-cited or wired into a node), with the "where" in the
 * tooltip; an unused tile shows nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { RefFigure } from "../src/renderer/src/components/production/references.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CustomRef } from "../src/shared/ipc.js";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root | null = null;

const noop = () => {};

function renderTile(inUseTitle?: string) {
  const refItem: CustomRef = { id: "r1", name: "Silk", artwork: "data:image/png;base64,AAAA" };
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(RefFigure, {
        prodId: "p1",
        refItem,
        onAttach: noop,
        onRemove: noop,
        onRename: noop,
        onReorder: noop,
        inUseTitle,
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

describe("RefFigure in-use badge", () => {
  it("shows the badge with its tooltip when in use", () => {
    renderTile("In use — wired into Shot 0300");
    const badge = container.querySelector(".prod-ref-inuse");
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute("title")).toBe("In use — wired into Shot 0300");
  });

  it("sits in the tile's upper-right corner (styles.css)", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../src/renderer/src/styles.css"), "utf8");
    const at = css.indexOf(".prod-ref > .prod-ref-inuse {");
    expect(at).toBeGreaterThanOrEqual(0);
    const block = css.slice(at, css.indexOf("}", at));
    expect(block).toContain("right: 6px");
    expect(block).not.toContain("left:");
  });

  it("shows nothing when unused", () => {
    renderTile(undefined);
    expect(container.querySelector(".prod-ref-inuse")).toBeNull();
  });
});
