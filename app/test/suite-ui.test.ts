/**
 * Image Suite UI regressions:
 *  - the history rail is a straight list (no branch indentation / tree),
 *  - the generate flow always exposes a Style dropdown (populated from the
 *    production's Design styles) that mirrors the pick into the draft prompt.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { SuiteHistoryRail } from "../src/renderer/src/features/suite/SuiteHistoryRail.js";
import { SuitePromptPanel } from "../src/renderer/src/features/suite/SuitePromptPanel.js";
import type { SuiteDraft, SuiteEntry } from "../src/shared/ipc.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = ROStub;
const gWin = (globalThis as any).window as Record<string, unknown>;
gWin.cascade = { modelOptions: async () => null };

let root: Root | null = null;

beforeEach(() => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) { await act(async () => { root!.unmount(); }); root = null; }
  document.body.innerHTML = "";
});

function entry(id: string, parentId: string | null): SuiteEntry {
  return {
    id,
    parentId,
    kind: "generate",
    createdAt: new Date(1700000000000 + Number(id) * 1000).toISOString(),
    model: "m",
    resolution: "1k",
    prompt: `prompt ${id}`,
    promptRefs: [],
    outputPath: `out/suite/${id}.png`,
    refIds: [],
  };
}

describe("SuiteHistoryRail", () => {
  it("renders a flat newest-first list with no branch markers", async () => {
    const entries = [entry("1", null), entry("2", "1"), entry("3", "2")];
    await act(async () => {
      root!.render(createElement(SuiteHistoryRail, {
        prodId: "p1",
        entries,
        selectedId: "2",
        onSelect: () => {},
        onDelete: () => {},
      }));
    });
    const rows = Array.from(document.querySelectorAll(".suite-rail-row"));
    // Newest first: 3, 2, 1.
    expect(rows.map((r) => r.querySelector(".suite-rail-prompt")?.textContent)).toEqual([
      "prompt 3", "prompt 2", "prompt 1",
    ]);
    // No tree affordances.
    expect(document.querySelector(".suite-rail-branch")).toBeNull();
    expect(rows.some((r) => (r as HTMLElement).style.paddingLeft)).toBe(false);
  });
});

function makeProd() {
  return {
    meta: { id: "p1", name: "T" },
    styles: [
      { id: "st1", index: 1, name: "Heroic 3D", prompt: "soft-3D look" },
      { id: "st2", index: 2, name: "Ink", prompt: "ink wash" },
    ],
    references: [],
  } as any;
}

async function renderPanel(draft: SuiteDraft, onDraftChange: (p: Partial<SuiteDraft>) => void) {
  await act(async () => {
    root!.render(createElement(SuitePromptPanel, {
      prod: makeProd(),
      draft,
      onDraftChange,
      models: [{ id: "openart:x", displayName: "X", description: "", imageInput: true, videoInput: false, cost: null }],
      upscaleModelIds: [],
      promptRefs: [],
      schema: null,
      submitting: false,
      error: null,
      providerName: "OpenArt",
      providerAvailable: true,
      branchParent: null,
      onRunAsRoot: () => {},
      quotedCredits: null,
      onSubmit: () => {},
    }));
  });
}

describe("SuitePromptPanel style selection", () => {
  it("always shows the Style dropdown in generate mode and mirrors the pick into the prompt", async () => {
    let patched: Partial<SuiteDraft> | null = null;
    await renderPanel({ mode: "generate", prompt: "a gondola", model: "openart:x", resolution: "1k", refIds: [] }, (p) => { patched = p; });
    const select = document.querySelector(".prod-prompt-style") as HTMLSelectElement;
    expect(select, "style dropdown").toBeTruthy();
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "st1", "st2"]);
    await act(async () => {
      select.value = "st1";
      select.dispatchEvent(new (globalThis as any).window.Event("change", { bubbles: true }));
    });
    expect(patched!.styleId).toBe("st1");
    expect(patched!.prompt).toBe("Style: soft-3D look\n\na gondola");
  });

  it("hides the Style dropdown outside generate mode", async () => {
    await renderPanel({ mode: "edit", prompt: "brighten it", model: "openart:x", resolution: "1k", refIds: [], sourceRefId: "r1" }, () => {});
    expect(document.querySelector(".prod-prompt-style")).toBeNull();
  });
});

describe("SuitePromptPanel queued generations", () => {
  it("shows the queued count and stays clickable while generating", async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root!.render(createElement(SuitePromptPanel, {
        prod: makeProd(),
        draft: { mode: "generate", prompt: "a gondola", model: "openart:x", resolution: "1k", refIds: [] },
        onDraftChange: () => {},
        models: [{ id: "openart:x", displayName: "X", description: "", imageInput: true, videoInput: false, cost: null }],
        upscaleModelIds: [],
        promptRefs: [],
        schema: null,
        submitting: true,
        queued: 2,
        error: null,
        providerName: "OpenArt",
        providerAvailable: true,
        branchParent: null,
        onRunAsRoot: () => {},
        quotedCredits: null,
        onSubmit,
      }));
    });
    const submit = document.querySelector<HTMLButtonElement>(".prod-edit-go")!;
    expect(submit.textContent).toContain("Generating… (2 queued)");
    expect(submit.disabled).toBe(false);
    await act(async () => { submit.click(); });
    expect(onSubmit).toHaveBeenCalled();
  });
});
