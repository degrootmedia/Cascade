/**
 * Reproduction for the frame-over-frame drag bug: dropping a completed board
 * frame onto another frame's card must (a) create a reference AND (b) tag the
 * destination shot's prompt with `@[Frame NNNN]`. The reference is reported
 * created but the tag is not reaching the prompt.
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
const savedProds: Array<Record<string, unknown>> = [];

const AUTO_PROMPT = "Style: Heroic 3D render style\n\nBrand identity: Color palette: #123456.\n\nA hero walks through the valley.";

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

function effectivePrompt(p: Record<string, unknown>, shotId: string): string {
  const shot = (p.scenes as Array<{ shots: Array<Record<string, unknown>> }>).flatMap((s) => s.shots).find((s) => s.id === shotId);
  if (!shot) return "";
  if (p.magicEnabled && (p.magicPrompts as Record<string, string>)?.[shotId]?.trim()) {
    // Mirror main's effectivePrompt magic branch: Style → Brand → content.
    return `Style: Heroic 3D render style\n\nBrand identity: Color palette: #123456.\n\n${(p.magicPrompts as Record<string, string>)[shotId].trim()}`;
  }
  const manual = (shot.prompt as string | undefined)?.trim();
  if (manual) return manual;
  return AUTO_PROMPT;
}

function cascadeMock(): Record<string, unknown> {
  const stub = () => Promise.resolve();
  const api: Record<string, unknown> = {
    boardThumbnail: async () => null,
    showImageMenu: async () => {},
    videoModelOptions: async () => null,
    videoEndFrameModels: async () => [],
    getOpenArtCredits: async () => null,
    listProductions: async () => [{ id: "p1", name: "Test production", folder: "C:/test", shotCount: 2, stepDone: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    onProductionEvent: () => () => {},
    onBoardExternalUpdate: () => () => {},
    checkExternalEdits: async () => {},
    loadProduction: async () => disk,
    boardImage: async () => "data:image/png;base64,AAAA",
    addReferenceImage: async () => ({ path: "references/Frame 0001.png" }),
    getBoardPrompt: async (_id: string, shotId: string) => effectivePrompt(disk ?? freshProd(), shotId),
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
    updateBoardPrompt: async (_id: string, shotId: string, prompt: string) => {
      if (!disk) return null;
      const shot = (disk.scenes as Array<{ shots: Array<Record<string, unknown>> }>).flatMap((s) => s.shots).find((s) => s.id === shotId);
      if (shot) { shot.prompt = prompt.trim() || undefined; shot.promptManual = !!prompt.trim(); }
      return disk;
    },
  };
  return api;
}

function dropOnTarget(): void {
  const frame = document.querySelectorAll(".prod-board-frame")[1] as HTMLElement;
  const ev = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: DataTransfer };
  ev.dataTransfer = {
    types: ["application/x-cascade-frame"],
    getData: (t: string) => t === "application/x-cascade-frame" ? JSON.stringify({ prodId: "p1", shotId: "s1", number: 1 }) : "",
  } as unknown as DataTransfer;
  frame.dispatchEvent(ev);
}

describe("frame-over-frame drop", () => {
  it("tags the destination prompt with @[Frame NNNN] and saves the reference", async () => {
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
    // Open the production → lands on the boards (step 3).
    const openBtn = host.querySelector(".prod-card-open") as HTMLButtonElement;
    expect(openBtn).toBeTruthy();
    await act(async () => { openBtn.click(); await new Promise((r) => setTimeout(r, 0)); });

    expect(host.querySelectorAll(".prod-board-frame").length).toBeGreaterThanOrEqual(2);

    await act(async () => { dropOnTarget(); await new Promise((r) => setTimeout(r, 0)); });

    const last = savedProds[savedProds.length - 1];
    const shot2 = (last?.scenes as Array<{ shots: Array<Record<string, unknown>> }>)?.flatMap((s) => s.shots)?.find((s) => s.id === "s2");
    const refs = last?.references as Array<Record<string, unknown>> | undefined;
    expect(refs?.some((r) => r.name === "Frame 0001")).toBe(true);
    expect(String(shot2?.prompt ?? "")).toContain("@[Frame 0001]");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("shows the tag in the side panel and node graph when the target is focused", async () => {
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
    await act(async () => { openBtn.click(); await new Promise((r) => setTimeout(r, 0)); });

    // Click the TARGET shot's frame → opens the side panel focused on s2.
    const frames = host.querySelectorAll(".prod-board-frame") as NodeListOf<HTMLElement>;
    await act(async () => {
      frames[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelector(".prod-prompt-drawer-text")).toBeTruthy();

    // Now drop frame s1 onto s2 while the panel is open.
    await act(async () => { dropOnTarget(); await new Promise((r) => setTimeout(r, 50)); });

    const panelText = host.querySelector(".prod-prompt-sidepanel")?.textContent ?? "";
    expect(panelText).toContain("@[Frame 0001]");

    // Open the node graph for the focused shot — the composer must show the tag.
    const nodesBtn = host.querySelector(".prod-graph-open") as HTMLButtonElement;
    await act(async () => { nodesBtn.click(); await new Promise((r) => setTimeout(r, 0)); });
    const graphText = host.querySelector(".prod-graph-composer")?.textContent ?? "";
    expect(graphText).toContain("@[Frame 0001]");
    // The reference node must be present and connected (a tagged edge).
    const refNodes = host.querySelectorAll(".prod-graph-node.prod-graph-ref").length;
    expect(refNodes).toBeGreaterThanOrEqual(1);

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("tags the prompt when Magic Prompt is ON (magicPrompts path)", async () => {
    disk = freshProd();
    (disk as Record<string, unknown>).magicEnabled = true;
    (disk as Record<string, unknown>).magicPrompts = { s2: "The villain looms over the ridge." };
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
    await act(async () => { openBtn.click(); await new Promise((r) => setTimeout(r, 0)); });

    // Focus the target shot so the side panel shows the effective prompt.
    const frames = host.querySelectorAll(".prod-board-frame") as NodeListOf<HTMLElement>;
    await act(async () => {
      frames[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => { dropOnTarget(); await new Promise((r) => setTimeout(r, 50)); });

    // The tag must land in magicPrompts[shotId] (the store effectivePrompt,
    // shotReferences, and the node graph read), not just shot.prompt.
    const last = savedProds[savedProds.length - 1];
    const magicPrompts = (last?.magicPrompts as Record<string, string>) ?? {};
    expect(magicPrompts.s2).toContain("@[Frame 0001]");
    expect((last?.references as Array<Record<string, unknown>>)?.some((r) => r.name === "Frame 0001")).toBe(true);
    // And the side panel must display it.
    const panelText = host.querySelector(".prod-prompt-sidepanel")?.textContent ?? "";
    expect(panelText).toContain("@[Frame 0001]");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});