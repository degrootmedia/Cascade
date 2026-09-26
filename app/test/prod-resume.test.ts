/**
 * Regression for: switching to Chat and back dropped the user on the
 * production picker because `ProductionWorkspace` unmounts with the view and
 * its `prod` state resets. The workspace now remembers the open production id
 * in localStorage (`cascade.lastProduction`) and resumes it on mount; an
 * explicit Close (or a production that no longer exists) clears it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ProductionWorkspace } from "../src/renderer/src/components/ProductionWorkspace.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as Record<string, unknown>).ResizeObserver = ROStub;

const LAST_PROD_KEY = "cascade.lastProduction";

function freshProd() {
  return {
    meta: { id: "p1", name: "Test production", folder: "C:/test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stepDone: 0, shotCount: 0 },
    currentStep: 2,
    visualStyle: "",
    styles: [],
    brand: { colors: [], font: "" },
    scenes: [],
    characters: [],
    products: [],
    references: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
  };
}

function cascadeMock(loader: () => unknown) {
  const stub = () => Promise.resolve();
  return {
    boardThumbnail: async () => null,
    showImageMenu: async () => {},
    videoModelOptions: async () => null,
    getOpenArtCredits: async () => null,
    listProductions: async () => [{ id: "p1", name: "Test production", folder: "C:/test", shotCount: 0, stepDone: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    onProductionEvent: () => () => {},
    onBoardExternalUpdate: () => () => {},
    onReferencesExternalUpdate: () => () => {},
    checkExternalEdits: async () => {},
    loadProduction: async () => loader(),
    boardImage: async () => "data:image/png;base64,AAAA",
    addReferenceImage: async () => ({ path: "references/pasted.png" }),
    getBoardPrompt: async () => null,
    saveProduction: async () => {},
    getMcpStatus: async () => [],
    listOpenArtModels: async () => [],
    getMediaProvider: async () => "openart",
    listMediaProviders: async () => [{ id: "openart", displayName: "OpenArt", available: true }],
    listModels: async () => [],
    getSettings: async () => ({}),
    generateBoards: stub, regenerateBoards: stub, exportBoardPrompts: stub, saveBoardPrompts: stub,
    importBoards: stub, pickBoardImages: stub, editBoard: stub,
    generateFrameNode: stub, generateVideoNode: stub, generateEditNode: stub,
    applyGraphOutput: stub, applyGraphRefOutput: stub,
    addReferenceMedia: stub, removeReferenceFile: stub,
    importVoiceover: stub, voiceoverFile: stub,
    importMusic: stub, musicFile: stub, removeMusic: stub, removeVoiceover: stub,
    pickReferenceImage: stub, refineStylePrompt: stub, styleFromImage: stub, generateMagicPrompts: stub,
    setMagicEnabled: stub, ingestScript: stub, createProduction: stub,
    removeProduction: stub, pickProductionFolder: stub, pickScriptFile: stub,
    reorderShot: stub, promoteBoardHistory: stub, recheckBoard: stub, removeVideo: stub,
    updateBoardPrompt: async () => null,
  };
}

async function mountWorkspace(): Promise<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(ProductionWorkspace, {}));
    await new Promise((r) => setTimeout(r, 0));
  });
  return { host, root };
}

describe("production resume", () => {
  let store: Record<string, string>;
  const realDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  beforeEach(() => {
    store = {};
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
      },
      configurable: true,
    });
  });

  afterEach(() => {
    if (realDescriptor) Object.defineProperty(globalThis, "localStorage", realDescriptor);
    else delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("resumes the remembered production instead of showing the picker", async () => {
    store[LAST_PROD_KEY] = "p1";
    (globalThis.window as unknown as Record<string, unknown>).cascade = cascadeMock(() => freshProd());
    const { host, root } = await mountWorkspace();

    expect(host.querySelector(".prod-workspace")).toBeTruthy();
    expect(host.querySelector(".prod-card-open")).toBeNull();

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("shows the picker and forgets a remembered production that's gone", async () => {
    store[LAST_PROD_KEY] = "p1";
    (globalThis.window as unknown as Record<string, unknown>).cascade = cascadeMock(() => null);
    const { host, root } = await mountWorkspace();

    expect(host.querySelector(".prod-card-open")).toBeTruthy();
    expect(store[LAST_PROD_KEY]).toBeUndefined();

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});
