/**
 * useGenerationCost regression tests — the hook IS the test surface for
 * live quote behavior (debounce, quotable-gating, refetch-on-change,
 * stale-response guard, failure→null). Mounts a probe component with
 * react-dom directly (cf. test/model-options-form.test.ts); `window.cascade`
 * is stubbed per test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import {
  costAspect,
  formatGenerationCost,
  generationCostKey,
  isQuotableCostModel,
  useGenerationCost,
} from "../src/renderer/src/components/production/generation-cost.js";
import type { GenerationCostRequest } from "../src/shared/ipc.js";

// Async effects need React's act environment (the sync-only component tests
// never set this — without it `act(async …)` warns and timers leak).
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const g = globalThis as Record<string, unknown>;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function probe(req: GenerationCostRequest | null): ReactElement {
  return createElement(function Probe({ current }: { current: GenerationCostRequest | null }) {
    const { cost, pending } = useGenerationCost(current, { debounceMs: 1 });
    return createElement("span", { id: "out" }, `${cost === null ? "null" : cost}|${pending ? "p" : "i"}`);
  }, { current: req });
}

async function renderProbe(req: GenerationCostRequest | null): Promise<{ root: Root; el: HTMLElement }> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(probe(req));
  });
  await settle();
  return { root, el };
}

/** Let a debounce timer + its IPC promise resolve inside act. */
async function settle(): Promise<void> {
  await act(async () => {
    await sleep(30);
  });
}

async function rerender(root: Root, req: GenerationCostRequest | null): Promise<void> {
  await act(async () => {
    root.render(probe(req));
  });
  await settle();
}

function text(el: HTMLElement): string {
  return el.querySelector("#out")?.textContent ?? "missing";
}

beforeEach(() => {
  vi.restoreAllMocks();
  delete g.cascade;
});

describe("quote helpers", () => {
  it("gates to the Higgsfield CLI family and formats fractions", () => {
    expect(isQuotableCostModel("higgsfield-cli:seedance_2_5")).toBe(true);
    expect(isQuotableCostModel("higgsfield:seedance_2_5")).toBe(true);
    expect(isQuotableCostModel("openart-cli:foo")).toBe(false);
    expect(isQuotableCostModel("auto")).toBe(false);
    expect(isQuotableCostModel(null)).toBe(false);
    expect(formatGenerationCost(32)).toBe("32");
    expect(formatGenerationCost(32.5)).toBe("32.5");
    expect(costAspect({})).toBe("16:9");
    expect(costAspect({ aspect_ratio: "9:16" })).toBe("9:16");
  });

  it("keys stably regardless of params order", () => {
    const a: GenerationCostRequest = { model: "higgsfield-cli:x", kind: "image", params: { b: "2", a: "1" } };
    const b: GenerationCostRequest = { model: "higgsfield-cli:x", kind: "image", params: { a: "1", b: "2" } };
    expect(generationCostKey(a)).toBe(generationCostKey(b));
    expect(generationCostKey({ ...a, quality: "high" })).not.toBe(generationCostKey(a));
  });
});

describe("useGenerationCost", () => {
  it("probes after debounce and refetches when quality changes", async () => {
    const generationCost = vi.fn(async (req: GenerationCostRequest) => (req.quality === "high" ? 2 : 1));
    g.cascade = { generationCost };
    const base: GenerationCostRequest = {
      model: "higgsfield-cli:gpt_image_2_5", kind: "image",
      resolution: "1k", aspectRatio: "16:9", quality: "low",
    };
    const { root, el } = await renderProbe(base);
    expect(generationCost).toHaveBeenCalledTimes(1);
    expect(generationCost).toHaveBeenLastCalledWith(base);
    expect(text(el)).toBe("1|i");
    // Quality flip refires the probe and the displayed quote follows it.
    await rerender(root, { ...base, quality: "high" });
    expect(generationCost).toHaveBeenCalledTimes(2);
    expect(generationCost).toHaveBeenLastCalledWith({ ...base, quality: "high" });
    expect(text(el)).toBe("2|i");
    root.unmount();
    el.remove();
  });

  it("makes zero IPC calls for non-quotable models and clears the quote", async () => {
    const generationCost = vi.fn(async () => 9);
    g.cascade = { generationCost };
    const { root, el } = await renderProbe({ model: "openart:foo", kind: "image" });
    expect(generationCost).not.toHaveBeenCalled();
    expect(text(el)).toBe("null|i");
    root.unmount();
    el.remove();
  });

  it("resolves null (never throws) when the probe rejects or is absent", async () => {
    g.cascade = { generationCost: vi.fn(async () => { throw new Error("No handler"); }) };
    const req: GenerationCostRequest = { model: "higgsfield-cli:x", kind: "image" };
    const first = await renderProbe(req);
    expect(text(first.el)).toBe("null|i");
    first.root.unmount();
    first.el.remove();
    delete g.cascade;
    const second = await renderProbe(req);
    expect(text(second.el)).toBe("null|i");
    second.root.unmount();
    second.el.remove();
  });

  it("drops a stale slow response in favor of the latest config", async () => {
    let resolveSlow!: (n: number) => void;
    const slow = new Promise<number>((r) => { resolveSlow = r; });
    const generationCost = vi.fn((req: GenerationCostRequest) =>
      req.quality === "low" ? slow : Promise.resolve(2)
    );
    g.cascade = { generationCost };
    const base: GenerationCostRequest = {
      model: "higgsfield-cli:gpt_image_2_5", kind: "image", quality: "low",
    };
    const { root, el } = await renderProbe(base);
    await rerender(root, { ...base, quality: "high" });
    expect(text(el)).toBe("2|i");
    await act(async () => {
      resolveSlow(1);
      await sleep(10);
    });
    // The late low-quality quote must not clobber the current one.
    expect(text(el)).toBe("2|i");
    root.unmount();
    el.remove();
  });
});
