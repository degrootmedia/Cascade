/**
 * Graph right shelf tabs (Feature #18): the node canvas's right shelf is
 * tabbed (Nodes / Snippets). The Nodes tab is the Feature #15 categorized
 * palette untouched; the Snippets tab is the Feature #14 prompt-snippet
 * shelf embedded here (same library, insert-at-cursor, copy fallback,
 * add/delete). The header no longer carries a Snippets button — the tab
 * is the node canvas's only snippets entry point. Save-selection from a
 * node prompt routes to the tab (the overlay shelf yields while the
 * canvas is open); with the palette hidden (sequence canvas) the overlay
 * keeps ownership. The last-used tab persists per user.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import * as fs from "node:fs";
import * as path from "node:path";
import { PALETTE_TOOLS } from "../src/shared/graph/node-shelf.js";
import { GraphRightShelf, GRAPH_SHELF_TAB_KEY } from "../src/renderer/src/components/graph/right-shelf.js";
import type { NodeShelfTile } from "../src/renderer/src/components/graph/node-shelf.js";
import { SnippetsShelfHost } from "../src/renderer/src/components/snippets/SnippetsShelf.js";
import { openSnippetsShelf } from "../src/renderer/src/components/snippets/snippets-ui.js";
import { resetSnippetStoreForTests } from "../src/renderer/src/components/snippets/snippet-store.js";
import {
  installPromptFieldTracking,
  resetPromptFieldForTests,
} from "../src/renderer/src/components/snippets/prompt-field.js";
import { SEEDED_PROMPT_SNIPPETS, type PromptSnippet } from "../src/shared/prompt-snippets.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/* ---------- fake persistence (window.cascade) + clipboard ---------- */

let persisted: PromptSnippet[] | null = null;
let clipboardWrites: string[] = [];

function installFakes() {
  (globalThis as Record<string, unknown>).cascade = {
    getPromptSnippets: async () => (persisted === null ? SEEDED_PROMPT_SNIPPETS.map((s) => ({ ...s })) : persisted.map((s) => ({ ...s }))),
    setPromptSnippets: async (list: PromptSnippet[]) => {
      persisted = list.map((s) => ({ ...s }));
    },
  };
  clipboardWrites = [];
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (t: string) => { clipboardWrites.push(t); } },
    configurable: true,
  });
}

/* ---------- tiny DOM harness ---------- */

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(el: ReactElement): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  window.localStorage.clear();
  persisted = null;
  installFakes();
  resetSnippetStoreForTests();
  resetPromptFieldForTests();
  installPromptFieldTracking();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  window.localStorage.clear();
});

function tiles(): NodeShelfTile[] {
  return PALETTE_TOOLS.map((def) => ({
    tool: def.tool,
    label: def.label,
    icon: createElement("span", { className: "prod-graph-tools-icon cascade-icon" }),
    title: `Drag to add ${def.label}`,
    draggable: true,
  }));
}

const tabBtn = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>(".prod-graph-tools-tab")].find((b) => b.textContent === label) ?? null;
const tileLabels = (scope: ParentNode) =>
  [...scope.querySelectorAll(".prod-graph-tools-item .prod-graph-tools-label")].map((el) => el.textContent);
const entryButton = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>(".snippets-entry-main")].find((x) => (x.textContent ?? "").includes(name));

