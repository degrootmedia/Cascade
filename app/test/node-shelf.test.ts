/**
 * Node shelf categories (right-hand "Nodes" palette in the node graph):
 * - Every registered node kind declares exactly one shelf category in the
 *   node-kind registry; an undeclared/unknown kind falls back to
 *   Layout & Utility so it can never vanish from the shelf.
 * - The palette groups its tiles into collapsible sections, one per
 *   category, in shelf order; every palette tool (and, at the registry
 *   level, every node kind) appears exactly once.
 * - Collapse state persists across restarts (remount), and search finds a
 *   node that lives in a collapsed category without disturbing the
 *   persisted collapse states.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import {
  NODE_CATEGORIES,
  NODE_KIND_REGISTRY,
  FALLBACK_NODE_CATEGORY,
  categoryOrFallback,
  nodeCategoryFor,
} from "../src/shared/graph/kinds.js";
import {
  PALETTE_TOOLS,
  groupKindsByCategory,
  groupPaletteItems,
  nodeShelfCollapsedKey,
  paletteCategoryFor,
} from "../src/shared/graph/node-shelf.js";
import { NodeShelf, type NodeShelfTile } from "../src/renderer/src/components/graph/node-shelf.js";
import type { GraphNodeKind } from "../src/shared/ipc.js";

const ALL_KINDS = Object.keys(NODE_KIND_REGISTRY) as GraphNodeKind[];

describe("node category model (registry-driven)", () => {
  it("declares the category set in shelf order", () => {
    expect(NODE_CATEGORIES.map((c) => c.label)).toEqual([
      "Image",
      "Video",
      "Text & Prompts",
      "Inputs & References",
      "Output",
      "Layout & Utility",
    ]);
  });

  it("every registered node type declares exactly one category", () => {
    const ids = new Set(NODE_CATEGORIES.map((c) => c.id));
    for (const kind of ALL_KINDS) {
      const declared = NODE_KIND_REGISTRY[kind].category;
      expect(declared, kind).toBeDefined();
      expect(ids.has(declared!), `${kind} -> ${declared}`).toBe(true);
      expect(nodeCategoryFor(kind), kind).toBe(declared);
    }
  });

  it("assigns generation/edit nodes by the media they produce", () => {
    const media: Array<[GraphNodeKind, string]> = [
      ["imagegen", "Image"],
      ["editgen", "Image"],
      ["cameraGrid", "Image"],
      ["upscale", "Image"],
      ["videogen", "Video"],
      ["editvideo", "Video"],
      ["tween", "Video"],
      ["composer", "Text & Prompts"],
      ["videoprompt", "Text & Prompts"],
      ["editprompt", "Text & Prompts"],
      ["editvideoprompt", "Text & Prompts"],
      ["style", "Text & Prompts"],
      ["brand", "Text & Prompts"],
      ["ref", "Inputs & References"],
      ["output", "Output"],
    ];
    const labelFor = (kind: GraphNodeKind) =>
      NODE_CATEGORIES.find((c) => c.id === nodeCategoryFor(kind))?.label;
    for (const [kind, label] of media) {
      expect(labelFor(kind), kind).toBe(label);
    }
    expect(media.map(([k]) => k).sort()).toEqual([...ALL_KINDS].sort());
  });

  it("falls back to Layout & Utility for undeclared or unknown kinds", () => {
    expect(FALLBACK_NODE_CATEGORY).toBe("layout-utility");
    expect(categoryOrFallback(undefined)).toBe("layout-utility");
    expect(categoryOrFallback({})).toBe("layout-utility");
    expect(categoryOrFallback({ category: "video" })).toBe("video");
    expect(nodeCategoryFor("no-such-kind" as GraphNodeKind)).toBe("layout-utility");
  });

  it("groups every registered node type exactly once, in shelf order", () => {
    const sections = groupKindsByCategory();
    expect(sections.map((s) => s.category)).toEqual(NODE_CATEGORIES.map((c) => c.id));
    const seen = sections.flatMap((s) => s.kinds);
    expect(seen.length).toBe(ALL_KINDS.length);
    expect([...seen].sort()).toEqual([...ALL_KINDS].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("node shelf palette grouping + search (model)", () => {
  it("every palette tool appears exactly once, grouped in shelf order", () => {
    const sections = groupPaletteItems(PALETTE_TOOLS);
    const seen = sections.flatMap((s) => s.items.map((i) => i.tool));
    expect(seen.length).toBe(PALETTE_TOOLS.length);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual(PALETTE_TOOLS.map((t) => t.tool).sort());
    // Image shelves before Video; within a category the palette order holds.
    expect(sections.map((s) => s.label)).toEqual(["Image", "Video"]);
    expect(sections[0].items.map((i) => i.label)).toEqual(["Edit image", "Camera grid", "Upscale"]);
    expect(sections[1].items.map((i) => i.label)).toEqual([
      "Video generation",
      "Edit video",
      "Genjutsu Motion Transfer",
      "Genjutsu Object Swap",
      "In-betweener",
    ]);
  });

  it("derives each palette tool's category from the registry kind it places", () => {
    for (const def of PALETTE_TOOLS) {
      expect(NODE_KIND_REGISTRY[def.kind], def.tool).toBeDefined();
      expect(paletteCategoryFor(def.tool), def.tool).toBe(nodeCategoryFor(def.kind));
    }
  });

  it("search filters by name across all categories, case-insensitively", () => {
    expect(groupPaletteItems(PALETTE_TOOLS, "upscale").flatMap((s) => s.items.map((i) => i.label)))
      .toEqual(["Upscale"]);
    expect(groupPaletteItems(PALETTE_TOOLS, "GENJUTSU").flatMap((s) => s.items.map((i) => i.label)))
      .toEqual(["Genjutsu Motion Transfer", "Genjutsu Object Swap"]);
    expect(groupPaletteItems(PALETTE_TOOLS, "  edit ").flatMap((s) => s.items.map((i) => i.label)))
      .toEqual(["Edit image", "Edit video"]);
    expect(groupPaletteItems(PALETTE_TOOLS, "no such node")).toEqual([]);
    expect(groupPaletteItems(PALETTE_TOOLS, "").flatMap((s) => s.items).length)
      .toBe(PALETTE_TOOLS.length);
  });

  it("omits categories with no visible tools (hidden-tool hosts)", () => {
    const onlyVideo = PALETTE_TOOLS.filter((t) => t.tool === "video");
    const sections = groupPaletteItems(onlyVideo);
    expect(sections.map((s) => s.label)).toEqual(["Video"]);
    expect(groupPaletteItems([])).toEqual([]);
  });
});

/* Component: the shelf itself (collapse persistence + search behaviour). */

