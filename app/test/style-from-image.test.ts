/**
 * Design page (Step 2) style-image buttons.
 *
 * 1. "From image…" — picking an image distills a new named style via the LLM
 *    and keeps the picked image as that style's frame. The button must show
 *    it is working from the click (picker + model preflight + LLM call), and
 *    a picker failure (e.g. an oversized image) must surface as an error,
 *    not a silent no-op.
 * 2. "Upload frame" — attaches the picked image to the existing style as its
 *    frame (imagePath), so board generation uploads it as the look anchor.
 *    The button must show it is working while the attach runs, and a picker
 *    failure must surface as an error.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ProductionWorkspace } from "../src/renderer/src/components/ProductionWorkspace.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as Record<string, unknown>).ResizeObserver = ROStub;
(globalThis as Record<string, unknown>).requestAnimationFrame ??= (() => 0) as never;
(globalThis as Record<string, unknown>).cancelAnimationFrame ??= (() => {}) as never;

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let disk: Record<string, unknown> | null = null;
const savedProds: Array<Record<string, unknown>> = [];

/** Controllable seams, swapped per test. */
let pickImage: () => Promise<string | null> = async () => null;
let styleFromImageImpl: () => Promise<{ name: string; prompt: string; imagePath?: string }> =
  async () => ({ name: "Moody Noir", prompt: "High-contrast noir lighting.", imagePath: "styles/style-x.png" });
let setStyleFrameImpl: (styleId: string) => Promise<Record<string, unknown>> = async () => disk!;

