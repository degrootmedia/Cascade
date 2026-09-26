/**
 * Pasting images into the node editor must auto-number the created references
 * (Ref-001, Ref-002, …) exactly like the Design page — clipboard files usually
 * share a generic name ("image.png"), so naming them from the file would make
 * every paste collide on one reference.
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
    references: [{ id: "r4", name: "Ref-004", imagePath: "references/Ref-004.png", shotIds: [] }],
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
  const manual = (shot.prompt as string | undefined)?.trim();
  return manual || AUTO_PROMPT;
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
    addReferenceImage: async (_id: string, name: string) => ({ path: `references/${name}` }),
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
    updateBoardPrompt: async () => disk,
  };
}

/** Paste one clipboard item per name (all with generic "image" names). */
function pasteImages(names: string[]): void {
  const items = names.map((n) => {
    const file = new File(["x"], n, { type: "image/png" });
    return { kind: "file", type: "image/png", getAsFile: () => file };
  });
  const ev = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: { items: typeof items } };
  ev.clipboardData = { items };
  window.dispatchEvent(ev);
}

describe("node-editor paste reference naming", () => {
  it("auto-numbers pasted images after the existing Ref-NNN max", async () => {
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

    // Focus a shot and open its node graph.
    const frames = host.querySelectorAll(".prod-board-frame") as NodeListOf<HTMLElement>;
    expect(frames.length).toBeGreaterThanOrEqual(1);
    await act(async () => {
      frames[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const graphBtn = host.querySelector(".prod-graph-open") as HTMLButtonElement;
    expect(graphBtn).toBeTruthy();
    await act(async () => { graphBtn.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(host.querySelector(".prod-graph-overlay")).toBeTruthy();

    // Two clipboard images both named "image.png" — they must NOT collide.
    await act(async () => { pasteImages(["image.png", "image.png"]); await new Promise((r) => setTimeout(r, 60)); });

    const last = savedProds[savedProds.length - 1];
    const names = ((last?.references as Array<Record<string, unknown>> | undefined) ?? []).map((r) => r.name);
    expect(names).toContain("Ref-005");
    expect(names).toContain("Ref-006");
    expect(names).not.toContain("image");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});
