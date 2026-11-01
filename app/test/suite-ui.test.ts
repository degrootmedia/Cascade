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
import { SuiteCanvas } from "../src/renderer/src/features/suite/SuiteCanvas.js";
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

describe("pending suite entries", () => {
  const pendingEntry: SuiteEntry = {
    ...entry("9", null),
    outputPath: "",
    pending: { historyId: "hist-9", prompt: "prompt 9", model: "m", at: "2026-10-16T00:00:00.000Z" },
  };

  it("shows Fetch result (not a broken image) and fires onRecheck", async () => {
    const onRecheck = vi.fn();
    await act(async () => {
      root!.render(createElement(SuiteCanvas, {
        prodId: "p1",
        entry: pendingEntry,
        compare: null,
        before: null,
        busy: false,
        onExport: () => {},
        onDelete: () => {},
        onRecheck,
        rechecking: false,
      }));
    });
    expect(document.querySelector(".suite-canvas-pending")).not.toBeNull();
    expect(document.querySelector(".suite-canvas-img")).toBeNull();
    const fetchBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Fetch result");
    expect(fetchBtn).toBeDefined();
    await act(async () => { fetchBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onRecheck).toHaveBeenCalledTimes(1);
    // Export stays disabled while there's no file on disk.
    const saveRef = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Save as reference") as HTMLButtonElement;
    expect(saveRef.disabled).toBe(true);
  });

  it("rail shows a spinner (not a broken thumb) for a pending entry", async () => {
    await act(async () => {
      root!.render(createElement(SuiteHistoryRail, {
        prodId: "p1",
        entries: [pendingEntry],
        selectedId: "9",
        onSelect: () => {},
        onDelete: () => {},
      }));
    });
    const row = document.querySelector(".suite-rail-row");
    expect(row?.querySelector(".suite-spinner")).not.toBeNull();
    expect(row?.querySelector("img")).toBeNull();
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

describe("SuitePromptPanel style dropdown reflects the applied style (Item 3)", () => {
  it("shows the matching style when the prompt carries its text but the pick was lost", async () => {
    await renderPanel(
      { mode: "generate", prompt: "Style: soft-3D look\n\na gondola", model: "openart:x", resolution: "1k", refIds: [] },
      () => {}
    );
    const select = document.querySelector(".prod-prompt-style") as HTMLSelectElement;
    expect(select.value).toBe("st1");
  });

  it("shows a removable Custom state for style text no Design style owns, and None strips it without reselecting", async () => {
    let patched: Partial<SuiteDraft> | null = null;
    await renderPanel(
      { mode: "generate", prompt: "Style: some historical look\n\na gondola", model: "openart:x", resolution: "1k", refIds: [] },
      (p) => { patched = p; }
    );
    const select = document.querySelector(".prod-prompt-style") as HTMLSelectElement;
    // Not "none": a style IS applied, and the dropdown must say so.
    expect(select.value).not.toBe("");
    await act(async () => {
      select.value = "";
      select.dispatchEvent(new (globalThis as any).window.Event("change", { bubbles: true }));
    });
    expect(patched!.styleId).toBeUndefined();
    expect(patched!.prompt).toBe("a gondola");
  });

  it("still shows None when no style text is applied and no pick is set", async () => {
    await renderPanel(
      { mode: "generate", prompt: "a gondola", model: "openart:x", resolution: "1k", refIds: [] },
      () => {}
    );
    const select = document.querySelector(".prod-prompt-style") as HTMLSelectElement;
    expect(select.value).toBe("");
  });
});

describe("SuitePromptPanel edit mode never carries a style (Item 2)", () => {
  it("strips the Style paragraph and clears the style pick when switching to Edit", async () => {
    let patched: Partial<SuiteDraft> | null = null;
    await renderPanel(
      { mode: "generate", prompt: "Style: soft-3D look\n\na gondola", model: "openart:x", resolution: "1k", refIds: [], styleId: "st1" },
      (p) => { patched = p; }
    );
    const editTab = Array.from(document.querySelectorAll(".suite-prompt-tab")).find((b) => b.textContent === "Edit image") as HTMLButtonElement;
    expect(editTab).toBeTruthy();
    await act(async () => { editTab.click(); });
    expect(patched!.mode).toBe("edit");
    expect(patched!.prompt).toBe("a gondola");
    expect(patched!.prompt).not.toContain("Style:");
    expect(patched!.styleId).toBeUndefined();
  });

  it("shows no Style box for an edit draft whose stored prompt still has one", async () => {
    // The draft is normalized before it reaches the panel (Item 2 helper),
    // so this pins the panel contract: edit mode renders no style control.
    await renderPanel({ mode: "edit", prompt: "brighten it", model: "openart:x", resolution: "1k", refIds: [], sourceRefId: "r1" }, () => {});
    expect(document.querySelector(".prod-prompt-style")).toBeNull();
    expect(document.querySelector(".prompt-content-editor")?.textContent).toBe("brighten it");
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
