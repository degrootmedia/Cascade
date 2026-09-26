/**
 * Regression for: pasting an image into the Design-page reference panel must
 * not resurrect dismissed suggested references. The Ctrl+V paste listener is
 * registered by an effect whose deps don't include suggestedReferences, so it
 * used to write stale field state (the pre-dismiss production) back over the
 * newer save.
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
// node has `File` but not `FileReader` — stub just enough for fileToDataUrl.
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
    meta: { id: "p1", name: "Test production", folder: "C:/test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stepDone: 0, shotCount: 0 },
    currentStep: 2,
    visualStyle: "",
    styles: [],
    brand: { colors: [], font: "" },
    scenes: [],
    characters: [],
    products: [],
    references: [],
    suggestedReferences: [{ id: "sg1", name: "Hero", kind: "character" }],
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
    getOpenArtCredits: async () => null,
    listProductions: async () => [{ id: "p1", name: "Test production", folder: "C:/test", shotCount: 0, stepDone: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    onProductionEvent: () => () => {},
    onBoardExternalUpdate: () => () => {},
    onReferencesExternalUpdate: () => () => {},
    checkExternalEdits: async () => {},
    loadProduction: async () => disk,
    boardImage: async () => "data:image/png;base64,AAAA",
    addReferenceImage: async () => ({ path: "references/pasted.png" }),
    getBoardPrompt: async () => null,
    saveProduction: async (p: Record<string, unknown>) => { disk = JSON.parse(JSON.stringify(p)) as Record<string, unknown>; savedProds.push(disk); },
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
    updateBoardPrompt: async () => disk,
  };
}

function pasteImage(): void {
  const file = new File(["x"], "img.png", { type: "image/png" });
  const items = [{ kind: "file", type: "image/png", getAsFile: () => file }];
  const ev = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: { items: typeof items } };
  ev.clipboardData = { items };
  window.dispatchEvent(ev);
}

describe("paste after dismissing a suggestion", () => {
  it("keeps the dismissed suggestion gone after a Ctrl+V image paste", async () => {
    disk = freshProd();
    savedProds.length = 0;
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
    expect(openBtn).toBeTruthy();
    await act(async () => { openBtn.click(); await new Promise((r) => setTimeout(r, 0)); });

    // The suggestion is visible on the Design page.
    expect(host.querySelectorAll(".prod-suggestion").length).toBe(1);

    // Dismiss it.
    const dismiss = host.querySelector(".prod-suggestion-remove") as HTMLButtonElement;
    await act(async () => { dismiss.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect((savedProds[savedProds.length - 1]?.suggestedReferences as unknown[] | undefined)?.length ?? 0).toBe(0);

    // Paste an image into the reference panel.
    await act(async () => { pasteImage(); await new Promise((r) => setTimeout(r, 30)); });

    // The paste created a reference, but the dismissed suggestion stays gone.
    const last = savedProds[savedProds.length - 1];
    expect((last?.references as Array<Record<string, unknown>> | undefined)?.some((r) => r.name === "Ref-001")).toBe(true);
    expect((last?.suggestedReferences as unknown[] | undefined)?.length ?? 0).toBe(0);
    expect(host.querySelectorAll(".prod-suggestion").length).toBe(0);

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});