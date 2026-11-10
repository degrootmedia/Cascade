/**
 * AssemblyPanel component tests.
 *
 * Before the first render there is no MP4, but the layout must already hold
 * the player's grid slot: a blank placeholder slate in the same slot (and
 * with the same sizing class) as the eventual <video>, so the config card
 * stays in its final column and nothing shifts when the render lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssemblyPanel } from "../src/renderer/src/components/production/assembly.js";
import type { Production } from "../src/shared/ipc.js";

function makeProduction(overrides: Partial<Production> = {}): Production {
  return {
    meta: { id: "prod-a", name: "Test Production", folder: "", createdAt: "", updatedAt: "", stepDone: 4, shotCount: 0 },
    currentStep: 5,
    visualStyle: "",
    styles: [],
    scenes: [],
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    voiceoverPath: "",
    voiceoverVolume: 1,
    musicPath: "",
    musicVolume: 0.5,
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    ...overrides,
  };
}

describe("AssemblyPanel", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    vi.unstubAllGlobals();
  });

  async function renderPanel(prod: Production) {
    await act(async () => {
      root.render(createElement(AssemblyPanel, { prod, onApply: () => {}, log: [] }));
    });
  }

  it("holds the video slot with a blank placeholder before the first render", async () => {
    await renderPanel(makeProduction());
    const layout = host.querySelector(".prod-assembly-layout");
    expect(layout).not.toBeNull();
    const slate = host.querySelector(".prod-assembly-placeholder");
    expect(slate).not.toBeNull();
    // Same sizing class (and slot) the player will occupy.
    expect(slate?.classList.contains("prod-assembly-render")).toBe(true);
    expect(slate?.textContent).toBe("");
    expect(slate?.getAttribute("style")).toContain("aspect-ratio: 1920 / 1080");
    expect(host.querySelector("video.prod-assembly-render")).toBeNull();
    // The config card sits in the second column from the start.
    expect(layout?.children[0]).toBe(slate);
    expect(layout?.children[1]?.classList.contains("prod-assembly-card")).toBe(true);
  });

  it("replaces the placeholder with the player once a render exists", async () => {
    await renderPanel(makeProduction({
      assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly", renderPath: "out/assembly/render.mp4" },
    }));
    const layout = host.querySelector(".prod-assembly-layout");
    const video = host.querySelector("video.prod-assembly-render");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toContain("render.mp4");
    expect(video?.getAttribute("style")).toContain("aspect-ratio: 1920 / 1080");
    expect(host.querySelector(".prod-assembly-placeholder")).toBeNull();
    expect(layout?.children[0]).toBe(video);
    expect(layout?.children[1]?.classList.contains("prod-assembly-card")).toBe(true);
  });
});
