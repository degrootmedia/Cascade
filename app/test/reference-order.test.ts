/**
 * Design-page reference ordering + duplicate-name handling.
 *
 * 1. Dragging one reference tile onto another reorders the saved `references`
 *    array — the same order the node editor's shelf renders from.
 * 2. A reference image dropped with a name that already exists (e.g. the same
 *    file dropped twice) gets a two-digit suffix instead of colliding with /
 *    merging into the existing entry.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ProductionWorkspace } from "../src/renderer/src/components/ProductionWorkspace.js";
import { uniqueRefName, reorderRefs, reorderRefGroup } from "../src/renderer/src/components/production/references.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as Record<string, unknown>).ResizeObserver = ROStub;
(globalThis as Record<string, unknown>).requestAnimationFrame ??= (() => 0) as never;
(globalThis as Record<string, unknown>).cancelAnimationFrame ??= (() => {}) as never;

class FRStub {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  error: Error | null = null;
  readAsDataURL(file: File): void {
    file.text().then((t) => {
      this.result = `data:${file.type || "application/octet-stream"};base64,${btoa(t)}`;
      this.onload?.();
    }).catch((err: unknown) => { this.error = err instanceof Error ? err : new Error(String(err)); this.onerror?.(this.error); });
  }
}
(globalThis as Record<string, unknown>).FileReader = FRStub;

let disk: Record<string, unknown> | null = null;
const savedProds: Array<Record<string, unknown>> = [];

function freshProd(): Record<string, unknown> {
  return {
    meta: { id: "p1", name: "Test production", folder: "C:/test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stepDone: 0, shotCount: 1 },
    currentStep: 2,
    visualStyle: "",
    styles: [],
    scenes: [{ id: "sc1", name: "Scene 1", shots: [{ id: "s1", number: 1, audio: "", visual: "A hero walks." }] }],
    characters: [],
    products: [],
    references: [
      { id: "r1", name: "Ref One", imagePath: "references/one.png", shotIds: [] },
      { id: "r2", name: "Ref Two", imagePath: "references/two.png", shotIds: [] },
      { id: "r3", name: "Ref Three", imagePath: "references/three.png", shotIds: [] },
    ],
    referenceCategories: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    magicEnabled: false,
    magicPrompts: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
  };
}

function cascadeMock(): Record<string, unknown> {
  const stub = () => Promise.resolve();
  return {
    boardThumbnail: async () => null,
    showImageMenu: async () => {},
    videoModelOptions: async () => null,
    videoEndFrameModels: async () => [],
    getOpenArtCredits: async () => null,
    listProductions: async () => [{ id: "p1", name: "Test production", folder: "C:/test", shotCount: 1, stepDone: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    onProductionEvent: () => () => {},
    onBoardExternalUpdate: () => () => {},
    onReferencesExternalUpdate: () => () => {},
    checkExternalEdits: async () => {},
    loadProduction: async () => disk,
    saveProduction: async (p: Record<string, unknown>) => { disk = JSON.parse(JSON.stringify(p)) as Record<string, unknown>; savedProds.push(disk); },
    addReferenceImage: async (_id: string, name: string) => ({ path: `references/${name}` }),
    getMcpStatus: async () => [],
    listOpenArtModels: async () => [],
    getMediaProvider: async () => "openart",
    listMediaProviders: async () => [{ id: "openart", displayName: "OpenArt", available: true }],
    listModels: async () => [],
    getSettings: async () => ({}),
    getBoardPrompt: async () => "",
    updateBoardPrompt: async () => null,
    generateBoards: stub, regenerateBoards: stub, exportBoardPrompts: stub, saveBoardPrompts: stub,
    importBoards: stub, pickBoardImages: stub, editBoard: stub,
    generateFrameNode: stub, generateVideoNode: stub, generateEditNode: stub,
    applyGraphOutput: stub, applyGraphRefOutput: stub,
    addReferenceMedia: stub, removeReferenceFile: stub,
    importVoiceover: stub, voiceoverFile: stub, importMusic: stub, musicFile: stub,
    pickReferenceImage: stub, refineStylePrompt: stub, styleFromImage: stub,
    generateMagicPrompts: stub, setMagicEnabled: stub, ingestScript: stub, createProduction: stub,
    removeProduction: stub, pickProductionFolder: stub, pickScriptFile: stub,
    reorderShot: stub, promoteBoardHistory: stub, recheckBoard: stub, removeVideo: stub,
  };
}

function refNames(): string[] {
  return ((disk?.references as Array<Record<string, unknown>> | undefined) ?? []).map((r) => r.name as string);
}

function tileNames(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll(".prod-ref")).map((f) =>
    (f.querySelector(".prod-ref-edit-name") as HTMLInputElement)?.value ?? "???"
  );
}

async function renderWorkspace(): Promise<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(ProductionWorkspace, {}));
    await new Promise((r) => setTimeout(r, 0));
  });
  const openBtn = host.querySelector(".prod-card-open") as HTMLButtonElement;
  await act(async () => { openBtn.click(); await new Promise((r) => setTimeout(r, 0)); });
  return { host, root };
}

/** Drop the tile at `fromIndex` onto the tile at `toIndex`, on the given half.
 *  Indices are positions in the live saved order (which the DOM mirrors). */
