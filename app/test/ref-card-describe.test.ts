/**
 * Item 1 regression: the "+ card" button on a reference tile must always have
 * a visible outcome. Clicking it (with an image and no card yet) shows a
 * disabled "Drafting…" state while the vision auto-draft runs, then opens the
 * editor PREFILLED with the draft for review — the drafted card is never
 * saved silently. A failing / empty / hung draft falls back to an empty
 * editor for manual entry, and confirming the editor is what writes
 * `visualSummary` onto the reference.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { RefFigure, runDescribeCardFlow, applyRefCard } from "../src/renderer/src/components/production/references.js";

(globalThis as Record<string, unknown>).window = (globalThis as Record<string, unknown>).window ?? {};
(globalThis.window as unknown as Record<string, unknown>).cascade = {
  showImageMenu: async () => {},
};

const IMG_REF = { id: "r1", name: "Gondola", artwork: "data:image/png;base64,IMG" };
const NO_IMG_REF = { id: "r2", name: "Empty slot", artwork: undefined, imagePath: undefined };

describe("runDescribeCardFlow (the + card click)", () => {
  it("opens the editor prefilled with a successful draft and saves only on confirm", async () => {
    const drafting: boolean[] = [];
    let askedInitial: string | undefined;
    const saved: string[] = [];
    await runDescribeCardFlow(IMG_REF, {
      describe: async () => "Red gondola interior, three-quarter view",
      ask: async (initial) => { askedInitial = initial; return "  Red gondola interior (edited)  "; },
      save: (clean) => { saved.push(clean); },
      onDraftingChange: (d) => { drafting.push(d); },
    });
    expect(drafting).toEqual([true, false]);
    expect(askedInitial).toBe("Red gondola interior, three-quarter view");
    expect(saved).toEqual(["Red gondola interior (edited)"]);
  });

  it("never saves the draft when the editor is cancelled", async () => {
    const save = vi.fn();
    await runDescribeCardFlow(IMG_REF, {
      describe: async () => "Drafted line the user rejected",
      ask: async () => null,
      save,
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("opens the editor empty when the draft call fails", async () => {
    let askedInitial: string | undefined;
    const saved: string[] = [];
    await runDescribeCardFlow(IMG_REF, {
      describe: async () => { throw new Error("provider down"); },
      ask: async (initial) => { askedInitial = initial; return "Typed by hand"; },
      save: (clean) => { saved.push(clean); },
    });
    expect(askedInitial).toBe("");
    expect(saved).toEqual(["Typed by hand"]);
  });

  it("opens the editor empty when the draft returns nothing", async () => {
    let askedInitial: string | undefined;
    await runDescribeCardFlow(IMG_REF, {
      describe: async () => "",
      ask: async (initial) => { askedInitial = initial; return null; },
      save: () => {},
    });
    expect(askedInitial).toBe("");
  });

  it("does not block forever on a hung draft (timeout falls back to manual entry)", async () => {
    let askedInitial: string | undefined;
    const drafting: boolean[] = [];
    await runDescribeCardFlow(IMG_REF, {
      describe: () => new Promise<string>(() => { /* never settles */ }),
      ask: async (initial) => { askedInitial = initial; return null; },
      save: () => {},
      onDraftingChange: (d) => { drafting.push(d); },
      timeoutMs: 20,
    });
    expect(askedInitial).toBe("");
    expect(drafting).toEqual([true, false]);
  });

  it("goes straight to the editor when the reference has no image", async () => {
    const describe = vi.fn(async () => "should never be drafted");
    let askedInitial: string | undefined;
    await runDescribeCardFlow(NO_IMG_REF, {
      describe,
      ask: async (initial) => { askedInitial = initial; return null; },
      save: () => {},
    });
    expect(describe).not.toHaveBeenCalled();
    expect(askedInitial).toBe("");
  });

  it("edits an existing card without re-drafting, and clearing saves empty", async () => {
    const describe = vi.fn(async () => "should never be drafted");
    let askedInitial: string | undefined;
    const saved: string[] = [];
    await runDescribeCardFlow({ ...IMG_REF, visualSummary: "Existing card" }, {
      describe,
      ask: async (initial) => { askedInitial = initial; return "   "; },
      save: (clean) => { saved.push(clean); },
    });
    expect(describe).not.toHaveBeenCalled();
    expect(askedInitial).toBe("Existing card");
    expect(saved).toEqual([""]);
  });
});

describe("applyRefCard (saving the editor)", () => {
  it("writes visualSummary onto the matching reference only", () => {
    const refs = [
      { id: "r1", name: "Gondola", shotIds: [] },
      { id: "r2", name: "Other", shotIds: [], visualSummary: "Keep me" },
    ] as never[];
    const next = applyRefCard(refs as never, "r1", "Red gondola interior") as unknown as { visualSummary?: string }[];
    expect(next[0].visualSummary).toBe("Red gondola interior");
    expect(next[1].visualSummary).toBe("Keep me");
  });

  it("clears the card when the saved text is empty", () => {
    const refs = [{ id: "r1", name: "Gondola", shotIds: [], visualSummary: "Old card" }] as never[];
    const next = applyRefCard(refs as never, "r1", "") as unknown as { visualSummary?: string }[];
    expect(next[0].visualSummary).toBeUndefined();
  });
});

function renderTile(refItem: unknown, extra: Record<string, unknown> = {}): { root: ReturnType<typeof createRoot>; host: HTMLDivElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(RefFigure, {
      prodId: "p1",
      refItem: refItem as never,
      onAttach: () => {},
      onRemove: () => {},
      onRename: () => {},
      onReorder: () => {},
      onSetPurpose: () => {},
      onDescribe: () => {},
      ...extra,
    } as never));
  });
  return { root, host };
}

describe("RefFigure card button states", () => {
  it("shows a disabled Drafting state while the auto-draft runs", () => {
    const { root, host } = renderTile(IMG_REF, { describing: true });
    const btn = host.querySelector(".prod-ref-describe") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Drafting");
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("shows '+ card' without a card and '✎ card' + Shows tooltip with one", () => {
    const bare = renderTile(IMG_REF);
    expect((bare.host.querySelector(".prod-ref-describe") as HTMLButtonElement).textContent).toBe("+ card");
    act(() => { bare.root.unmount(); });
    document.body.removeChild(bare.host);

    const carded = renderTile({ ...IMG_REF, visualSummary: "Red gondola interior" });
    const btn = carded.host.querySelector(".prod-ref-describe") as HTMLButtonElement;
    expect(btn.textContent).toBe("✎ card");
    expect(btn.getAttribute("title")).toContain("Shows: Red gondola interior");
    const row = carded.host.querySelector(".prod-ref-purpose-row") as HTMLElement;
    expect(row.getAttribute("title")).toContain("Shows: Red gondola interior");
    act(() => { carded.root.unmount(); });
    document.body.removeChild(carded.host);
  });

  it("clicking + card invokes onDescribe with the reference", () => {
    const onDescribe = vi.fn();
    const { root, host } = renderTile(IMG_REF, { onDescribe });
    const btn = host.querySelector(".prod-ref-describe") as HTMLButtonElement;
    act(() => { btn.click(); });
    expect(onDescribe).toHaveBeenCalledTimes(1);
    expect(onDescribe.mock.calls[0][0]).toMatchObject({ id: "r1" });
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });
});