function tiles(): NodeShelfTile[] {
  return PALETTE_TOOLS.map((def) => ({
    tool: def.tool,
    label: def.label,
    icon: createElement("span", { className: "prod-graph-tools-icon cascade-icon" }),
    title: `Drag to add ${def.label}`,
    draggable: true,
  }));
}

function renderShelf(): { root: ReturnType<typeof createRoot>; host: HTMLDivElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(NodeShelf, { tiles: tiles() })); });
  return { root, host };
}

async function unmount(root: ReturnType<typeof createRoot>, host: HTMLDivElement): Promise<void> {
  await act(async () => { root.unmount(); });
  document.body.removeChild(host);
}

const heads = (host: HTMLDivElement) =>
  [...host.querySelectorAll<HTMLButtonElement>(".prod-graph-tools-group-head")];
const headFor = (host: HTMLDivElement, label: string) =>
  heads(host).find((h) => h.querySelector(".prod-graph-tools-group-name")?.textContent === label);
const tileLabels = (host: HTMLDivElement) =>
  [...host.querySelectorAll(".prod-graph-tools-item .prod-graph-tools-label")].map((el) => el.textContent);

async function click(el: HTMLElement): Promise<void> {
  await act(async () => { el.click(); await new Promise((r) => setTimeout(r, 0)); });
}

