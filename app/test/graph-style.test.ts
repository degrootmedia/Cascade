/**
 * Step 04 node-graph style tests: the style node is a shared reference — the
 * dropdown selects the library entry (persisted on the shot + the stored
 * graph's style edge) and every plugged prompt re-renders from the library on
 * read. Nothing pastes a Style paragraph into a prompt; a detached prompt
 * keeps its own prose as an explicit override.
 *
 * The harness mirrors ProductionWorkspace.setGraphStyle / onGraphField /
 * onPromptChange and the prompt cache, so the real NodeGraphModal is driven
 * through the same seams the app uses.
 */
import { describe, it, expect } from "vitest";
import { createElement, Fragment, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { NodeGraphModal } from "../src/renderer/src/components/NodeGraphModal.js";
import { setStyleEdge } from "../src/shared/graph/connect.js";
import { renderShotPrompt, stripSharedSections } from "../src/shared/graph/render.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = ROStub;
(globalThis as any).window = (globalThis as any).window ?? {};
const gWin = (globalThis as any).window as Record<string, unknown>;
gWin.cascade = {
  boardThumbnail: async () => null,
  videoModelOptions: async () => null,
};

const SHOT = "s1";
const STYLE_ID = "st1";
const STYLE_TEXT = "Heroic 3D render style";
const CONTENT = "hello world";
// Stored prompts are content-only in the new model; the Style section is
// rendered from the plugged library entry (graph edge) on read.
const WITH_STYLE = CONTENT;

function makeProd(prompt: string, patch?: Record<string, unknown>): any {
  return {
    meta: { id: "p1", name: "T" },
    currentStep: 3,
    openArt: { model: "auto", resolution: "1k" },
    styles: [{ id: STYLE_ID, index: 1, name: "Style 1", prompt: STYLE_TEXT }],
    brand: { colors: [], font: "" },
    references: [{ id: "r1", name: "Hero", imagePath: "references/hero.png" }],
    scenes: [{
      id: "sc1", name: "S",
      shots: [{
        id: SHOT, number: 1, prompt, promptManual: true,
        includeBrandIdentity: true, artwork: "boards/0001.jpg",
        graphStyleConnected: true,
        ...patch,
      }],
    }],
  };
}

function Harness({ initialPrompt, initialConnected, initialStyle, editNodes }: {
  initialPrompt: string;
  initialConnected?: boolean;
  initialStyle?: string;
  editNodes?: any[];
}) {
  const [prod, setProd] = useState(() => makeProd(initialPrompt, { graphStyleConnected: initialConnected ?? true, style: initialStyle, ...(editNodes ? { graphEditNodes: editNodes } : {}) }));
  const cacheRef = useRef<Record<string, string>>({ [SHOT]: initialPrompt });
  const [prompt, setPrompt] = useState(initialPrompt);

  // Mirror of ProductionWorkspace.setGraphStyle (step 04): selection + edge,
  // no pasted paragraph; the rendered prompt is re-derived for the composer.
  const setGraphStyle = (styleId: string) => {
    const cur = prod.scenes[0].shots[0];
    const patch: Record<string, unknown> = { style: styleId || undefined, styleNone: !styleId };
    if (cur.graph) patch.graph = setStyleEdge(cur.graph, "composer", !!styleId);
    else patch.graphStyleConnected = !!styleId;
    const next = { ...prod, scenes: prod.scenes.map((sc: any) => ({ ...sc, shots: sc.shots.map((s: any) => s.id === SHOT ? { ...s, ...patch } : s) })) };
    setProd(next);
    const rendered = renderShotPrompt(next, next.scenes[0].shots[0], "composer");
    cacheRef.current[SHOT] = rendered;
    setPrompt(rendered);
  };

  const onPromptChange = (v: string) => {
    // Mirrors updateBoardPrompt: stored prompts are content-only.
    const stored = stripSharedSections(v);
    setPrompt(stored);
    cacheRef.current[SHOT] = stored;
    setProd((p: any) => ({ ...p, scenes: p.scenes.map((sc: any) => ({ ...sc, shots: sc.shots.map((s: any) => s.id === SHOT ? { ...s, prompt: stored, promptManual: true } : s) })) }));
  };

  const onGraphField = (patch: Record<string, unknown>) => {
    setProd((p: any) => ({ ...p, scenes: p.scenes.map((sc: any) => ({ ...sc, shots: sc.shots.map((s: any) => s.id === SHOT ? { ...s, ...patch } : s) })) }));
  };

  // Simulates editing the style's description on the Design page — the live
  // style text changes with no node-graph interaction at all.
  const setStyleText = (t: string) => {
    setProd((p: any) => ({ ...p, styles: p.styles.map((s: any, i: number) => (i === 0 ? { ...s, prompt: t } : s)) }));
  };

  const onStyleDetached = () => {
    setProd((p: any) => ({ ...p, scenes: p.scenes.map((sc: any) => ({ ...sc, shots: sc.shots.map((s: any) => s.id === SHOT ? { ...s, style: undefined } : s) })) }));
  };

  const shot = prod.scenes[0].shots[0];
  return createElement(Fragment, null,
    createElement("button", { className: "test-set-style-text", onClick: () => setStyleText("Updated cinematic style") }, "set style text"),
    createElement(NodeGraphModal, {
    prod, shot, bust: 0, prompt: renderShotPrompt(prod, shot, "composer"),
    references: [{ id: "r1", name: "Hero", artwork: "data:image/png;base64,AAAA" }] as never,
    styles: prod.styles, styleValue: shot.styleNone ? "" : (shot.style ?? prod.styles[0].id ?? ""), includeBrand: true,
    onPromptChange, onStyleChange: setGraphStyle, onToggleBrand: () => {}, onDropFile: () => {},
    onStyleDetached, imageModels: [], videoModels: [],
    defaultImageModel: "auto", defaultImageResolution: "1k",
    onRunImageGen: async () => {}, onRunVideoGen: async () => {}, onRunEditGen: async () => {},
    onSelectGraphGen: () => {}, onCycleGraphGen: () => {}, onGraphField,
    onPipeImageToVideo: () => {}, onPipeImageToOutput: () => {}, onPipeVideoToOutput: () => {}, onPipeEditToOutput: () => {}, onPipeRefToOutput: () => {},
    onUnpipeImageGen: () => {}, onUnpipeImageToVideo: () => {}, onUnpipeVideoGen: () => {}, onUnpipeEditGen: () => {}, onUnpipeOutput: () => {},
    onSaveLayout: () => {}, onClose: () => {},
  } as never));
}

function styleSelect(host: HTMLDivElement) { return host.querySelector(".prod-graph-style select") as HTMLSelectElement; }
function contentBox(host: HTMLDivElement) { return host.querySelector(".prompt-content-editor") as HTMLElement; }
/** The composer's composed prompt as the submitted prompt would see it. */
function composerPrompt(host: HTMLDivElement): string {
  const styleBox = host.querySelector("textarea[placeholder*='Visual style']") as HTMLTextAreaElement | null;
  const content = (host.querySelector(".prompt-content-editor") as HTMLElement | null)?.textContent ?? "";
  const brandBox = host.querySelector("textarea[placeholder*='Palette']") as HTMLTextAreaElement | null;
  const paras: string[] = [];
  if (styleBox) paras.push(`Style: ${styleBox.value}`);
  if (content.trim()) paras.push(content);
  if (brandBox) paras.push(`Brand identity: ${brandBox.value}`);
  return paras.join("\n\n");
}
/** The connected edit prompt node's Style box / content box. */
function editStyleBox(host: HTMLDivElement): HTMLTextAreaElement | null {
  return host.querySelector(".prod-graph-editprompt textarea[placeholder*='Visual style']") as HTMLTextAreaElement | null;
}
function editContentBox(host: HTMLDivElement): HTMLElement | null {
  return host.querySelector(".prod-graph-editprompt .prompt-content-editor") as HTMLElement | null;
}
function render(initial: Partial<Parameters<typeof Harness>[0]> = {}): { root: Root; host: HTMLDivElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(Harness, { initialPrompt: WITH_STYLE, ...initial })); });
  return { root, host };
}
function flush() { return act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }

