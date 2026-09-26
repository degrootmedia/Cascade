/**
 * Regression: deleting references from the Design page.
 *
 * 1. Double-delete must not resurrect: tiles are memoized past membership
 *    changes, so a stale `onRemove` closure once filtered a stale list and
 *    brought back an already-deleted (file gone → broken tile) entry. Delete
 *    now goes through one atomic main-side op whose snapshot is authoritative.
 * 2. Deleting a reference piped into a frame output unbinds the pipe.
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

function freshProd(): Record<string, unknown> {
  return {
    meta: { id: "p1", name: "Test production", folder: "C:/test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stepDone: 0, shotCount: 1 },
    currentStep: 2,
    visualStyle: "",
    styles: [],
    scenes: [
      {
        id: "sc1", name: "Scene 1",
        shots: [{
          id: "s1", number: "0100", audio: "", visual: "A hero walks.",
          artwork: "boards/0100/shot-0100-old.jpg",
          graphOutputSource: "ref", graphOutputRefId: "r2",
          graphLayout: { positions: { "ref:r2": { x: 0, y: 116 } } },
        }],
      },
    ],
    characters: [],
    products: [],
    references: [
      { id: "r1", name: "Ref One", imagePath: "references/one.png", shotIds: [] },
      { id: "r2", name: "Ref Two", imagePath: "references/two.png", shotIds: [] },
      { id: "r3", name: "Ref Three", imagePath: "references/three.png", shotIds: [] },
    ],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    magicEnabled: false,
    magicPrompts: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
  };
}

function shotsOf(p: Record<string, unknown>): Array<Record<string, unknown>> {
  return (p.scenes as Array<{ shots: Array<Record<string, unknown>> }>).flatMap((s) => s.shots);
}

/** Faithful stand-in for the main-side atomic delete: filter + scrub the
 *  output pipe + bump rev, like pipeline.deleteReference + saveProduction. */
function mockDeleteReference(id: string, refId: string): Record<string, unknown> {
  if (!disk || (disk.meta as Record<string, unknown>).id !== id) throw new Error("Production not found.");
  const refs = (disk.references as Array<Record<string, unknown>>).filter((r) => r.id !== refId);
  if (refs.length === (disk.references as Array<unknown>).length) throw new Error("Reference not found.");
  for (const shot of shotsOf(disk)) {
    if (shot.graphOutputSource === "ref" && shot.graphOutputRefId === refId) {
      shot.graphOutputSource = undefined;
      shot.graphOutputRefId = undefined;
      if (shot.artwork) {
        shot.artworkHistory = [shot.artwork, ...((shot.artworkHistory as Array<string>) ?? [])];
        shot.artwork = undefined;
      }
    }
    if (shot.graphLayout && (shot.graphLayout as Record<string, unknown>).positions) {
      const positions = (shot.graphLayout as Record<string, Record<string, unknown>>).positions;
      delete positions[`ref:${refId}`];
    }
  }
  disk = { ...disk, references: refs, rev: ((disk.rev as number | undefined) ?? 0) + 1 };
  return JSON.parse(JSON.stringify(disk)) as Record<string, unknown>;
}

function cascadeMock(): Record<string, unknown> {
  return {
    boardThumbnail: async () => null,
    showImageMenu: async () => {},
    videoModelOptions: async () => null,
    videoEndFrameModels: async () => [],
    getOpenArtCredits: async () => null,
    listProductions: async () => [{ id: "p1", name: "Test production", folder: "C:/test", shotCount: 1, stepDone: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    onProductionEvent: () => () => {},
    onBoardExternalUpdate: () => () => {},
    onReferencesExternalUpdate: () => () => {},
    checkExternalEdits: async () => {},
    loadProduction: async () => disk,
    saveProduction: async (p: Record<string, unknown>) => { disk = JSON.parse(JSON.stringify(p)) as Record<string, unknown>; savedProds.push(disk); },
    deleteReference: async (id: string, refId: string) => mockDeleteReference(id, refId),
    removeReferenceFile: async () => {},
    getMcpStatus: async () => [],
    listOpenArtModels: async () => [],
    getMediaProvider: async () => "openart",
    listMediaProviders: async () => [{ id: "openart", displayName: "OpenArt", available: true }],
    listModels: async () => [],
    getSettings: async () => ({}),
    getBoardPrompt: async () => "",
    updateBoardPrompt: async () => null,
  };
}

function tileNames(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll(".prod-ref")).map((f) =>
    (f.querySelector(".prod-ref-edit-name") as HTMLInputElement)?.value ?? "???"
  );
}

async function renderWorkspace(): Promise<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> {
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

async function clickFirstDel(host: HTMLElement): Promise<void> {
  const dels = host.querySelectorAll(".prod-ref-del") as NodeListOf<HTMLButtonElement>;
  await act(async () => { dels[0].click(); await new Promise((r) => setTimeout(r, 0)); });
}

describe("design-page reference delete", () => {
  it("deleting two refs in a row leaves exactly the survivor (no resurrection)", async () => {
    disk = freshProd();
    savedProds.length = 0;
    (globalThis as Record<string, unknown>).window = (globalThis as Record<string, unknown>).window ?? {};
    (globalThis.window as unknown as Record<string, unknown>).cascade = cascadeMock();

    const { host, root } = await renderWorkspace();
    expect(tileNames(host)).toEqual(["Ref One", "Ref Two", "Ref Three"]);

    await clickFirstDel(host);
    expect(tileNames(host)).toEqual(["Ref Two", "Ref Three"]);

    // The surviving tiles kept memoized closures across the membership
    // change — deleting again must still operate on the live list.
    await clickFirstDel(host);
    expect(tileNames(host)).toEqual(["Ref Three"]);

    await clickFirstDel(host);
    expect(tileNames(host)).toEqual([]);

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("unbinds the output pipe when the piped reference is deleted", async () => {
    disk = freshProd();
    savedProds.length = 0;
    (globalThis as Record<string, unknown>).window = (globalThis as Record<string, unknown>).window ?? {};
    (globalThis.window as unknown as Record<string, unknown>).cascade = cascadeMock();

    const { host, root } = await renderWorkspace();
    // "Ref Two" (r2) is piped into shot s1's output.
    await clickFirstDel(host); // delete r1
    expect(shotsOf(disk!)).toHaveLength(1);

    await clickFirstDel(host); // delete r2 (the piped one)
    const shot = shotsOf(disk!).find((s) => s.id === "s1");
    expect(shot?.graphOutputSource).toBeUndefined();
    expect(shot?.graphOutputRefId).toBeUndefined();
    // The piped still stops showing but stays recoverable in frame history.
    expect(shot?.artwork).toBeUndefined();
    expect(shot?.artworkHistory).toContain("boards/0100/shot-0100-old.jpg");

    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});
