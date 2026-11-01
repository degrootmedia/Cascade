/**
 * Item 1 regression: the Image Suite must display the exact prompt used for
 * the selected image / active generation.
 *
 * The failure mode: a generation is submitted (its prompt is captured into
 * the request), the user then selects an older history entry while it runs
 * (the prompt panel follows the selection), and when the generation lands it
 * becomes the selected image — but the prompt panel kept showing the older
 * entry's prompt instead of the one the new image was actually generated
 * with.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ImageSuite } from "../src/renderer/src/features/suite/ImageSuite.js";
import type { SuiteEntry, SuiteGenerateRequest, SuiteSession } from "../src/shared/ipc.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = ROStub;

let root: Root | null = null;
let prodSeq = 0;

function sessionWith(draftPrompt: string, entries: SuiteEntry[]): SuiteSession {
  return {
    version: 1,
    entries,
    selectedId: entries[0]?.id ?? null,
    draft: { mode: "generate", prompt: draftPrompt, model: "openart:x", resolution: "1k", refIds: [] },
  };
}

function entry(id: string, prompt: string): SuiteEntry {
  return {
    id,
    parentId: null,
    kind: "generate",
    createdAt: "2026-10-01T00:00:00.000Z",
    model: "openart:x",
    resolution: "1k",
    prompt,
    promptRefs: [],
    outputPath: `out/suite/${id}.png`,
    refIds: [],
  };
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) { await act(async () => { root!.unmount(); }); root = null; }
  document.body.innerHTML = "";
});

describe("ImageSuite prompt display (Item 1)", () => {
  it("shows the submitted prompt for the result that becomes selected, even after selecting another entry mid-generation", async () => {
    const prodId = `p-display-${++prodSeq}`;
    const oldEntry = entry("old1", "an old castle");
    let captured: SuiteGenerateRequest | null = null;
    let resolveGen: ((e: SuiteEntry) => void) | null = null;
    (globalThis as any).window.cascade = {
      loadSuiteSession: async () => sessionWith("a red gondola", [oldEntry]),
      saveSuiteSession: async (_id: string, s: SuiteSession) => s,
      modelOptions: async () => null,
      generateSuiteImage: (_id: string, req: SuiteGenerateRequest) => {
        captured = req;
        return new Promise<SuiteEntry>((res) => { resolveGen = res; });
      },
    };
    const prod = { meta: { id: prodId, name: "T" }, styles: [], references: [], characters: [], products: [] } as any;
    await act(async () => {
      root!.render(createElement(ImageSuite, {
        prod,
        onProdChange: () => {},
        models: [{ id: "openart:x", displayName: "X", description: "", imageInput: true, videoInput: false, cost: null }],
        providerName: "OpenArt",
        providerAvailable: true,
        seed: null,
        onSeedConsumed: () => {},
      }));
    });
    await flush();

    const contentText = () => document.querySelector(".prompt-content-editor")?.textContent ?? "";
    expect(contentText()).toBe("a red gondola");

    // Submit the generation; its request captures the current prompt.
    const go = document.querySelector<HTMLButtonElement>(".prod-edit-go")!;
    await act(async () => { go.click(); });
    expect(captured!.prompt).toBe("a red gondola");

    // While it runs, select the older entry — the panel follows it.
    const oldRow = Array.from(document.querySelectorAll(".suite-rail-label")).find((b) => b.textContent?.includes("an old castle")) as HTMLButtonElement;
    await act(async () => { oldRow.click(); });
    expect(contentText()).toBe("an old castle");

    // The generation lands and becomes the selected image: the displayed
    // prompt must be the generation request's prompt again.
    await act(async () => { resolveGen!(entry("new1", captured!.prompt)); });
    await flush();
    expect(document.querySelector(".suite-canvas-figure figcaption")?.textContent).toBe("a red gondola");
    expect(contentText()).toBe("a red gondola");
    expect(contentText()).toBe(captured!.prompt);
  });

  it("never submits a Style paragraph in edit mode, even from a restored styled draft (Item 2)", async () => {
    const prodId = `p-display-${++prodSeq}`;
    let captured: SuiteGenerateRequest | null = null;
    const editSession: SuiteSession = {
      version: 1,
      entries: [],
      selectedId: null,
      draft: {
        mode: "edit",
        prompt: "Style: soft-3D look\n\nbrighten it",
        model: "openart:x",
        resolution: "1k",
        refIds: [],
        sourcePath: "boards/0100/frame.png",
        styleId: "st1",
      },
    };
    (globalThis as any).window.cascade = {
      loadSuiteSession: async () => editSession,
      saveSuiteSession: async (_id: string, s: SuiteSession) => s,
      modelOptions: async () => null,
      generateSuiteImage: (_id: string, req: SuiteGenerateRequest) => {
        captured = req;
        return new Promise<SuiteEntry>(() => {});
      },
    };
    const prod = {
      meta: { id: prodId, name: "T" },
      styles: [{ id: "st1", index: 1, name: "Heroic 3D", prompt: "soft-3D look" }],
      references: [], characters: [], products: [],
    } as any;
    await act(async () => {
      root!.render(createElement(ImageSuite, {
        prod,
        onProdChange: () => {},
        models: [{ id: "openart:x", displayName: "X", description: "", imageInput: true, videoInput: false, cost: null }],
        providerName: "OpenArt",
        providerAvailable: true,
        seed: null,
        onSeedConsumed: () => {},
      }));
    });
    await flush();
    // The restored edit draft displays no style at all.
    expect(document.querySelector(".prompt-content-editor")?.textContent).toBe("brighten it");
    expect(document.querySelector(".prod-prompt-style")).toBeNull();
    const go = document.querySelector<HTMLButtonElement>(".prod-edit-go")!;
    expect(go.disabled).toBe(false);
    await act(async () => { go.click(); });
    expect(captured!.kind).toBe("edit");
    expect(captured!.prompt).toBe("brighten it");
    expect(captured!.styleId).toBeUndefined();
  });

  it("Edit in Suite sends the clicked frame, not a stale edit source (Item 4)", async () => {
    const prodId = `p-display-${++prodSeq}`;
    // Persisted draft from an earlier edit of a reference.
    const staleSession: SuiteSession = {
      version: 1,
      entries: [],
      selectedId: null,
      draft: {
        mode: "edit",
        prompt: "earlier edit",
        model: "openart:x",
        resolution: "1k",
        refIds: [],
        sourceRefId: "rOld",
      },
    };
    (globalThis as any).window.cascade = {
      loadSuiteSession: async () => staleSession,
      saveSuiteSession: async (_id: string, s: SuiteSession) => s,
      modelOptions: async () => null,
      generateSuiteImage: () => new Promise<SuiteEntry>(() => {}),
    };
    const prod = {
      meta: { id: prodId, name: "T" },
      styles: [],
      references: [{ id: "rOld", name: "Old Ref", imagePath: "references/old.png", shotIds: [] }],
      characters: [], products: [],
    } as any;
    await act(async () => {
      root!.render(createElement(ImageSuite, {
        prod,
        onProdChange: () => {},
        models: [{ id: "openart:x", displayName: "X", description: "", imageInput: true, videoInput: false, cost: null }],
        providerName: "OpenArt",
        providerAvailable: true,
        // The right-click "Edit in Suite" handoff for a board frame.
        seed: { mode: "edit", prompt: "", model: "", resolution: "1k", refIds: [], sourcePath: "boards/0100/frame.png" },
        onSeedConsumed: () => {},
      }));
    });
    await flush();
    // The clicked frame is the edit source (its tile is selected and the
    // canvas reveals it as the Before frame) — not the stale reference.
    const selectedSource = document.querySelector(".suite-edit-source.selected .suite-edit-source-name")?.textContent ?? "";
    expect(selectedSource).toContain("boards/0100/frame.png");
    const beforeImg = document.querySelector<HTMLImageElement>(".suite-canvas-before");
    expect(beforeImg).toBeTruthy();
    expect(beforeImg!.src).toContain("boards");
    expect(beforeImg!.src).not.toContain("old.png");
  });
});