async function dragTileOntoTile(host: HTMLElement, fromIndex: number, toIndex: number, after: boolean): Promise<void> {
  const tiles = host.querySelectorAll(".prod-ref") as NodeListOf<HTMLElement>;
  const draggedId = ((disk?.references as Array<{ id: string }>)[fromIndex]).id;
  const ev = new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: after ? 1000 : -1000 }) as MouseEvent & { dataTransfer: DataTransfer };
  ev.dataTransfer = {
    types: ["application/x-cascade-reference"],
    getData: (t: string) => t === "application/x-cascade-reference" ? draggedId : "",
    files: [],
  } as unknown as DataTransfer;
  await act(async () => { tiles[toIndex].dispatchEvent(ev); await new Promise((r) => setTimeout(r, 0)); });
}

/** Click a tile to change selection: `ctrl` toggles, `shift` extends. */
async function selectTile(host: HTMLElement, index: number, mod: { ctrl?: boolean; shift?: boolean } = {}): Promise<void> {
  const tiles = host.querySelectorAll(".prod-ref") as NodeListOf<HTMLElement>;
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: !!mod.ctrl, shiftKey: !!mod.shift });
  await act(async () => { tiles[index].dispatchEvent(ev); await new Promise((r) => setTimeout(r, 0)); });
}

/** Start a drag on the tile at `index` and return the payload it published. */
async function startTileDrag(host: HTMLElement, index: number): Promise<{ primary: string; group: string }> {
  const tiles = host.querySelectorAll(".prod-ref") as NodeListOf<HTMLElement>;
  const store = new Map<string, string>();
  const dt = {
    types: [] as string[],
    setData: (t: string, v: string) => { store.set(t, v); if (!dt.types.includes(t)) dt.types.push(t); },
    getData: (t: string) => store.get(t) ?? "",
    effectAllowed: "",
  };
  const ev = new Event("dragstart", { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
  ev.dataTransfer = dt;
  const source = tiles[index].querySelector("img") ?? tiles[index];
  await act(async () => { source.dispatchEvent(ev); await new Promise((r) => setTimeout(r, 0)); });
  return { primary: store.get("application/x-cascade-reference") ?? "", group: store.get("application/x-cascade-references") ?? "" };
}

/** Drop a published payload onto the tile at `toIndex`, on the given half. */
async function dropPayloadOntoTile(host: HTMLElement, payload: { primary: string; group: string }, toIndex: number, after: boolean): Promise<void> {
  const tiles = host.querySelectorAll(".prod-ref") as NodeListOf<HTMLElement>;
  const ev = new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: after ? 1000 : -1000 }) as MouseEvent & { dataTransfer: unknown };
  ev.dataTransfer = {
    types: ["application/x-cascade-reference", "application/x-cascade-references"],
    getData: (t: string) => (t === "application/x-cascade-references" ? payload.group : t === "application/x-cascade-reference" ? payload.primary : ""),
    files: [],
  };
  await act(async () => { tiles[toIndex].dispatchEvent(ev); await new Promise((r) => setTimeout(r, 0)); });
}

function selectedNames(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll(".prod-ref.selected")).map((f) =>
    (f.querySelector(".prod-ref-edit-name") as HTMLInputElement)?.value ?? "???"
  );
}

/** Drop an image file onto the uncategorized category panel. */
async function dropFileOnCategory(host: HTMLElement, file: File): Promise<void> {
  const panel = host.querySelector(".prod-category") as HTMLElement;
  const ev = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: DataTransfer };
  ev.dataTransfer = {
    types: ["Files"],
    getData: () => "",
    files: [file],
  } as unknown as DataTransfer;
  await act(async () => { panel.dispatchEvent(ev); await new Promise((r) => setTimeout(r, 30)); });
}

describe("uniqueRefName", () => {
  it("leaves a free name untouched and suffixes a taken one", () => {
    expect(uniqueRefName(["Gondola"], "Hero")).toBe("Hero");
    expect(uniqueRefName(["Gondola"], "Gondola")).toBe("Gondola 01");
    expect(uniqueRefName(["Gondola", "Gondola 01"], "Gondola")).toBe("Gondola 02");
    expect(uniqueRefName(["gondola"], "GONDOLA")).toBe("GONDOLA 01");
    expect(uniqueRefName([], "")).toBe("Reference");
  });
});