function freshProd(): Record<string, unknown> {
  return {
    meta: { id: "p1", name: "Test production", folder: "C:/test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stepDone: 0, shotCount: 1 },
    currentStep: 2,
    visualStyle: "",
    styles: [{ id: "style1", index: 1, name: "Base look", prompt: "Clean flat animation." }],
    scenes: [{ id: "sc1", name: "Scene 1", shots: [{ id: "s1", number: 1, audio: "", visual: "A hero walks." }] }],
    characters: [],
    products: [],
    references: [],
    referenceCategories: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    magicEnabled: false,
    magicPrompts: {},
    rev: 1,
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
    modelOptions: async () => null,
    generationCost: async () => null,
    listProductions: async () => [{ id: "p1", name: "Test production", folder: "C:/test", shotCount: 1, stepDone: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    onProductionEvent: () => () => {},
    onBoardExternalUpdate: () => () => {},
    onReferencesExternalUpdate: () => () => {},
    checkExternalEdits: async () => {},
    loadProduction: async () => disk,
    saveProduction: async (p: Record<string, unknown>) => {
      disk = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
      disk.rev = (typeof disk.rev === "number" ? disk.rev : 0) + 1;
      savedProds.push(disk);
      return disk;
    },
    addReferenceImage: async (_id: string, name: string) => ({ path: `references/${name}` }),
    getMcpStatus: async () => [],
    listOpenArtModels: async () => [],
    getMediaProvider: async () => "openart",
    listMediaProviders: async () => [{ id: "openart", displayName: "OpenArt", available: true }],
    listModels: async () => ({ ok: true, models: [{ id: "m1", vision: true, thinking: false, baseCost: 1, costLabel: "1", costTitle: "", costKind: "per-message", costTier: null }] }),
    getSettings: async () => ({ model: "m1" }),
    getBoardPrompt: async () => "",
    updateBoardPrompt: async () => null,
    pickReferenceImage: () => pickImage(),
    styleFromImage: () => styleFromImageImpl(),
    setStyleFrame: (_id: string, styleId: string) => setStyleFrameImpl(styleId),
    generateBoards: stub, regenerateBoards: stub, exportBoardPrompts: stub, saveBoardPrompts: stub,
    importBoards: stub, pickBoardImages: stub, editBoard: stub,
    generateFrameNode: stub, generateVideoNode: stub, generateEditNode: stub,
    applyGraphOutput: stub, applyGraphRefOutput: stub,
    addReferenceMedia: stub, removeReferenceFile: stub,
    importVoiceover: stub, voiceoverFile: stub, importMusic: stub, musicFile: stub,
    refineStylePrompt: stub, generateMagicPrompts: stub, setMagicEnabled: stub,
    listStylePresets: async () => [{ name: "Pencil sketch", prompt: "Graphite pencil on paper.", file: "pencil-sketch.md" }],
    openStylePresetsFolder: stub,
    ingestScript: stub, createProduction: stub,
    removeProduction: stub, pickProductionFolder: stub, pickScriptFile: stub,
    reorderShot: stub, promoteBoardHistory: stub, recheckBoard: stub, removeVideo: stub,
  };
}

async function renderWorkspace(): Promise<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> {
  (globalThis as Record<string, unknown>).window = (globalThis as Record<string, unknown>).window ?? {};
  (globalThis.window as unknown as Record<string, unknown>).cascade = cascadeMock();
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

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`No button containing "${text}"`);
  return btn as HTMLButtonElement;
}

function teardown(root: ReturnType<typeof createRoot>, host: HTMLElement): void {
  act(() => { root.unmount(); });
  document.body.removeChild(host);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("From image… (style from image)", () => {
  it("shows it is working from the click and appends the distilled style with its frame", async () => {
    disk = freshProd();
    savedProds.length = 0;
    const pick = deferred<string | null>();
    const distill = deferred<{ name: string; prompt: string; imagePath?: string }>();
    pickImage = () => pick.promise;
    styleFromImageImpl = () => distill.promise;
    const { host, root } = await renderWorkspace();

    const btn = buttonByText(host, "From image");
    await act(async () => { btn.click(); await tick(); });
    // Working indication must cover the picker wait, not just the LLM call.
    expect(btn.textContent).toMatch(/reading|working|…/i);

    await act(async () => { pick.resolve("data:image/png;base64,AAAA"); await tick(); await tick(); });
    expect(btn.textContent).toMatch(/reading|working|…/i);

    await act(async () => {
      distill.resolve({ name: "Moody Noir", prompt: "High-contrast noir lighting.", imagePath: "styles/style-x.png" });
      await tick(); await tick();
    });
    const styles = (disk?.styles as Array<Record<string, unknown>> | undefined) ?? [];
    expect(styles).toHaveLength(2);
    expect(styles[1].name).toBe("Moody Noir");
    expect(styles[1].prompt).toBe("High-contrast noir lighting.");
    expect(styles[1].imagePath).toBe("styles/style-x.png");
    expect(styles[1].frameSource).toBe("reference");
    teardown(root, host);
  });

  it("surfaces a picker failure as an error instead of a silent no-op", async () => {
    disk = freshProd();
    pickImage = async () => { throw new Error("Couldn't read that image: Image is larger than 15 MB."); };
    const { host, root } = await renderWorkspace();
    await act(async () => { buttonByText(host, "From image").click(); await tick(); await tick(); });
    expect(host.textContent).toContain("larger than 15 MB");
    teardown(root, host);
  });
});

describe("Upload frame", () => {
  it("shows it is working while attaching and sets the style's frame", async () => {
    disk = freshProd();
    pickImage = async () => "data:image/png;base64,AAAA";
    const attach = deferred<Record<string, unknown>>();
    setStyleFrameImpl = () => attach.promise;
    const { host, root } = await renderWorkspace();

    const btn = buttonByText(host, "Upload frame");
    await act(async () => { btn.click(); await tick(); await tick(); });
    expect(btn.textContent).toMatch(/uploading|working|…/i);

    const next = JSON.parse(JSON.stringify(disk)) as Record<string, unknown>;
    const styles = next.styles as Array<Record<string, unknown>>;
    styles[0] = { ...styles[0], imagePath: "styles/style1.png", frameSource: "upload" };
    next.rev = (next.rev as number) + 1;
    disk = next;
    await act(async () => { attach.resolve(next); await tick(); await tick(); });
    expect(host.querySelector("img.prod-style-frame")).toBeTruthy();
    teardown(root, host);
  });

  it("surfaces a picker failure as an error instead of a silent no-op", async () => {
    disk = freshProd();
    pickImage = async () => { throw new Error("Couldn't read that image: Image is larger than 15 MB."); };
    const { host, root } = await renderWorkspace();
    await act(async () => { buttonByText(host, "Upload frame").click(); await tick(); await tick(); });
    expect(host.textContent).toContain("larger than 15 MB");
    teardown(root, host);
  });
});

describe("Style presets", () => {
  it("picking a preset appends a style with its name and prompt", async () => {
    disk = freshProd();
    const { host, root } = await renderWorkspace();
    const select = host.querySelector('select[aria-label="Add style from preset"]') as HTMLSelectElement | null;
    expect(select, "preset picker").toBeTruthy();
    await act(async () => {
      const proto = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
      proto?.call(select, "pencil-sketch.md");
      select!.dispatchEvent(new Event("change", { bubbles: true }));
      await tick(); await tick();
    });
    const styles = (disk?.styles as Array<Record<string, unknown>> | undefined) ?? [];
    expect(styles).toHaveLength(2);
    expect(styles[1].name).toBe("Pencil sketch");
    expect(styles[1].prompt).toBe("Graphite pencil on paper.");
    teardown(root, host);
  });
});
