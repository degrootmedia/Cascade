/**
 * Regression: changing the style plugged into a graph node blanked the
 * composer prompt for auto-derived shots until the graph was closed and
 * reopened.
 *
 * Root cause (PromptContentEditor): the external-change effect deferred
 * rebuilding the box whenever the caret lived inside it (`inBox`) — but the
 * rebuild path itself restores a caret into the box even while the box is
 * UNFOCUSED, so a later external change (the style-swap's authoritative
 * refetch) was wrongly deferred forever. The side panel does not defer, which
 * is why it stayed correct while the composer went blank. Fix: require the box
 * (or a chip inside it) to actually hold focus before deferring.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ProductionWorkspace } from "../src/renderer/src/components/ProductionWorkspace.js";
import { renderShotPrompt } from "../src/shared/graph/render.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as Record<string, unknown>).ResizeObserver = ROStub;
(globalThis as Record<string, unknown>).requestAnimationFrame ??= (() => 0) as never;
(globalThis as Record<string, unknown>).cancelAnimationFrame ??= (() => {}) as never;

let disk: Record<string, unknown> | null = null;
let boardPromptDelayMs = 0;

function freshProd(): Record<string, unknown> {
  return {
    meta: { id: "p1", name: "Test production", folder: "C:/test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stepDone: 0, shotCount: 2 },
    currentStep: 3,
    visualStyle: "",
    styles: [
      { id: "st1", index: 1, name: "Heroic", prompt: "Heroic 3D render style" },
      { id: "st2", index: 2, name: "Noir", prompt: "Noir black-and-white style" },
    ],
    brand: { colors: ["#123456"], font: "" },
    scenes: [
      {
        id: "sc1", name: "Scene 1",
        // No manual prompt: the board prompt is auto-derived from `visual`.
        shots: [
          { id: "s1", number: 1, audio: "", visual: "A hero walks through the valley.", artwork: "boards/0001.jpg", styleNone: true },
          { id: "s2", number: 2, audio: "", visual: "The villain appears on the ridge.", artwork: "boards/0002.jpg", styleNone: true },
        ],
      },
    ],
    characters: [],
    products: [],
    references: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    magicEnabled: false,
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
  };
}

function effectivePrompt(p: Record<string, unknown>, shotId: string): string {
  const shot = (p.scenes as Array<{ shots: Array<Record<string, unknown>> }>).flatMap((s) => s.shots).find((s) => s.id === shotId);
  if (!shot) return "";
  // Mirror main's effectivePrompt: a manual prompt renders from the graph; an
  // auto shot falls back to the derived board prompt (visual/audio).
  const magic = (p.magicPrompts as Record<string, string> | undefined)?.[shotId];
  if (p.magicEnabled && magic?.trim()) {
    const styles = (p.styles ?? []) as Array<{ id: string; prompt: string }>;
    const style = shot.styleNone ? "" : (styles.find((s) => s.id === shot.style)?.prompt ?? styles[0]?.prompt ?? "");
    return `${style ? `Style: ${style}\n\n` : ""}${magic.trim()}`;
  }
  if (shot.prompt) return renderShotPrompt(p as never, shot as never, "composer");
  return String(shot.visual ?? "");
}

function cascadeMock(): Record<string, unknown> {
  const stub = () => Promise.resolve();
  return {
    boardThumbnail: async () => null,
    showImageMenu: async () => {},
    videoModelOptions: async () => null,
    videoEndFrameModels: async () => [],
    getOpenArtCredits: async () => null,
    listProductions: async () => [{ id: "p1", name: "Test production", folder: "C:/test", shotCount: 2, stepDone: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    onProductionEvent: () => () => {},
    onBoardExternalUpdate: () => () => {},
    onReferencesExternalUpdate: () => () => {},
    checkExternalEdits: async () => {},
    loadProduction: async () => disk,
    boardImage: async () => "data:image/png;base64,AAAA",
    getBoardPrompt: async (_id: string, shotId: string) => { if (boardPromptDelayMs) await new Promise((r) => setTimeout(r, boardPromptDelayMs)); return effectivePrompt(disk ?? freshProd(), shotId); },
    saveProduction: async (p: Record<string, unknown>) => { disk = JSON.parse(JSON.stringify(p)) as Record<string, unknown>; },
    updateGraphShotFields: async (_id: string, shotId: string, patch: Record<string, unknown>) => { const prod = disk as unknown as { scenes: Array<{ shots: Array<Record<string, unknown>> }> } | null; if (!prod) return disk; const shot = prod.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId); if (shot) { for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete shot[k]; else shot[k] = JSON.parse(JSON.stringify(v)); } } return disk; },
    getMcpStatus: async () => [],
    listOpenArtModels: async () => [],
    getMediaProvider: async () => "openart",
    listMediaProviders: async () => [{ id: "openart", displayName: "OpenArt", available: true }],
    listModels: async () => [],
    getSettings: async () => ({}),
    updateBoardPrompt: async (_id: string, shotId: string, prompt: string) => {
      if (!disk) return null;
      const shot = (disk.scenes as Array<{ shots: Array<Record<string, unknown>> }>).flatMap((s) => s.shots).find((s) => s.id === shotId);
      if ((disk as Record<string, unknown>).magicEnabled) {
        ((disk as Record<string, unknown>).magicPrompts as Record<string, string>)[shotId] = prompt;
      } else if (shot) shot.prompt = prompt;
      return disk;
    },
    generateBoards: stub, regenerateBoards: stub, exportBoardPrompts: stub, saveBoardPrompts: stub,
    importBoards: stub, pickBoardImages: stub, editBoard: stub,
    generateFrameNode: stub, generateVideoNode: stub, generateEditNode: stub,
    applyGraphOutput: stub, applyGraphRefOutput: stub,
    addReferenceMedia: stub, removeReferenceFile: stub,
    importVoiceover: stub, voiceoverFile: stub, importMusic: stub, musicFile: stub, removeMusic: stub, removeVoiceover: stub,
    pickReferenceImage: stub, refineStylePrompt: stub, styleFromImage: stub, generateMagicPrompts: stub,
    setMagicEnabled: stub, ingestScript: stub, createProduction: stub,
    removeProduction: stub, pickProductionFolder: stub, pickScriptFile: stub,
    reorderShot: stub, promoteBoardHistory: stub, recheckBoard: stub, removeVideo: stub,
  };
}

function freshMagicProd(): Record<string, unknown> {
  return {
    ...freshProd(),
    magicEnabled: true,
    magicPrompts: { s1: "Magic one.", s2: "Magic two." },
    scenes: [
      {
        id: "sc1", name: "Scene 1",
        shots: [
          { id: "s1", number: 1, audio: "", visual: "A hero walks through the valley.", artwork: "boards/0001.jpg", prompt: "Original one.", style: "st1" },
          { id: "s2", number: 2, audio: "", visual: "The villain appears on the ridge.", artwork: "boards/0002.jpg", prompt: "Original two.", style: "st1" },
        ],
      },
    ],
  };
}

async function mount(prodFactory: () => Record<string, unknown> = freshProd): Promise<{ host: HTMLDivElement; root: ReturnType<typeof createRoot> }> {
  disk = prodFactory();
  boardPromptDelayMs = 0;
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

async function clickFrame(host: HTMLDivElement, index: number): Promise<void> {
  const frames = host.querySelectorAll(".prod-board-frame") as NodeListOf<HTMLElement>;
  await act(async () => {
    frames[index].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
}

async function changeStyle(host: HTMLDivElement, styleId: string): Promise<void> {
  const sel = host.querySelector(".prod-graph-style select") as HTMLSelectElement;
  expect(sel).toBeTruthy();
  await act(async () => {
    const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sel), "value")?.set;
    proto?.call(sel, styleId);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
  });
}

describe("changing the graph style keeps the composer prompt", () => {
  it("keeps an auto-derived prompt after a style change", async () => {
    const { host, root } = await mount();
    await clickFrame(host, 0);

    const nodesBtn = host.querySelector(".prod-graph-open") as HTMLButtonElement;
    await act(async () => { nodesBtn.click(); await new Promise((r) => setTimeout(r, 80)); });

    const composer = () => host.querySelector(".prod-graph-composer .prompt-content-editor") as HTMLElement | null;
    expect(composer()?.textContent ?? "").toContain("A hero walks through the valley.");

    await changeStyle(host, "st1");
    expect(composer()?.textContent ?? "").toContain("A hero walks through the valley.");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("keeps the Magic Prompt when the style changes on the node canvas (Notion Bugs #2)", async () => {
    boardPromptDelayMs = 0;
    const { host, root } = await mount(freshMagicProd);
    await clickFrame(host, 0);

    const nodesBtn = host.querySelector(".prod-graph-open") as HTMLButtonElement;
    await act(async () => { nodesBtn.click(); await new Promise((r) => setTimeout(r, 80)); });

    const composerText = () => host.querySelector(".prod-graph-composer .prompt-content-editor")?.textContent ?? "";
    const composerNodeText = () => host.querySelector(".prod-graph-composer")?.textContent ?? "";
    expect(composerText()).toContain("Magic one.");
    expect(composerText()).not.toContain("Original one.");

    // Change the style from the Style node. Hold the authoritative prompt
    // refetch back (a busy main process / queued read): the local re-render
    // after a style swap must already be correct on its own.
    boardPromptDelayMs = 5000;
    const sel = host.querySelector(".prod-graph-style select") as HTMLSelectElement;
    expect(sel).toBeTruthy();
    await act(async () => {
      const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sel), "value")?.set;
      proto?.call(sel, "st2");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(composerText()).toContain("Magic one.");
    expect(composerText()).not.toContain("Original one.");
    expect(composerNodeText()).toContain("Noir black-and-white style");

    // Click into the composer and back out: the stored magic entry must
    // survive the blur-commit too (it must not be overwritten by the
    // original prompt).
    const editor = host.querySelector(".prod-graph-composer .prompt-content-editor") as HTMLElement;
    await act(async () => { editor.focus(); await new Promise((r) => setTimeout(r, 450)); });
    expect(composerText()).toContain("Magic one.");
    await act(async () => {
      editor.dispatchEvent(new Event("focusout", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
    });
    const stored = ((disk as Record<string, unknown>).magicPrompts as Record<string, string>).s1;
    expect(stored).toContain("Magic one.");
    expect(stored).not.toContain("Original one.");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("keeps typed content when the style changes while the composer is focused", async () => {
    const { host, root } = await mount();
    await clickFrame(host, 0);

    const nodesBtn = host.querySelector(".prod-graph-open") as HTMLButtonElement;
    await act(async () => { nodesBtn.click(); await new Promise((r) => setTimeout(r, 80)); });

    const editor = host.querySelector(".prod-graph-composer .prompt-content-editor") as HTMLElement;
    editor.focus();
    await act(async () => {
      editor.textContent = "A hero walks. And runs.";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });

    await changeStyle(host, "st1");
    expect(editor.textContent ?? "").toContain("A hero walks. And runs.");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});
