/**
 * Oversize image import (Item 2): dropping an image over the 15MB import
 * limit on the Design references panel shows the convert-to-JPEG popup.
 * Convert imports the downsampled JPEG (the dropped File's data is only
 * read); Cancel imports nothing; an under-limit drop never sees the popup.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ProductionWorkspace } from "../src/renderer/src/components/ProductionWorkspace.js";
import { NamePromptHost } from "../src/renderer/src/components/NamePromptDialog.js";
import { ConfirmHost } from "../src/renderer/src/components/ConfirmDialog.js";
import { IMAGE_IMPORT_LIMIT_BYTES, OVERSIZE_IMAGE_MESSAGE, OVERSIZE_IMAGE_CONVERT_LABEL } from "../src/shared/image-import.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as Record<string, unknown>).ResizeObserver = ROStub;
(globalThis as Record<string, unknown>).requestAnimationFrame ??= (() => 0) as never;
(globalThis as Record<string, unknown>).cancelAnimationFrame ??= (() => {}) as never;

class FRStub {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  error: Error | null = null;
  readAsDataURL(): void {
    queueMicrotask(() => { this.result = "data:image/png;base64,T1JJR0lOQUw="; this.onload?.(); });
  }
}
(globalThis as Record<string, unknown>).FileReader = FRStub;

let disk: Record<string, unknown> | null = null;
const downsampleImage = vi.fn(async (_dataUrl: string) => "data:image/jpeg;base64,U0hSVU5L");
const addReferenceImage = vi.fn(async (_id: string, name: string, _dataUrl: string) => ({ path: `references/${name}` }));

function freshProd(): Record<string, unknown> {
  return {
    meta: { id: "p1", name: "Test production", folder: "C:/test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stepDone: 0, shotCount: 1 },
    currentStep: 2, visualStyle: "", styles: [],
    scenes: [{ id: "sc1", name: "Scene 1", shots: [{ id: "s1", number: 1, audio: "", visual: "A hero walks." }] }],
    characters: [], products: [],
    references: [{ id: "r1", name: "Existing", imagePath: "references/existing.png", shotIds: [] }],
    referenceCategories: [], openArt: { model: "auto", resolution: "1k" }, status: {}, magicEnabled: false, magicPrompts: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
  };
}

function cascadeMock(): Record<string, unknown> {
  const stub = () => Promise.resolve();
  return {
    boardThumbnail: async () => null, showImageMenu: async () => {}, videoModelOptions: async () => null, videoEndFrameModels: async () => [], getOpenArtCredits: async () => null,
    listProductions: async () => [{ id: "p1", name: "Test production", folder: "C:/test", shotCount: 1, stepDone: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    onProductionEvent: () => () => {}, onBoardExternalUpdate: () => () => {}, onReferencesExternalUpdate: () => () => {}, checkExternalEdits: async () => {},
    loadProduction: async () => disk, saveProduction: async (p: Record<string, unknown>) => { disk = JSON.parse(JSON.stringify(p)) as Record<string, unknown>; },
    addReferenceImage: (id: string, name: string, dataUrl: string) => addReferenceImage(id, name, dataUrl),
    downsampleImage: (dataUrl: string) => downsampleImage(dataUrl),
    getMcpStatus: async () => [], listOpenArtModels: async () => [],
    getMediaProvider: async () => "openart", listMediaProviders: async () => [{ id: "openart", displayName: "OpenArt", available: true }], listModels: async () => [],
    getSettings: async () => ({}), getBoardPrompt: async () => "", updateBoardPrompt: async () => null,
    generateBoards: stub, regenerateBoards: stub, exportBoardPrompts: stub, saveBoardPrompts: stub, importBoards: stub, pickBoardImages: stub, editBoard: stub,
    generateFrameNode: stub, generateVideoNode: stub, generateEditNode: stub, applyGraphOutput: stub, applyGraphRefOutput: stub,
    addReferenceMedia: stub, removeReferenceFile: stub, importVoiceover: stub, voiceoverFile: stub, importMusic: stub, musicFile: stub,
    pickReferenceImage: stub, refineStylePrompt: stub, styleFromImage: stub, generateMagicPrompts: stub, setMagicEnabled: stub, ingestScript: stub, createProduction: stub,
    removeProduction: stub, pickProductionFolder: stub, pickScriptFile: stub, reorderShot: stub, promoteBoardHistory: stub, recheckBoard: stub, removeVideo: stub,
  };
}

const flush = async (ms = 30) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

async function renderWorkspace(): Promise<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Fragment, null, createElement(ProductionWorkspace, {}), createElement(NamePromptHost), createElement(ConfirmHost)));
    await new Promise((r) => setTimeout(r, 0));
  });
  const openBtn = host.querySelector(".prod-card-open") as HTMLButtonElement;
  await act(async () => { openBtn.click(); await new Promise((r) => setTimeout(r, 0)); });
  return { host, root };
}

function dropFile(host: HTMLElement, file: File): Promise<void> {
  const panel = host.querySelector(".prod-category") as HTMLElement;
  const ev = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: DataTransfer };
  ev.dataTransfer = { types: ["Files"], getData: () => "", files: [file] } as unknown as DataTransfer;
  return act(async () => { panel.dispatchEvent(ev); }) as unknown as Promise<void>;
}

function confirmButton(label: string): HTMLButtonElement | null {
  const layer = document.body.querySelector(".confirm-layer");
  if (!layer) return null;
  return Array.from(layer.querySelectorAll("button")).find((b) => b.textContent === label) as HTMLButtonElement | undefined ?? null;
}

async function confirmSavePopup(): Promise<void> {
  await flush();
  const input = document.body.querySelector(".name-prompt-input") as HTMLInputElement | null;
  expect(input, "save-reference popup shown").toBeTruthy();
  await act(async () => { input!.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 30)); });
}

function setup() {
  disk = freshProd();
  downsampleImage.mockClear();
  addReferenceImage.mockClear();
  (globalThis as Record<string, unknown>).window = (globalThis as Record<string, unknown>).window ?? {};
  (globalThis.window as unknown as Record<string, unknown>).cascade = cascadeMock();
}

function refNames(): string[] {
  return ((disk?.references as Array<Record<string, unknown>> | undefined) ?? []).map((r) => r.name as string);
}

describe("oversize image drop on the Design references panel", () => {
  it("Convert imports the downsampled JPEG, not the original bytes", async () => {
    setup();
    const { host, root } = await renderWorkspace();
    const big = new File([new Uint8Array(IMAGE_IMPORT_LIMIT_BYTES + 1024)], "Big Photo.png", { type: "image/png" });
    await dropFile(host, big);
    await flush();

    const layer = document.body.querySelector(".confirm-layer");
    expect(layer, "oversize popup shown").toBeTruthy();
    expect(layer!.querySelector("h3")?.textContent).toBe(OVERSIZE_IMAGE_MESSAGE);
    expect(layer!.querySelector("h3")?.textContent).toBe("This image is over the 15MB import limit. Convert it to JPEG to shrink it below 15MB?");
    const convert = confirmButton(OVERSIZE_IMAGE_CONVERT_LABEL);
    expect(convert, "Convert to JPEG button").toBeTruthy();
    expect(confirmButton("Cancel"), "Cancel button").toBeTruthy();

    await act(async () => { convert!.click(); await new Promise((r) => setTimeout(r, 30)); });
    expect(downsampleImage).toHaveBeenCalledTimes(1);
    expect(downsampleImage).toHaveBeenCalledWith("data:image/png;base64,T1JJR0lOQUw=");

    await confirmSavePopup();
    expect(addReferenceImage).toHaveBeenCalledTimes(1);
    expect(addReferenceImage.mock.calls[0][2]).toBe("data:image/jpeg;base64,U0hSVU5L");
    expect(refNames()).toEqual(["Existing", "Big Photo"]);

    await act(async () => { root.unmount(); }); document.body.removeChild(host);
  });

  it("Cancel imports nothing and never downsamples", async () => {
    setup();
    const { host, root } = await renderWorkspace();
    const big = new File([new Uint8Array(IMAGE_IMPORT_LIMIT_BYTES + 1024)], "Big Photo.png", { type: "image/png" });
    await dropFile(host, big);
    await flush();
    const cancel = confirmButton("Cancel");
    expect(cancel, "oversize popup shown").toBeTruthy();
    await act(async () => { cancel!.click(); await new Promise((r) => setTimeout(r, 30)); });
    await flush();
    expect(downsampleImage).not.toHaveBeenCalled();
    expect(addReferenceImage).not.toHaveBeenCalled();
    expect(document.body.querySelector(".name-prompt-input")).toBeNull();
    expect(refNames()).toEqual(["Existing"]);
    await act(async () => { root.unmount(); }); document.body.removeChild(host);
  });

  it("an under-limit drop imports as before, with no popup and no downsample", async () => {
    setup();
    const { host, root } = await renderWorkspace();
    await dropFile(host, new File(["small"], "Small.png", { type: "image/png" }));
    await flush();
    // The save-reference popup shares the .confirm-layer backdrop class, so
    // assert on the oversize popup's own text, not the layer's presence.
    const titles = Array.from(document.body.querySelectorAll(".confirm-layer h3")).map((h) => h.textContent);
    expect(titles).not.toContain(OVERSIZE_IMAGE_MESSAGE);
    await confirmSavePopup();
    expect(downsampleImage).not.toHaveBeenCalled();
    expect(addReferenceImage).toHaveBeenCalledTimes(1);
    expect(addReferenceImage.mock.calls[0][2]).toBe("data:image/png;base64,T1JJR0lOQUw=");
    expect(refNames()).toEqual(["Existing", "Small"]);
    await act(async () => { root.unmount(); }); document.body.removeChild(host);
  });
});
