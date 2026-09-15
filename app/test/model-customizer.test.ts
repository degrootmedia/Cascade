/**
 * Model Customizer placement controls: clicking Core/Advanced/Hidden must
 * update the button state and persist via settings. Verifies the `preset`
 * field (a plain core enum) can be moved to advanced — the reported failure.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ModelCustomizer, fuzzyMatch } from "../src/renderer/src/components/ModelCustomizer.js";

describe("fuzzyMatch", () => {
  const endImageHay = "seedance_2_5 Seedance 2.5 end_image endimage start_image video_references";
  it("matches natural-language synonyms ('End Frame' → end_image)", () => {
    expect(fuzzyMatch("end frame", endImageHay)).toBe(true);
    expect(fuzzyMatch("start frame", endImageHay)).toBe(true);
    expect(fuzzyMatch("endframe", endImageHay)).toBe(true);
  });
  it("matches substrings, token prefixes, and typos; rejects non-matches", () => {
    expect(fuzzyMatch("seed", endImageHay)).toBe(true);
    expect(fuzzyMatch("endimg", endImageHay)).toBe(true);
    expect(fuzzyMatch("zzzz", endImageHay)).toBe(false);
    expect(fuzzyMatch("", endImageHay)).toBe(true);
  });
});

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = ROStub;
(globalThis as any).window = (globalThis as any).window ?? {};
const gWin = (globalThis as any).window as Record<string, unknown>;

const MODEL_ID = "higgsfield-cli:bytedance_video_upscale";
const schema = {
  jobType: "bytedance_video_upscale",
  cliVersion: null,
  fetchedAt: 0,
  aspectRatios: [],
  durations: [],
  roles: ["videoreferences"],
  raw: null,
  fields: [
    { name: "preset", flag: "preset", aliases: ["preset"], kind: "enum", group: "core", values: ["common", "aigc"], default: "common", emit: "value", source: "parameters" },
    { name: "fps", flag: "fps", aliases: ["fps"], kind: "integer", group: "core", min: 1, max: 120, emit: "value", source: "parameters" },
  ],
};

const exposureWrites: Array<[string, string | null]> = [];
const paramDefaultWrites: Array<[string, unknown]> = [];

function installCascade(overrides: Record<string, unknown> = {}) {
  gWin.cascade = {
    listMediaProviders: async () => [{ id: "higgsfield-cli", displayName: "Higgsfield CLI", available: true }],
    getModelOptionExposure: async () => ({}),
    setModelOptionExposure: async (k: string, p: string | null) => { exposureWrites.push([k, p]); },
    resetModelOptionExposure: async () => {},
    getModelSurfaces: async () => ({}),
    setModelSurfaces: async () => {},
    resetModelSurfaces: async () => {},
    getModelParamDefaults: async () => ({}),
    setModelParamDefault: async (k: string, v: unknown) => { paramDefaultWrites.push([k, v]); },
    resetModelParamDefaults: async () => {},
    getHiddenMediaModels: async () => [],
    setHiddenMediaModels: async () => {},
    getModelKindOverrides: async () => ({}),
    setModelKindOverrides: async () => {},
    getMediaModelOrder: async () => [],
    setMediaModelOrder: async () => {},
    getExpensePriceRules: async () => [],
    setExpensePriceRules: async () => {},
    listAllMediaModels: async () => [],
    refreshModelProbe: async () => {},
    probeModels: async () => ({
      provider: "higgsfield-cli",
      displayName: "Higgsfield CLI",
      available: true,
      models: [{ choice: { id: MODEL_ID, displayName: "Bytedance Video Upscale", description: "", imageInput: false, videoInput: true, cost: null }, hidden: false }],
    }),
    probeModelOptions: async () => schema,
    ...overrides,
  };
}

async function mountCustomizer() {
  installCascade();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(ModelCustomizer, { onClose: () => {} })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { container, root };
}

describe("ModelCustomizer placement", () => {
  it("moves the preset parameter to advanced and persists it", async () => {
    const { container, root } = await mountCustomizer();
    // Select the model.
    const row = container.querySelector(".mc-model-row") as HTMLElement;
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // The preset row's Advanced button.
    const presetRow = Array.from(container.querySelectorAll("tr")).find((tr) => tr.textContent?.includes("preset"))!;
    const advBtn = Array.from(presetRow.querySelectorAll("button")).find((b) => b.textContent === "advanced")!;
    expect(advBtn.className).not.toContain("active");
    await act(async () => { advBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(exposureWrites).toContainEqual([`${MODEL_ID}::preset`, "advanced"]);
    const presetRow2 = Array.from(container.querySelectorAll("tr")).find((tr) => tr.textContent?.includes("preset"))!;
    const advBtn2 = Array.from(presetRow2.querySelectorAll("button")).find((b) => b.textContent === "advanced")!;
    expect(advBtn2.className).toContain("active");

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("hides a context's default column until the model appears on that surface", async () => {
    const { container, root } = await mountCustomizer();
    const row = container.querySelector(".mc-model-row") as HTMLElement;
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    const headerText = () =>
      Array.from(container.querySelectorAll(".mc-defaults-table thead th")).map((th) => th.textContent);
    // Tween is opt-in, so it starts without a defaults column.
    expect(headerText()).toEqual(["Parameter", "Generation", "Edit"]);

    const tweenToggle = Array.from(container.querySelectorAll(".mc-surface"))
      .find((l) => l.textContent?.includes("Tween"))!
      .querySelector("input") as HTMLInputElement;
    await act(async () => { tweenToggle.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(headerText()).toEqual(["Parameter", "Generation", "Tween", "Edit"]);

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });

  it("sets a per-surface parameter default and persists it", async () => {
    const { container, root } = await mountCustomizer();
    const row = container.querySelector(".mc-model-row") as HTMLElement;
    await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    const defaults = container.querySelector(".mc-defaults-table") as HTMLTableElement;
    expect(defaults).toBeTruthy();

    const presetRow = Array.from(defaults.querySelectorAll("tbody tr")).find((tr) => tr.textContent?.includes("preset"))!;
    const genSelect = presetRow.querySelectorAll("select")[0] as HTMLSelectElement;
    await act(async () => {
      genSelect.value = "aigc";
      genSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(paramDefaultWrites).toContainEqual([`${MODEL_ID}::video:generate::preset`, "aigc"]);

    await act(async () => { root.unmount(); });
    document.body.removeChild(container);
  });
});
