/**
 * Item 4 regression (workspace half): right-click "Edit in Suite" from the
 * node graph fired `openImageSuite`, which flipped the step content to the
 * suite but left `graphShotId` set — the graph was merely unmounted with
 * the steps and popped back open the moment the user left the suite, and
 * the handed-off edit source could be shadowed by a stale draft source
 * (the suite half is pinned in suite-prompt-display.test.ts). Opening the
 * suite must actually close the graph/sequence canvas and land in the
 * suite editor with the handed-off image as the edit source.
 *
 * Harness adapted from frame-drop.test.ts (same workspace fake).
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ProductionWorkspace } from "../src/renderer/src/components/ProductionWorkspace.js";
import { openImageSuite } from "../src/renderer/src/features/suite/suite-handoff.js";

vi.mock("../src/renderer/src/components/NamePromptDialog.js", () => ({
  askName: async () => null,
  askReferenceSave: async (opts: { initialName: string }) => ({ name: opts.initialName }),
  NamePromptHost: () => null,
}));

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as Record<string, unknown>).ResizeObserver = ROStub;
(globalThis as Record<string, unknown>).requestAnimationFrame ??= (() => 0) as never;
(globalThis as Record<string, unknown>).cancelAnimationFrame ??= (() => {}) as never;
// openImageSuite dispatches a bare-global CustomEvent on window; in this
// harness the global and jsdom's are different constructors, so align them.
(globalThis as Record<string, unknown>).CustomEvent = (globalThis as any).window.CustomEvent;

let disk: Record<string, unknown> | null = null;

function freshProd(): Record<string, unknown> {
  return {
    meta: { id: "p1", name: "Test production", folder: "C:/test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stepDone: 0, shotCount: 2 },
    currentStep: 3,
    visualStyle: "",
    styles: [{ id: "st1", index: 1, name: "Heroic", prompt: "Heroic 3D render style" }],
    brand: { colors: ["#123456"], font: "" },
    scenes: [
      {
        id: "sc1", name: "Scene 1",
        shots: [
          { id: "s1", number: 1, audio: "", visual: "A hero walks through the valley.", artwork: "boards/0001.jpg" },
          { id: "s2", number: 2, audio: "", visual: "The villain appears on the ridge.", artwork: "boards/0002.jpg" },
        ],
      },
    ],
    characters: [],
    products: [],
    references: [],
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
    modelOptions: async () => null,
    imageModelOptions: async () => null,
    videoEndFrameModels: async () => [],
    getOpenArtCredits: async () => null,
    listProductions: async () => [{ id: "p1", name: "Test production", folder: "C:/test", shotCount: 2, stepDone: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    onProductionEvent: () => () => {},
    onBoardExternalUpdate: () => () => {},
    onReferencesExternalUpdate: () => () => {},
    checkExternalEdits: async () => {},
    loadProduction: async () => disk,
    boardImage: async () => "data:image/png;base64,AAAA",
    getBoardPrompt: async () => "Style: Heroic 3D render style\n\nA hero walks through the valley.",
    saveProduction: async (p: Record<string, unknown>) => { disk = JSON.parse(JSON.stringify(p)) as Record<string, unknown>; },
    updateGraphShotFields: async (_id: string, shotId: string, patch: Record<string, unknown>) => { const prod = disk as unknown as { scenes: Array<{ shots: Array<Record<string, unknown>> }> } | null; if (!prod) return disk; const shot = prod.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId); if (shot) { for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete shot[k]; else shot[k] = JSON.parse(JSON.stringify(v)); } } return disk; },
    getMcpStatus: async () => [],
    listOpenArtModels: async () => [{ id: "openart:x", displayName: "X", description: "", imageInput: true, videoInput: false, cost: null }],
    getMediaProvider: async () => "openart",
    listMediaProviders: async () => [{ id: "openart", displayName: "OpenArt", available: true }],
    listModels: async () => [],
    getSettings: async () => ({}),
    loadSuiteSession: async () => ({ version: 1, entries: [], selectedId: null, draft: { mode: "generate", prompt: "", model: "", resolution: "1k", refIds: [] } }),
    saveSuiteSession: async (_id: string, s: unknown) => s,
    updateBoardPrompt: async () => disk,
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
  };
}

describe("Edit in Suite from the node graph (Item 4)", () => {
  it("closes the covering graph and opens the suite editor on the handed-off frame", async () => {
    disk = freshProd();
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

    // Focus a shot and open its node graph (the covering modal).
    const frames = host.querySelectorAll(".prod-board-frame") as NodeListOf<HTMLElement>;
    await act(async () => {
      frames[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const nodesBtn = host.querySelector(".prod-graph-open") as HTMLButtonElement;
    expect(nodesBtn).toBeTruthy();
    await act(async () => { nodesBtn.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(host.querySelector(".prod-graph-composer")).toBeTruthy();

    // The graph take menu's "Edit in Suite" action.
    await act(async () => {
      openImageSuite("p1", { mode: "edit", sourcePath: "boards/0001.jpg" });
      await new Promise((r) => setTimeout(r, 0));
    });

    // The graph is gone and the suite editor is up, on the handed-off frame.
    expect(host.querySelector(".prod-graph-composer")).toBeNull();
    expect(host.querySelector(".suite")).toBeTruthy();
    const selectedSource = host.querySelector(".suite-edit-source.selected .suite-edit-source-name")?.textContent ?? "";
    expect(selectedSource).toContain("boards/0001.jpg");
    expect(host.querySelector(".suite-canvas-before")).toBeTruthy();

    // Leaving the suite (back to the storyboard step) must not resurrect
    // the graph the handoff closed.
    const stepBtn = Array.from(host.querySelectorAll<HTMLButtonElement>("button.prod-step"))
      .find((b) => (b.textContent ?? "").includes("Storyboard"));
    expect(stepBtn).toBeTruthy();
    await act(async () => { stepBtn!.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(host.querySelector(".suite")).toBeNull();
    expect(host.querySelector(".prod-graph-composer")).toBeNull();

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});