async function typeSearch(host: HTMLDivElement, value: string): Promise<void> {
  const input = host.querySelector(".prod-graph-tools-search") as HTMLInputElement;
  expect(input).toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("node shelf component", () => {
  beforeEach(() => { window.localStorage.clear(); });
  afterEach(() => { window.localStorage.clear(); });

  it("renders collapsible sections in shelf order with counts, every tile once", async () => {
    const { root, host } = renderShelf();
    expect(heads(host).map((h) => h.querySelector(".prod-graph-tools-group-name")?.textContent))
      .toEqual(["Image", "Video"]);
    expect(headFor(host, "Image")?.querySelector(".prod-graph-shelf-count")?.textContent).toBe("3");
    expect(headFor(host, "Video")?.querySelector(".prod-graph-shelf-count")?.textContent).toBe("5");
    expect(tileLabels(host).length).toBe(8);
    expect(new Set(tileLabels(host)).size).toBe(8);
    for (const h of heads(host)) expect(h.getAttribute("aria-expanded")).toBe("true");
    await unmount(root, host);
  });

  it("collapse state persists across a restart (remount)", async () => {
    const first = renderShelf();
    await click(headFor(first.host, "Image")!);
    expect(headFor(first.host, "Image")?.getAttribute("aria-expanded")).toBe("false");
    expect(tileLabels(first.host)).not.toContain("Upscale");
    expect(tileLabels(first.host)).toContain("Video generation");
    expect(window.localStorage.getItem(nodeShelfCollapsedKey("image"))).toBe("1");
    await unmount(first.root, first.host);

    // A fresh mount (app restart) restores the collapsed section.
    const second = renderShelf();
    expect(headFor(second.host, "Image")?.getAttribute("aria-expanded")).toBe("false");
    expect(tileLabels(second.host)).not.toContain("Upscale");
    expect(headFor(second.host, "Video")?.getAttribute("aria-expanded")).toBe("true");
    await unmount(second.root, second.host);
  });

  it("search finds a node in a collapsed category; clearing restores collapse states", async () => {
    const { root, host } = renderShelf();
    await click(headFor(host, "Image")!);
    expect(tileLabels(host)).not.toContain("Upscale");

    await typeSearch(host, "upscale");
    expect(tileLabels(host)).toEqual(["Upscale"]);
    expect(headFor(host, "Image")).toBeTruthy();

    await typeSearch(host, "");
    expect(headFor(host, "Image")?.getAttribute("aria-expanded")).toBe("false");
    expect(tileLabels(host)).not.toContain("Upscale");
    expect(tileLabels(host).length).toBe(5);
    expect(window.localStorage.getItem(nodeShelfCollapsedKey("image"))).toBe("1");
    await unmount(root, host);
  });

  it("search with no matches shows an empty state and no tiles", async () => {
    const { root, host } = renderShelf();
    await typeSearch(host, "zzz-no-node");
    expect(tileLabels(host)).toEqual([]);
    expect(host.querySelector(".prod-graph-tools-empty")?.textContent).toContain("zzz-no-node");
    await unmount(root, host);
  });

  it("dragging a tile carries the same tool payload as before", async () => {
    const { root, host } = renderShelf();
    const tile = [...host.querySelectorAll<HTMLElement>(".prod-graph-tools-item")]
      .find((el) => el.textContent?.includes("Upscale"))!;
    const seen: Array<[string, string]> = [];
    const ev = new Event("dragstart", { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
    ev.dataTransfer = { setData: (t: string, v: string) => seen.push([t, v]), effectAllowed: "" };
    await act(async () => { tile.dispatchEvent(ev); await new Promise((r) => setTimeout(r, 0)); });
    expect(seen).toEqual([["application/x-cascade-tool", "upscale"]]);
    await unmount(root, host);
  });
});