async function click(el: HTMLElement): Promise<void> {
  await act(async () => { el.click(); await new Promise((r) => setTimeout(r, 0)); });
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("graph right shelf tabs (Feature #18)", () => {
  it("defaults to the Nodes tab with the categorized palette; snippets pane hidden", async () => {
    const h = mount(createElement(GraphRightShelf, { tiles: tiles() }));
    await flush();
    const nodesTab = tabBtn(h, "Nodes")!;
    const snippetsTab = tabBtn(h, "Snippets")!;
    expect(nodesTab).toBeTruthy();
    expect(snippetsTab).toBeTruthy();
    expect(nodesTab.getAttribute("aria-selected")).toBe("true");
    expect(snippetsTab.getAttribute("aria-selected")).toBe("false");
    // Feature #15 content intact: grouped tiles + search box.
    expect(tileLabels(h)).toContain("Upscale");
    expect(h.querySelector(".prod-graph-tools-search")).toBeTruthy();
    // Snippets pane exists but is not the shown pane.
    const snippetsPane = h.querySelector(".prod-graph-tools-pane.snippets-pane") as HTMLElement;
    expect(snippetsPane.classList.contains("hidden")).toBe(true);
    expect(h.querySelector(".prod-graph-tools")?.classList.contains("snippets-tab")).toBe(false);
  });

  it("switching tabs swaps content and remembers the Nodes search", async () => {
    const h = mount(createElement(GraphRightShelf, { tiles: tiles() }));
    await flush();
    const search = h.querySelector(".prod-graph-tools-search") as HTMLInputElement;
    await act(async () => { setNativeValue(search, "upscale"); });
    expect(tileLabels(h)).toEqual(["Upscale"]);

    await click(tabBtn(h, "Snippets")!);
    expect(tabBtn(h, "Snippets")!.getAttribute("aria-selected")).toBe("true");
    const snippetsPane = h.querySelector(".prod-graph-tools-pane.snippets-pane") as HTMLElement;
    expect(snippetsPane.classList.contains("hidden")).toBe(false);
    // Feature #14 content: seeds grouped by category.
    const cats = [...snippetsPane.querySelectorAll(".snippets-category")].map((x) => x.textContent);
    expect(cats).toEqual(["Locks — geometry & pose", "Audio"]);
    expect(entryButton(snippetsPane, "No music")).toBeTruthy();

    await click(tabBtn(h, "Nodes")!);
    expect(tileLabels(h)).toEqual(["Upscale"]); // search survived the round-trip
    expect((h.querySelector(".prod-graph-tools-search") as HTMLInputElement).value).toBe("upscale");
  });

  it("remembers the last-used tab per user across a remount", async () => {
    const first = mount(createElement(GraphRightShelf, { tiles: tiles() }));
    await flush();
    await click(tabBtn(first, "Snippets")!);
    expect(window.localStorage.getItem(GRAPH_SHELF_TAB_KEY)).toBe("snippets");
    await act(async () => { root!.unmount(); });
    root = null;
    first.remove();

    const second = mount(createElement(GraphRightShelf, { tiles: tiles() }));
    await flush();
    expect(tabBtn(second, "Snippets")!.getAttribute("aria-selected")).toBe("true");
    expect(second.querySelector(".prod-graph-tools-pane.snippets-pane")?.classList.contains("hidden")).toBe(false);
  });

  it("clicking a snippet in the tab inserts at the prompt cursor and the shelf stays put", async () => {
    let latest = "edit: make it";
    function Wrapper(): ReactElement {
      const [v, setV] = useState(latest);
      latest = v;
      return createElement("div", null,
        createElement("textarea", {
          className: "prod-edit-prompt",
          value: v,
          onChange: (e: { target: { value: string } }) => setV(e.target.value),
        }),
        createElement(GraphRightShelf, { tiles: tiles() }),
      );
    }
    const h = mount(createElement(Wrapper));
    await flush();
    const ta = h.querySelector("textarea") as HTMLTextAreaElement;
    act(() => { ta.focus(); ta.setSelectionRange(13, 13); ta.dispatchEvent(new Event("keyup", { bubbles: true })); });

    await click(tabBtn(h, "Snippets")!);
    const snippetsPane = h.querySelector(".prod-graph-tools-pane.snippets-pane") as HTMLElement;
    await act(async () => { entryButton(snippetsPane, "No music")!.click(); });
    expect(latest).toBe(`edit: make it${SEEDED_PROMPT_SNIPPETS[2].body}`);
    expect(clipboardWrites).toEqual([]);
    expect(document.activeElement).toBe(ta);
    // Embedded: nothing closes — the Snippets tab is still showing.
    expect(tabBtn(h, "Snippets")!.getAttribute("aria-selected")).toBe("true");
    expect(snippetsPane.classList.contains("hidden")).toBe(false);
  });

  it("falls back to copy + toast in the tab when no prompt field is active", async () => {
    const h = mount(createElement(GraphRightShelf, { tiles: tiles() }));
    await flush();
    await click(tabBtn(h, "Snippets")!);
    const snippetsPane = h.querySelector(".prod-graph-tools-pane.snippets-pane") as HTMLElement;
    await act(async () => { entryButton(snippetsPane, "No music")!.click(); });
    expect(clipboardWrites).toEqual([SEEDED_PROMPT_SNIPPETS[2].body]);
    expect(document.querySelector(".snippets-toast")?.textContent).toContain("Copied");
    expect(snippetsPane.classList.contains("hidden")).toBe(false);
  });

  it("add and delete work from the tab and persist", async () => {
    const h = mount(createElement(GraphRightShelf, { tiles: tiles() }));
    await flush();
    await click(tabBtn(h, "Snippets")!);
    const pane = h.querySelector(".prod-graph-tools-pane.snippets-pane") as HTMLElement;
    const newBtn = [...pane.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("New")) as HTMLButtonElement;
    await click(newBtn);
    const inputs = [...pane.querySelectorAll<HTMLInputElement>(".snippets-field input")];
    const body = pane.querySelector<HTMLTextAreaElement>(".snippets-field textarea")!;
    act(() => {
      setNativeValue(inputs[0], "Rain lock");
      setNativeValue(inputs[1], "Weather");
      setNativeValue(body, "Rain falls [heavily] throughout.");
    });
    const addBtn = [...pane.querySelectorAll("button")].find((b) => b.textContent === "Add snippet") as HTMLButtonElement;
    await act(async () => { addBtn.click(); });
    await flush();
    expect(persisted?.some((s) => s.name === "Rain lock" && s.category === "Weather")).toBe(true);
    expect(entryButton(pane, "Rain lock")).toBeTruthy();

    const delBtn = pane.querySelector<HTMLButtonElement>('button[aria-label="Delete Rain lock"]')!;
    await click(delBtn);
    const confirm = [...pane.querySelectorAll("button")].find((b) => b.textContent === "Delete?") as HTMLButtonElement;
    await act(async () => { confirm.click(); });
    await flush();
    expect(persisted?.some((s) => s.name === "Rain lock")).toBe(false);
  });

  it("Save-selection requests route to the tab while the canvas shelf is open (overlay stays closed)", async () => {
    function Wrapper(): ReactElement {
      return createElement("div", null,
        createElement(SnippetsShelfHost),
        createElement(GraphRightShelf, { tiles: tiles() }),
      );
    }
    const h = mount(createElement(Wrapper));
    await flush();
    expect(tabBtn(h, "Nodes")!.getAttribute("aria-selected")).toBe("true");

    act(() => openSnippetsShelf({ prefillBody: "keep this exact framing" }));
    await flush();
    expect(document.querySelector(".snippets-backdrop")).toBeNull();
    expect(tabBtn(h, "Snippets")!.getAttribute("aria-selected")).toBe("true");
    const pane = h.querySelector(".prod-graph-tools-pane.snippets-pane") as HTMLElement;
    const body = pane.querySelector<HTMLTextAreaElement>(".snippets-field textarea");
    expect(body?.value).toBe("keep this exact framing");
  });

  it("with the palette hidden (sequence canvas) the overlay shelf keeps ownership", async () => {
    function Wrapper(): ReactElement {
      return createElement("div", null,
        createElement(SnippetsShelfHost),
        createElement(GraphRightShelf, { tiles: tiles(), hidden: true }),
      );
    }
    const h = mount(createElement(Wrapper));
    await flush();
    expect(h.querySelector(".prod-graph-tools")?.classList.contains("hidden")).toBe(true);
    act(() => openSnippetsShelf());
    await flush();
    expect(document.querySelector(".snippets-backdrop")).not.toBeNull();
    expect(document.querySelector(".snippets-shelf")).not.toBeNull();
  });
});

describe("node canvas header has no snippets entry point (Feature #18)", () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

  it("the modal mounts the tabbed shelf and no header Snippets button; classic view keeps its button", () => {
    const modal = read("../src/renderer/src/components/NodeGraphModal.tsx");
    expect(modal).not.toContain("<SnippetsButton");
    expect(modal).toContain("<GraphRightShelf");
    expect(read("../src/renderer/src/components/production/prompt-panel.tsx")).toContain("<SnippetsButton />");
    expect(read("../src/renderer/src/components/ProductionWorkspace.tsx")).toContain("<SnippetsShelfHost />");
  });
});