describe("node-graph style dropdown (step 04: shared reference)", () => {
  it("removes the Style section when attached, then re-adds it on re-pick", async () => {
    const { root, host } = render();
    await flush();
    expect(composerPrompt(host)).toContain(`Style: ${STYLE_TEXT}`);
    act(() => { const sel = styleSelect(host); sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(composerPrompt(host)).not.toContain("Style:");
    expect(composerPrompt(host)).toContain(CONTENT);
    act(() => { const sel = styleSelect(host); sel.value = STYLE_ID; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(composerPrompt(host)).toContain(`Style: ${STYLE_TEXT}`);
    expect(composerPrompt(host)).toContain(CONTENT);
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("unplugged (detached) prompt keeps its own Style prose as an override", async () => {
    const { root, host } = render({ initialConnected: false, initialPrompt: `Style: My own custom look\n\n${CONTENT}` });
    await flush();
    // Detached: the stored prose is the user's explicit override, not a copy.
    expect(composerPrompt(host)).toContain("Style: My own custom look");
    expect(composerPrompt(host)).toContain(CONTENT);
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});

describe("node-graph style node → edit nodes (step 04)", () => {
  const EDIT_CONTENT = "make it blue";

  it("renders the shared style into a connected edit node and drops it on None", async () => {
    const { root, host } = render({ editNodes: [{ id: "edit0", prompt: EDIT_CONTENT, styleConnected: true }] });
    await flush();
    expect(editStyleBox(host)?.value).toBe(STYLE_TEXT);
    expect(editContentBox(host)?.textContent ?? "").toContain(EDIT_CONTENT);
    act(() => { const sel = styleSelect(host); sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(editStyleBox(host)?.value ?? "").toBe("");
    expect(editContentBox(host)?.textContent ?? "").toContain(EDIT_CONTENT);
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("mirrors a Design-page style text change into a connected edit node", async () => {
    const { root, host } = render({ editNodes: [{ id: "edit0", prompt: EDIT_CONTENT, styleConnected: true }] });
    await flush();
    expect(editStyleBox(host)?.value).toBe(STYLE_TEXT);
    // No node-graph interaction — the Design page's style description changes.
    act(() => { (host.querySelector(".test-set-style-text") as HTMLButtonElement).click(); });
    await flush();
    expect(editStyleBox(host)?.value).toBe("Updated cinematic style");
    expect(editContentBox(host)?.textContent ?? "").toContain(EDIT_CONTENT);
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });

  it("leaves an unplugged edit node's own Style paragraph untouched", async () => {
    const { root, host } = render({ editNodes: [{ id: "edit0", prompt: "Style: Node's own look\n\nmake it blue", styleConnected: false }] });
    await flush();
    expect(editStyleBox(host)?.value).toBe("Node's own look");
    act(() => { const sel = styleSelect(host); sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(editStyleBox(host)?.value).toBe("Node's own look");
    await act(async () => { root.unmount(); });
    document.body.removeChild(host);
  });
});
