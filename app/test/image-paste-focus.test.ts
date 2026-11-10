/**
 * Regression for: pasting an image with Ctrl+V sometimes takes several
 * attempts to register (Nov 5, 2026). The Design-page paste listener bailed
 * out whenever the paste target was any INPUT/TEXTAREA/SELECT/contentEditable
 * — including image-only clipboards (a screenshot), which a text field cannot
 * accept anyway. Whether a paste registered therefore depended on which field
 * happened to hold focus; clicking empty space between attempts is what made
 * a later attempt work. An image-only paste must register on the first
 * attempt regardless of focus, while a paste that actually carries text into
 * a text field must still go to the field untouched.
 */
import { describe, it, expect } from "vitest";
import { createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ProductionWorkspace } from "../src/renderer/src/components/ProductionWorkspace.js";
import { NamePromptHost } from "../src/renderer/src/components/NamePromptDialog.js";

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
    suggestedReferences: [],
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

/** Dispatch a paste AT `target` (so e.target is the focused field, as in the
 *  real app) with an image file and optionally a plain-text flavor. */
function pasteImageAt(target: HTMLElement, plainText: string): void {
  const file = new File(["x"], "img.png", { type: "image/png" });
  const items = [{ kind: "file", type: "image/png", getAsFile: () => file }];
  const ev = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  ev.clipboardData = {
    items,
    files: [file],
    getData: (type: string) => (type === "text/plain" ? plainText : ""),
  };
  target.dispatchEvent(ev);
}

async function openDesignPage(): Promise<{ host: HTMLDivElement; root: ReturnType<typeof createRoot> }> {
  disk = freshProd();
  savedProds.length = 0;
  (globalThis as Record<string, unknown>).window = (globalThis as Record<string, unknown>).window ?? {};
  (globalThis.window as unknown as Record<string, unknown>).cascade = cascadeMock();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Fragment, null, createElement(ProductionWorkspace, {}), createElement(NamePromptHost)));
    await new Promise((r) => setTimeout(r, 0));
  });
  const openBtn = host.querySelector(".prod-card-open") as HTMLButtonElement;
  expect(openBtn).toBeTruthy();
  await act(async () => { openBtn.click(); await new Promise((r) => setTimeout(r, 0)); });
  return { host, root };
}

async function confirmSavePopup(): Promise<void> {
  const nameInput = document.body.querySelector(".name-prompt-input") as HTMLInputElement | null;
  expect(nameInput, "save-reference popup shown").toBeTruthy();
  await act(async () => {
    nameInput!.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
  });
}

describe("image paste with a text field focused (Design page)", () => {
  it("registers an image-only paste on the first attempt even from a focused text field", async () => {
    const { host, root } = await openDesignPage();
    // Any real text field on the Design page stands in for "the user last
    // clicked / typed in a prompt or name box before pressing Ctrl+V".
    const field = host.querySelector("textarea, input") as HTMLElement | null;
    expect(field, "a text field on the Design page").toBeTruthy();

    await act(async () => { pasteImageAt(field!, ""); await new Promise((r) => setTimeout(r, 10)); });
    await confirmSavePopup();

    const last = savedProds[savedProds.length - 1];
    expect((last?.references as Array<Record<string, unknown>> | undefined)?.some((r) => r.name === "Ref_001")).toBe(true);

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("still ignores an image-only paste aimed at a text field outside the workspace", async () => {
    const { host, root } = await openDesignPage();
    // The workspace stays mounted (hidden) behind the Chat view, so a paste
    // into e.g. the chat composer must not be claimed by this listener.
    const outside = document.createElement("textarea");
    document.body.appendChild(outside);
    await act(async () => { pasteImageAt(outside, ""); await new Promise((r) => setTimeout(r, 10)); });
    expect(document.body.querySelector(".name-prompt-input")).toBeNull();
    outside.remove();

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("still leaves a paste that carries text to the focused text field", async () => {
    const { host, root } = await openDesignPage();
    const field = host.querySelector("textarea, input") as HTMLElement | null;
    expect(field, "a text field on the Design page").toBeTruthy();

    // Clipboard carries BOTH text and an image (e.g. a copied web selection);
    // in a text field the text paste wins and no reference popup opens.
    await act(async () => { pasteImageAt(field!, "hello"); await new Promise((r) => setTimeout(r, 10)); });
    expect(document.body.querySelector(".name-prompt-input")).toBeNull();

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});
