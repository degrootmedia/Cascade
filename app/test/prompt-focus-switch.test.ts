/**
 * Regression: with Magic Prompt on, the side-panel prompt gets stuck showing
 * the wrong frame after an edit is followed by a quick frame switch.
 *
 * Root cause: async completions in ProductionWorkspace (`updateShotStyle`,
 * `setBrandForShot`) write `setFocusedPrompt` for a shot that is no longer
 * focused — a stale-closure guard (`updateShotStyle`) or no guard at all
 * (`setBrandForShot`) — clobbering the newly selected frame's text while the
 * selection highlight correctly moves on. Neither path syncs the prompt cache,
 * so the stale text persists.
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

let disk: Record<string, unknown> | null = null;
// Deferred saveProduction so tests can interleave a frame switch mid-flight.
let resolveSave: (() => void) | null = null;
// When true, updateBoardPrompt never resolves — models a save stuck behind a
// long-running per-production generation job.
let hangUpdate = false;

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
    magicEnabled: true,
    magicPrompts: { s1: "Magic one.", s2: "Magic two." },
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
  };
}

function styleTextFor(p: Record<string, unknown>, shot: Record<string, unknown>): string {
  if (shot.styleNone) return "";
  const styles = (p.styles ?? []) as Array<{ id: string; prompt: string }>;
  const id = (shot.style as string | undefined) ?? styles[0]?.id ?? "";
  return styles.find((s) => s.id === id)?.prompt.trim() ?? "";
}

function effectivePrompt(p: Record<string, unknown>, shotId: string): string {
  const shot = (p.scenes as Array<{ shots: Array<Record<string, unknown>> }>).flatMap((s) => s.shots).find((s) => s.id === shotId);
  if (!shot) return "";
  if (p.magicEnabled && ((p.magicPrompts as Record<string, string>)?.[shotId] ?? "").trim()) {
    const style = styleTextFor(p, shot);
    return `${style ? `Style: ${style}\n\n` : ""}${((p.magicPrompts as Record<string, string>)[shotId] as string).trim()}`;
  }
  return String(shot.prompt ?? shot.visual ?? "");
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
    getBoardPrompt: async (_id: string, shotId: string) => effectivePrompt(disk ?? freshProd(), shotId),
    saveProduction: async (p: Record<string, unknown>) => {
      // Deferred: the test resolves the in-flight save after switching frames.
      await new Promise<void>((res) => { resolveSave = () => res(); });
      disk = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
    },
    getMcpStatus: async () => [],
    listOpenArtModels: async () => [],
    getMediaProvider: async () => "openart",
    listMediaProviders: async () => [{ id: "openart", displayName: "OpenArt", available: true }],
    listModels: async () => [],
    getSettings: async () => ({}),
    updateBoardPrompt: async (_id: string, shotId: string, prompt: string) => {
      if (hangUpdate) await new Promise<void>(() => {});
      if (!disk) return null;
      const shot = (disk.scenes as Array<{ shots: Array<Record<string, unknown>> }>).flatMap((s) => s.shots).find((s) => s.id === shotId);
      if (shot) {
        (disk.magicPrompts as Record<string, string>)[shotId] = prompt;
      }
      return disk;
    },
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

async function mount(): Promise<{ host: HTMLDivElement; root: ReturnType<typeof createRoot> }> {
  disk = freshProd();
  resolveSave = null;
  hangUpdate = false;
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

function panelText(host: HTMLDivElement): string {
  return host.querySelector(".prod-prompt-sidepanel")?.textContent ?? "";
}

function selectedIndex(host: HTMLDivElement): number {
  const cards = host.querySelectorAll(".prod-board");
  for (let i = 0; i < cards.length; i++) {
    if (cards[i].classList.contains("selected")) return i;
  }
  return -1;
}

describe("side-panel prompt follows frame switches after edits (magic on)", () => {
  it("a style change resolving after a frame switch must not clobber the new frame", async () => {
    const { host, root } = await mount();
    await clickFrame(host, 0);
    expect(panelText(host)).toContain("Magic one.");

    // Change s1's render style — the save stays in flight.
    const select = host.querySelector(".prod-prompt-sidepanel select.prod-prompt-style") as HTMLSelectElement;
    expect(select).toBeTruthy();
    await act(async () => {
      const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), "value")?.set;
      proto?.call(select, "st2");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(resolveSave).toBeTruthy();

    // Switch to s2 BEFORE the style save resolves.
    await clickFrame(host, 1);
    expect(selectedIndex(host)).toBe(1);
    expect(panelText(host)).toContain("Magic two.");

    // The s1 save now resolves — its refresh must not overwrite s2's editor.
    await act(async () => { resolveSave?.(); await new Promise((r) => setTimeout(r, 30)); });
    expect(selectedIndex(host)).toBe(1);
    expect(panelText(host)).toContain("Magic two.");
    expect(panelText(host)).not.toContain("Magic one.");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("a brand toggle resolving after a frame switch must not clobber the new frame", async () => {
    const { host, root } = await mount();
    await clickFrame(host, 0);
    expect(panelText(host)).toContain("Magic one.");

    // Toggle s1's brand checkbox — the save stays in flight.
    const checkbox = host.querySelector(".prod-prompt-sidepanel .prod-brand-toggle input") as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    await act(async () => {
      checkbox.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(resolveSave).toBeTruthy();

    // Switch to s2 BEFORE the brand save resolves.
    await clickFrame(host, 1);
    expect(selectedIndex(host)).toBe(1);
    expect(panelText(host)).toContain("Magic two.");

    // The s1 save now resolves — its refresh must not overwrite s2's editor.
    await act(async () => { resolveSave?.(); await new Promise((r) => setTimeout(r, 30)); });
    expect(selectedIndex(host)).toBe(1);
    expect(panelText(host)).toContain("Magic two.");
    expect(panelText(host)).not.toContain("Magic one.");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("publishes node-graph composer edits to the side panel live", async () => {
    const { host, root } = await mount();
    await clickFrame(host, 0);
    expect(panelText(host)).toContain("Magic one.");

    const nodesBtn = host.querySelector(".prod-graph-open") as HTMLButtonElement;
    expect(nodesBtn).toBeTruthy();
    await act(async () => { nodesBtn.click(); await new Promise((r) => setTimeout(r, 80)); });

    const editor = host.querySelector(".prod-graph-composer .prompt-content-editor") as HTMLElement;
    expect(editor).toBeTruthy();
    expect(editor.textContent).toContain("Magic one.");

    // Edit the composer. The side panel shares the same prompt, so it must
    // update live — not only after the composer blurs.
    await act(async () => {
      editor.textContent = "GRAPH EDIT";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelector(".prod-graph-composer")?.textContent).toContain("GRAPH EDIT");
    expect(panelText(host)).toContain("GRAPH EDIT");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("a frame switch still loads the new prompt while a save is stuck behind a generation job", async () => {
    const { host, root } = await mount();
    await clickFrame(host, 0);
    expect(panelText(host)).toContain("Magic one.");

    // Type in s1's side-panel content box; the resulting save hangs (as if
    // queued behind a long magic-prompt generation in main).
    hangUpdate = true;
    const editor = host.querySelector(".prod-prompt-sidepanel .prompt-content-editor") as HTMLElement;
    expect(editor).toBeTruthy();
    await act(async () => {
      editor.textContent = "typed into one";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    // Switch to s2 before the stuck save ever resolves.
    await clickFrame(host, 1);
    // Give the bounded read-wait (300ms) time to expire and load s2.
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
    expect(selectedIndex(host)).toBe(1);
    expect(panelText(host)).toContain("Magic two.");
    expect(panelText(host)).not.toContain("typed into one");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("keeps a side-panel magic edit after switching away and back", async () => {
    const { host, root } = await mount();
    await clickFrame(host, 0);
    expect(panelText(host)).toContain("Magic one.");

    // Edit s1's magic content directly in the side panel.
    const editor = host.querySelector(".prod-prompt-sidepanel .prompt-content-editor") as HTMLElement;
    expect(editor).toBeTruthy();
    await act(async () => {
      editor.textContent = "EDITED ONE";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
    });

    // Away to s2, then back to s1.
    await clickFrame(host, 1);
    expect(panelText(host)).toContain("Magic two.");
    await clickFrame(host, 0);

    expect(panelText(host)).toContain("EDITED ONE");
    expect(panelText(host)).not.toContain("Magic two.");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("keeps a side-panel magic edit after a frame round-trip with the graph open", async () => {
    const { host, root } = await mount();
    await clickFrame(host, 0);

    const nodesBtn = host.querySelector(".prod-graph-open") as HTMLButtonElement;
    expect(nodesBtn).toBeTruthy();
    await act(async () => { nodesBtn.click(); await new Promise((r) => setTimeout(r, 80)); });

    // Edit s1's magic content in the side panel while the graph is open.
    const editor = host.querySelector(".prod-prompt-sidepanel .prompt-content-editor") as HTMLElement;
    expect(editor).toBeTruthy();
    await act(async () => {
      editor.textContent = "EDITED ONE";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
    });

    // Away to s2, then back to s1.
    await clickFrame(host, 1);
    await clickFrame(host, 0);

    const graphText = host.querySelector(".prod-graph-composer")?.textContent ?? "";
    expect(graphText).toContain("EDITED ONE");
    expect(panelText(host)).toContain("EDITED ONE");
    expect(panelText(host)).not.toContain("Magic two.");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});
