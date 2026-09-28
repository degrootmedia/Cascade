/**
 * Shot Sequence storyboard flow (Spec 06): shift-click range selection over the
 * board cards, the "Create Shot Sequence" strip that pops up underneath, and
 * the accent bar that appears under the created span (Open Sequence, enable/
 * disable, right-click accent, delete with its preserve-the-video confirm).
 *
 * The bar layer positions from measured card rects, so the card geometry is
 * stubbed here (jsdom returns zeroed rects) — two columns, two rows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ProductionWorkspace } from "../src/renderer/src/components/ProductionWorkspace.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as Record<string, unknown>).ResizeObserver = ROStub;
(globalThis as Record<string, unknown>).requestAnimationFrame ??= (() => 0) as never;
(globalThis as Record<string, unknown>).cancelAnimationFrame ??= (() => {}) as never;
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

// Card geometry: [s1 s2 / s3 s4] as a 2-column grid of 180x120 cards with 20px
// gaps — enough for `sequenceBarSpans` to derive real per-row spans.
const CARD_RECTS: Record<string, { left: number; top: number; right: number; bottom: number }> = {
  s1: { left: 0, top: 0, right: 180, bottom: 120 },
  s2: { left: 200, top: 0, right: 380, bottom: 120 },
  s3: { left: 0, top: 140, right: 180, bottom: 260 },
  s4: { left: 200, top: 140, right: 380, bottom: 260 },
};
const ZERO = { left: 0, top: 0, right: 0, bottom: 0 };
(HTMLElement.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect = function (this: HTMLElement) {
  const r = CARD_RECTS[this.dataset?.shotId ?? ""] ?? ZERO;
  return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => ({}) } as DOMRect;
};

let disk: Record<string, unknown> | null = null;
const savedProds: Array<Record<string, unknown>> = [];
const deletedSequenceIds: string[] = [];

function freshProd(): Record<string, unknown> {
  return {
    meta: { id: "p1", name: "Test production", folder: "C:/test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stepDone: 3, shotCount: 4 },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: [{ number: 1, title: "Scene 1", shots: [
      { id: "s1", number: "0100", audio: "", visual: "A hero walks." },
      { id: "s2", number: "0200", audio: "", visual: "The door opens." },
      { id: "s3", number: "0300", audio: "", visual: "A storm gathers." },
      { id: "s4", number: "0400", audio: "", visual: "Dawn breaks." },
    ] }],
    characters: [],
    products: [],
    references: [],
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
    listProductions: async () => [{ id: "p1", name: "Test production", folder: "C:/test", shotCount: 4, stepDone: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    onProductionEvent: () => () => {},
    onBoardExternalUpdate: () => () => {},
    onReferencesExternalUpdate: () => () => {},
    checkExternalEdits: async () => {},
    loadProduction: async () => disk,
    saveProduction: async (p: Record<string, unknown>) => { disk = JSON.parse(JSON.stringify(p)) as Record<string, unknown>; savedProds.push(disk); },
    deleteShotSequence: async (_id: string, sequenceId: string) => {
      deletedSequenceIds.push(sequenceId);
      if (disk) {
        const seqs = (disk.shotSequences as Array<{ id: string }> | undefined) ?? [];
        (disk as { shotSequences?: unknown }).shotSequences = seqs.filter((s) => s.id !== sequenceId);
      }
      return disk;
    },
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

async function renderWorkspace(): Promise<{ host: HTMLElement; root: Root }> {
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

async function clickFrame(host: HTMLElement, shotId: string, shift = false): Promise<void> {
  const card = host.querySelector(`[data-shot-id="${shotId}"]`) as HTMLElement;
  const frame = card.querySelector(".prod-board-frame") as HTMLElement;
  await act(async () => {
    frame.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: shift }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function cards(host: HTMLElement, cls: string): string[] {
  return Array.from(host.querySelectorAll(`.prod-board.${cls}`)).map((c) => c.getAttribute("data-shot-id") ?? "?");
}

function sequencesOnDisk(): Array<Record<string, unknown>> {
  return (disk?.shotSequences as Array<Record<string, unknown>> | undefined) ?? [];
}

describe("shot sequence storyboard flow", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    disk = freshProd();
    savedProds.length = 0;
    deletedSequenceIds.length = 0;
    (globalThis as Record<string, unknown>).confirm = () => true;
    (globalThis.window as unknown as Record<string, unknown>).confirm = () => true;
    (globalThis.window as unknown as Record<string, unknown>).cascade = cascadeMock();
    ({ host, root } = await renderWorkspace());
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); await new Promise((r) => setTimeout(r, 0)); });
    host.remove();
  });

  it("shift-click builds a contiguous range and the create strip pops up underneath", async () => {
    await clickFrame(host, "s1");
    expect(cards(host, "selected")).toEqual(["s1"]);
    expect(host.querySelector(".seq-create-strip")).toBeNull();

    await clickFrame(host, "s3", true);
    expect(cards(host, "in-range").sort()).toEqual(["s1", "s2", "s3"]);
    // The prompt panel stays on the anchor (the plain-clicked frame).
    expect(cards(host, "selected")).toEqual(["s1"]);
    const strip = host.querySelector(".seq-create-strip") as HTMLElement;
    expect(strip).toBeTruthy();
    expect(strip.textContent).toContain("Create Shot Sequence");
    expect(strip.textContent).toContain("3 frames selected");
  });

  it("creates a sequence over the range and shows its accent bar", async () => {
    await clickFrame(host, "s1");
    await clickFrame(host, "s3", true);
    await act(async () => {
      (host.querySelector(".seq-create-button") as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(sequencesOnDisk()).toHaveLength(1);
    const seq = sequencesOnDisk()[0];
    expect(seq).toMatchObject({ name: "Sequence 01", shotIds: ["s1", "s2", "s3"], enabled: true });
    // Pre-populated: a video generator node plus a timed timeline (one segment
    // per member frame). Unbound until the user pipes the output node (so the
    // animatic starts as the slate).
    const graph = seq.graph as { graphVideoNodes?: Array<{ prompt?: string }>; graphSequence?: { segments?: Array<{ shotId: string; durationSec: number }> }; graphOutputSource?: string };
    expect(graph.graphVideoNodes![0].prompt).toBe("");
    expect(graph.graphSequence!.segments).toEqual([
      { shotId: "s1", durationSec: 3, prompt: "" },
      { shotId: "s2", durationSec: 3, prompt: "" },
      { shotId: "s3", durationSec: 3, prompt: "" },
    ]);
    expect(graph.graphOutputSource).toBeUndefined();
    expect(typeof seq.accent).toBe("string");
    // The strip is gone, the bar is under the span.
    expect(host.querySelector(".seq-create-strip")).toBeNull();
    const bar = host.querySelector(".seq-bar") as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.textContent).toContain("Sequence 01");
    expect(bar.textContent).toContain("3 frames");
    expect(host.querySelector(".seq-bar-open")).toBeTruthy();
    // Cards open the bottom slot for the bar.
    expect(cards(host, "seq-slot").sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("disables and recolors a sequence from the bar", async () => {
    await clickFrame(host, "s1");
    await clickFrame(host, "s2", true);
    await act(async () => {
      (host.querySelector(".seq-create-button") as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      (host.querySelector(".seq-bar-toggle") as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(sequencesOnDisk()[0].enabled).toBe(false);
    expect((host.querySelector(".seq-bar") as HTMLElement).className).toContain("disabled");

    const bar = host.querySelector(".seq-bar") as HTMLElement;
    await act(async () => {
      bar.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const swatches = host.querySelectorAll(".seq-accent-swatch");
    expect(swatches.length).toBeGreaterThan(1);
    await act(async () => {
      (swatches[2] as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(sequencesOnDisk()[0].accent).toBeTruthy();
    expect(sequencesOnDisk()[0].accent).not.toBe("blue");
    expect(host.querySelector(".seq-accent-menu")).toBeNull();
  });

  it("deletes a sequence through the main-side op (clip preserved there)", async () => {
    await clickFrame(host, "s1");
    await clickFrame(host, "s2", true);
    await act(async () => {
      (host.querySelector(".seq-create-button") as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    const seqId = sequencesOnDisk()[0].id as string;

    await act(async () => {
      (host.querySelector(".seq-bar-delete") as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(deletedSequenceIds).toEqual([seqId]);
    expect(sequencesOnDisk()).toHaveLength(0);
    expect(host.querySelector(".seq-bar")).toBeNull();
  });

  it("refuses a span that overlaps an existing sequence", async () => {
    await clickFrame(host, "s1");
    await clickFrame(host, "s2", true);
    await act(async () => {
      (host.querySelector(".seq-create-button") as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 0));
    });

    await clickFrame(host, "s2");
    await clickFrame(host, "s3", true);
    const strip = host.querySelector(".seq-create-strip") as HTMLElement;
    expect(strip.textContent).toContain("already belongs");
    expect(host.querySelector(".seq-create-button")).toBeNull();
  });

  it("Esc clears the range and a plain click re-anchors", async () => {
    await clickFrame(host, "s1");
    await clickFrame(host, "s3", true);
    expect(cards(host, "in-range")).toHaveLength(3);

    await act(async () => {
      const ev = new Event("keydown", { bubbles: true, cancelable: true }) as Event & { key: string };
      ev.key = "Escape";
      window.dispatchEvent(ev);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(cards(host, "in-range")).toHaveLength(0);
    expect(host.querySelector(".seq-create-strip")).toBeNull();

    await clickFrame(host, "s1");
    await clickFrame(host, "s3", true);
    await clickFrame(host, "s4");
    expect(cards(host, "in-range")).toHaveLength(0);
    expect(cards(host, "selected")).toEqual(["s4"]);
    expect(host.querySelector(".seq-create-strip")).toBeNull();
  });
});
