/**
 * Regression tests for losing prompt editing in the embedded node view.
 *
 * 1. Escape while typing in a node prompt must only yield focus (committing the
 *    draft) — never close the whole canvas.
 * 2. A sequence segment prompt edit must survive blur even when the parent
 *    echo lags behind (async save/rebase); reverting to the stale value — and
 *    poisoning the echo-suppression set with it — discarded the edit forever.
 * 3. A stale detached-window lock (missed `window:detachedClosed`) must
 *    self-heal when the embedded canvas is reopened, instead of staying
 *    read-only ("Editing in separate window") until reload.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import {
  NodeGraphModal,
  SegmentPromptBox,
} from "../src/renderer/src/components/NodeGraphModal.js";
import { ProductionWorkspace } from "../src/renderer/src/components/ProductionWorkspace.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as Record<string, unknown>).ResizeObserver ??= ROStub;
(globalThis as Record<string, unknown>).requestAnimationFrame ??= (() => 0) as never;
(globalThis as Record<string, unknown>).cancelAnimationFrame ??= (() => {}) as never;
(globalThis as Record<string, unknown>).window ??= {};
const gWin = (globalThis as Record<string, unknown>).window as Record<string, unknown>;
gWin.cascade ??= {
  boardThumbnail: async () => null,
  videoModelOptions: async () => null,
};

const P0 = "Style: S\n\nhello world\n\nBrand identity: B";

function makeProd(prompt: string): any {
  return {
    meta: { id: "p1", name: "T" },
    currentStep: 3,
    openArt: { model: "auto", resolution: "1k" },
    styles: [],
    brand: { colors: [], font: "" },
    references: [{ id: "r1", name: "Hero", imagePath: "references/hero.png" }],
    scenes: [{ id: "sc1", name: "S", shots: [{ id: "s1", number: 1, prompt, promptManual: true, includeBrandIdentity: true, artwork: "boards/0001.jpg" }] }],
  };
}

function GraphHarness({ initial, onClose }: { initial: string; onClose: () => void }) {
  const [prompt, setPrompt] = useState(initial);
  const [prod, setProd] = useState(() => makeProd(initial));
  const onPromptChange = (v: string) => {
    setPrompt(v);
    void Promise.resolve().then(() => setProd(makeProd(v)));
  };
  return createElement(NodeGraphModal, {
    prod, shot: prod.scenes[0].shots[0], bust: 0, prompt,
    references: [{ id: "r1", name: "Hero", artwork: "data:image/png;base64,AAAA" }] as never,
    styles: [], styleValue: "", includeBrand: true,
    onPromptChange, onStyleChange: () => {}, onToggleBrand: () => {}, onDropFile: () => {},
    onStyleDetached: () => {}, imageModels: [], videoModels: [],
    defaultImageModel: "auto", defaultImageResolution: "1k",
    onRunImageGen: async () => {}, onRunVideoGen: async () => {}, onRunEditGen: async () => {},
    onSelectGraphGen: () => {}, onCycleGraphGen: () => {}, onGraphField: () => {},
    onPipeImageToVideo: () => {}, onPipeImageToOutput: () => {}, onPipeVideoToOutput: () => {}, onPipeEditToOutput: () => {}, onPipeRefToOutput: () => {},
    onUnpipeImageGen: () => {}, onUnpipeImageToVideo: () => {}, onUnpipeVideoGen: () => {}, onUnpipeEditGen: () => {}, onUnpipeOutput: () => {},
    onSaveLayout: () => {}, onClose,
  });
}

function typeIntoTextarea(el: HTMLTextAreaElement, v: string) {
  const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set
    ?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  proto?.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Escape in the node graph", () => {
  it("yields focus instead of closing the canvas while editing a prompt", async () => {
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    const onClose = vi.fn();
    await act(async () => { root.render(createElement(GraphHarness, { initial: P0, onClose })); });
    const ed = host.querySelector(".prod-graph-composer .prompt-content-editor") as HTMLElement;
    expect(ed).toBeTruthy();
    await act(async () => { ed.focus(); });
    expect(document.activeElement === ed || ed.contains(document.activeElement)).toBe(true);

    await act(async () => {
      ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector(".prod-graph-panel")).toBeTruthy();
    // Focus was yielded so the next Escape (now outside any editor) closes.
    expect(document.activeElement === ed || ed.contains(document.activeElement as Node)).toBe(false);

    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});

describe("SegmentPromptBox under a lagging parent", () => {
  async function mountBox(value: string, onChange: (shotId: string, text: string) => void) {
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    const render = (v: string) => createElement(SegmentPromptBox, { shotId: "s1", value: v, fallback: "FRAME PROMPT", onChange });
    await act(async () => { root.render(render(value)); });
    const el = host.querySelector(".prod-graph-seq-seg-prompt") as HTMLTextAreaElement;
    return { host, root, el, render };
  }

  it("keeps the edit when blur beats the parent echo", async () => {
    const onChange = vi.fn();
    const { host, root, el, render } = await mountBox("OLD", onChange);
    // Parent echo lags: it never re-renders with the typed value yet.
    await act(async () => { el.focus(); typeIntoTextarea(el, "NEW"); });
    expect(el.value).toBe("NEW");
    await act(async () => { el.dispatchEvent(new Event("focusout", { bubbles: true })); });
    // The edit must be committed, never reverted to the stale value …
    expect(onChange).toHaveBeenCalledWith("s1", "NEW");
    expect(el.value).toBe("NEW");
    // … and the late echo must converge instead of being swallowed.
    await act(async () => { root.render(render("NEW")); });
    expect(el.value).toBe("NEW");
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("snaps an emptied box back to the frame prompt", async () => {
    const onChange = vi.fn();
    const { host, root, el } = await mountBox("OLD", onChange);
    await act(async () => { el.focus(); typeIntoTextarea(el, ""); });
    expect(onChange).toHaveBeenCalledWith("s1", "");
    await act(async () => { el.dispatchEvent(new Event("focusout", { bubbles: true })); });
    expect(el.value).toBe("FRAME PROMPT");
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});

describe("stale detached-window lock", () => {
  let detachedState: { open: boolean; productionId: string | null; target: string | null; frameId: string | null; sequenceId: string | null };

  function freshProd(): Record<string, unknown> {
    return {
      meta: { id: "p1", name: "Test production", folder: "C:/test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stepDone: 0, shotCount: 1 },
      currentStep: 3,
      visualStyle: "",
      styles: [],
      brand: { colors: [], font: "" },
      scenes: [
        { id: "sc1", name: "Scene 1", shots: [{ id: "s1", number: 1, audio: "", visual: "", prompt: "hello world", artwork: "boards/0001.jpg" }] },
      ],
      characters: [],
      products: [],
      references: [],
      openArt: { model: "auto", resolution: "1k" },
      status: {},
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
      assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
    };
  }

  async function mountWorkspace() {
    const disk = freshProd();
    const stub = () => Promise.resolve();
    (globalThis.window as unknown as Record<string, unknown>).cascade = {
      boardThumbnail: async () => null,
      showImageMenu: async () => {},
      videoModelOptions: async () => null,
      videoEndFrameModels: async () => [],
      getOpenArtCredits: async () => null,
      listOpenArtModels: async () => [],
      getMediaProvider: async () => "openart",
      listMediaProviders: async () => [{ id: "openart", displayName: "OpenArt", available: true }],
      listModels: async () => [],
      getSettings: async () => ({}),
      listProductions: async () => [{ id: "p1", name: "Test production", folder: "C:/test", shotCount: 1, stepDone: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
      onProductionEvent: () => () => {},
      onBoardExternalUpdate: () => () => {},
      onReferencesExternalUpdate: () => () => {},
      checkExternalEdits: async () => {},
      loadProduction: async () => disk,
      boardImage: async () => "data:image/png;base64,AAAA",
      getBoardPrompt: async (_id: string, shotId: string) => {
        const shot = (disk.scenes as Array<{ shots: Array<Record<string, unknown>> }>).flatMap((s) => s.shots).find((s) => s.id === shotId);
        return String(shot?.prompt ?? "");
      },
      saveProduction: async (p: Record<string, unknown>) => { Object.assign(disk, JSON.parse(JSON.stringify(p))); },
      updateBoardPrompt: async () => disk,
      getMcpStatus: async () => [],
      canvasSelectionChanged: () => {},
      canvasBusyChanged: () => {},
      getDetachedCanvasState: async () => ({ ...detachedState }),
      onDetachedClosed: () => () => {},
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

  async function openGraph(host: HTMLDivElement) {
    const frames = host.querySelectorAll(".prod-board-frame") as NodeListOf<HTMLElement>;
    await act(async () => {
      frames[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
    });
    const nodesBtn = host.querySelector(".prod-graph-open") as HTMLButtonElement;
    await act(async () => { nodesBtn.click(); await new Promise((r) => setTimeout(r, 80)); });
  }

  async function closeGraph(host: HTMLDivElement) {
    const btns = [...host.querySelectorAll(".prod-graph-head .prod-btn")] as HTMLButtonElement[];
    const close = btns.find((b) => b.textContent === "Close");
    expect(close).toBeTruthy();
    await act(async () => { close!.click(); await new Promise((r) => setTimeout(r, 30)); });
  }

  const locked = () => ({ open: true, productionId: "p1", target: "graph", frameId: "s1", sequenceId: null });
  const unlocked = () => ({ open: false, productionId: null, target: null, frameId: null, sequenceId: null });

  it("a missed detached-close stops locking the embedded graph once reopened", async () => {
    detachedState = locked();
    const { host, root } = await mountWorkspace();
    await openGraph(host);
    // Stale lock (as read on mount): embedded graph is read-only.
    expect(host.querySelector(".prod-graph-readonly-note")).toBeTruthy();

    // The detached window is actually gone; main just never heard about it.
    detachedState = unlocked();
    await closeGraph(host);
    await openGraph(host);
    // Reopening re-validates against main's live state — editing is back.
    expect(host.querySelector(".prod-graph-readonly-note")).toBeNull();
    const ed = host.querySelector(".prod-graph-composer .prompt-content-editor") as HTMLElement;
    expect(ed).toBeTruthy();
    await act(async () => { ed.focus(); });
    expect(document.activeElement === ed || ed.contains(document.activeElement)).toBe(true);

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("a genuinely open detached window still locks the embedded graph", async () => {
    detachedState = locked();
    const { host, root } = await mountWorkspace();
    await openGraph(host);
    expect(host.querySelector(".prod-graph-readonly-note")).toBeTruthy();
    // Reopening while it is really open keeps the lock (no behavior change).
    await closeGraph(host);
    await openGraph(host);
    expect(host.querySelector(".prod-graph-readonly-note")).toBeTruthy();

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});