describe("reorderRefs", () => {
  const refs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  it("inserts before and after, preserving the rest", () => {
    expect(reorderRefs(refs, "a", "c", false).map((r) => r.id)).toEqual(["b", "a", "c", "d"]);
    expect(reorderRefs(refs, "a", "c", true).map((r) => r.id)).toEqual(["b", "c", "a", "d"]);
    expect(reorderRefs(refs, "d", "a", false).map((r) => r.id)).toEqual(["d", "a", "b", "c"]);
  });
  it("is a no-op for self, missing ids, and preserves the array identity", () => {
    expect(reorderRefs(refs, "a", "a", false)).toBe(refs);
    expect(reorderRefs(refs, "x", "a", false)).toBe(refs);
    expect(reorderRefs(refs, "a", "x", false)).toBe(refs);
  });
});

describe("reorderRefGroup", () => {
  const refs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
  it("moves a contiguous group before/after a target, preserving order", () => {
    expect(reorderRefGroup(refs, ["a", "c"], "e", false).map((r) => r.id)).toEqual(["b", "d", "a", "c", "e"]);
    expect(reorderRefGroup(refs, ["a", "c"], "e", true).map((r) => r.id)).toEqual(["b", "d", "e", "a", "c"]);
    expect(reorderRefGroup(refs, ["d", "e"], "a", false).map((r) => r.id)).toEqual(["d", "e", "a", "b", "c"]);
  });
  it("keeps the group's own relative order from the array, not the ids array", () => {
    expect(reorderRefGroup(refs, ["e", "b"], "a", false).map((r) => r.id)).toEqual(["b", "e", "a", "c", "d"]);
  });
  it("is a no-op when the target is in the group, missing, or nothing matches", () => {
    expect(reorderRefGroup(refs, ["a", "b"], "b", false)).toBe(refs);
    expect(reorderRefGroup(refs, ["a"], "z", false)).toBe(refs);
    expect(reorderRefGroup(refs, ["z"], "a", false)).toBe(refs);
  });
});

describe("design-page reference reorder", () => {
  it("reorders the saved references when a tile is dropped on another", async () => {
    disk = freshProd();
    savedProds.length = 0;
    (globalThis as Record<string, unknown>).window = (globalThis as Record<string, unknown>).window ?? {};
    (globalThis.window as unknown as Record<string, unknown>).cascade = cascadeMock();

    const { host, root } = await renderWorkspace();
    expect(tileNames(host)).toEqual(["Ref One", "Ref Two", "Ref Three"]);

    // Drag "Ref One" onto the right half of "Ref Three" → One after Three.
    await dragTileOntoTile(host, 0, 2, true);
    expect(refNames()).toEqual(["Ref Two", "Ref Three", "Ref One"]);
    expect(tileNames(host)).toEqual(["Ref Two", "Ref Three", "Ref One"]);

    // Drag "Ref One" onto the left half of "Ref Two" → One before Two.
    await dragTileOntoTile(host, 2, 0, false);
    expect(refNames()).toEqual(["Ref One", "Ref Two", "Ref Three"]);

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});

describe("design-page multi-select reorder", () => {
  it("drag carries the selected group and reorders them together", async () => {
    disk = freshProd();
    savedProds.length = 0;
    (globalThis as Record<string, unknown>).window = (globalThis as Record<string, unknown>).window ?? {};
    (globalThis.window as unknown as Record<string, unknown>).cascade = cascadeMock();

    const { host, root } = await renderWorkspace();
    expect(tileNames(host)).toEqual(["Ref One", "Ref Two", "Ref Three"]);

    // Ctrl-click "Ref One" and "Ref Three" → both selected.
    await selectTile(host, 0, { ctrl: true });
    await selectTile(host, 2, { ctrl: true });
    expect(selectedNames(host)).toEqual(["Ref One", "Ref Three"]);

    // Dragging a selected tile publishes the whole group.
    const payload = await startTileDrag(host, 0);
    expect(JSON.parse(payload.group).sort()).toEqual(["r1", "r3"]);

    // Drop the group after "Ref Two" → Two, One, Three.
    await dropPayloadOntoTile(host, payload, 1, true);
    expect(refNames()).toEqual(["Ref Two", "Ref One", "Ref Three"]);

    // Clicking without a modifier collapses the selection to that tile.
    await selectTile(host, 0, {});
    expect(selectedNames(host)).toEqual(["Ref Two"]);

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});

describe("design-page duplicate-name drop", () => {
  it("suffixes a dropped file whose name already exists", async () => {
    disk = freshProd();
    savedProds.length = 0;
    (globalThis as Record<string, unknown>).window = (globalThis as Record<string, unknown>).window ?? {};
    (globalThis.window as unknown as Record<string, unknown>).cascade = cascadeMock();

    const { host, root } = await renderWorkspace();
    const file = new File(["image-bytes"], "Ref One.png", { type: "image/png" });
    await dropFileOnCategory(host, file);

    expect(refNames()).toEqual(["Ref One", "Ref Two", "Ref Three", "Ref One 01"]);
    expect(tileNames(host)).toContain("Ref One 01");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});
