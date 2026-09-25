/**
 * migrateShotGraph tests (master plan step 03 T4): loading a legacy
 * production file builds a valid stored graph while leaving every old field
 * untouched. The migration is idempotent and re-runnable.
 */
import { afterAll, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/opencode/cascade-graph-migrate-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({ app: { getPath: () => dataDir } }));

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { loadProduction, saveProduction } from "../src/main/productions.js";
import { normalizeGraph } from "../src/shared/graph/normalize.js";
import { renderShotPrompt } from "../src/shared/graph/render.js";

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const shot = (over: Partial<ProductionShot> = {}): ProductionShot =>
  ({ id: "shot-1", number: "0100", audio: "", visual: "", ...over }) as ProductionShot;

function legacyProduction(): Production {
  return {
    meta: { id: "pmig", name: "Mig", folder: "C:/workspace/mig", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 1 },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: [{ id: "sc1", ordinal: 1, shots: [shot({
      prompt: "Style: vivid\n\nHold @[Gondola]\n\nBrand identity: auto",
      graphStyleConnected: true,
      graphImageToVideo: true,
      graphVideoPrompt: "Drift",
      graphOutputSource: "imagegen",
    })] }],
    characters: [{ id: "c1", name: "Gondola", key: "g", artwork: "g.png" }],
    products: [],
    references: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    schemaVersion: 1,
  } as unknown as Production;
}

describe("migrateShotGraph (load path)", () => {
  it("builds a valid graph from flags/text; old fields untouched", () => {
    saveProduction(legacyProduction());
    const loaded = loadProduction("pmig");
    const s = loaded!.scenes[0].shots[0];
    expect(s.graph?.migrated).toBe(true);
    expect(s.graph?.version).toBe(1);
    expect(normalizeGraph(s.graph!).issues).toEqual([]);
    const ids = s.graph!.edges.map((e) => e.id);
    for (const id of ["e-cmp-img", "e-style", "e-brand", "e-vp-vid", "e-img-vid", "e-img-out", "e-ref:c1-composer-0"]) {
      expect(ids).toContain(id);
    }
    // Old flag fields intact; pasted shared copies strip (step 04 — the new
    // edges cover them, and the render stays byte-identical via the edge).
    expect(s.graphStyleConnected).toBe(true);
    // The video node's flat fields migrate into `graphVideoNodes[0]` (the
    // multi-node model); the composer style plug stays a flag.
    expect(s.graphVideoNodes?.[0]?.source).toEqual({ kind: "imagegen" });
    expect(s.graphImageToVideo).toBeUndefined();
    expect(s.prompt).toBe("Hold @[Gondola]");
    expect(s.prompt).toContain("@[Gondola]");
  });

  it("is idempotent: a second load keeps the identical graph", () => {
    saveProduction(legacyProduction());
    const first = loadProduction("pmig")!.scenes[0].shots[0].graph;
    const second = loadProduction("pmig")!.scenes[0].shots[0].graph;
    expect(second).toEqual(first);
  });

  it("round-trips through save/load (T7)", () => {
    saveProduction(legacyProduction());
    const once = loadProduction("pmig")!;
    saveProduction(once);
    const twice = loadProduction("pmig")!.scenes[0].shots[0].graph;
    expect(twice).toEqual(once.scenes[0].shots[0].graph);
  });
});

describe("migrateShotGraph strips shared copies (step 04)", () => {
  const styledProd = (prompt: string): Production => ({
    ...legacyProduction(),
    styles: [{ id: "s1", index: 1, name: "Heroic", prompt: "vivid" }],
    scenes: [{ id: "sc1", ordinal: 1, shots: [shot({ prompt, graphStyleConnected: true })] }] as unknown as Production["scenes"],
  });

  it("exact style copies strip; render is byte-identical to the old text", () => {
    const legacy = "Style: vivid\n\nHold @[Gondola]";
    saveProduction(styledProd(legacy));
    const loaded = loadProduction("pmig")!;
    const s = loaded.scenes[0].shots[0];
    // Storage no longer carries the copy…
    expect(s.prompt).toBe("Hold @[Gondola]");
    // …but the edge covers it, so the render matches the pre-migration bytes.
    expect(renderShotPrompt(loaded as unknown as Production, s, "composer")).toBe(legacy);
  });

  it("brand markers strip when the edge covers them", () => {
    saveProduction(styledProd("Hold @[Gondola]\n\nBrand identity: auto"));
    const s = loadProduction("pmig")!.scenes[0].shots[0];
    expect(s.prompt).toBe("Hold @[Gondola]");
    expect(s.graph!.edges.some((e) => e.id === "e-brand")).toBe(true);
  });

  it("custom prose that merely looks shared is kept in storage", () => {
    saveProduction(styledProd("Style: my own words\n\nAction"));
    const s = loadProduction("pmig")!.scenes[0].shots[0];
    expect(s.prompt).toBe("Style: my own words\n\nAction");
  });
});

describe("migration fixtures: migrate and render identically (step 10 T2/T3)", () => {
  /** A rich legacy production exercising style + brand + refs + video + edit +
   *  tween + output in one shot. */
  function richLegacy(): Production {
    return {
      meta: { id: "prich", name: "Rich", folder: "C:/workspace/rich", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 1 },
      currentStep: 3,
      visualStyle: "",
      styles: [{ id: "s1", index: 1, name: "Heroic", prompt: "vivid" }],
      brand: { colors: ["#112233"], font: "Baskerville" },
      scenes: [{ id: "sc1", ordinal: 1, shots: [shot({
        prompt: "Style: vivid\n\nHold @[Gondola] on the @[Rig]\n\nBrand identity: Color palette: #112233. Font: Baskerville.",
        graphStyleConnected: true,
        includeBrandIdentity: true,
        graphVideoPrompt: "Drift @[Rig]",
        graphImageToVideo: true,
        graphEditNodes: [{ id: "edit0", prompt: "Fix the light", source: { kind: "imagegen" }, styleConnected: true }],
        graphTweenRefIds: ["imagegen", "c1"],
        graphOutputSource: "editgen",
        graphOutputEditNodeId: "edit0",
      })] }],
      characters: [{ id: "c1", name: "Gondola", key: "g", artwork: "g.png" }],
      products: [],
      references: [{ id: "r1", name: "Rig", imagePath: "r.png" }],
      openArt: { model: "auto", resolution: "1k" },
      status: {},
      assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
      schemaVersion: 1,
    } as unknown as Production;
  }

  it("renders byte-identically before and after migration", () => {
    const fixture = richLegacy();
    const before = renderShotPrompt(fixture, fixture.scenes[0].shots[0], "composer");
    saveProduction(fixture);
    const loaded = loadProduction("prich")!;
    const after = renderShotPrompt(loaded, loaded.scenes[0].shots[0], "composer");
    expect(after).toBe(before);
    expect(normalizeGraph(loaded.scenes[0].shots[0].graph!).issues).toEqual([]);
  });

  it("migrating the whole document twice is a fixed point", () => {
    saveProduction(richLegacy());
    const once = loadProduction("prich")!;
    saveProduction(once);
    const twice = loadProduction("prich")!;
    expect(JSON.stringify(twice.scenes)).toBe(JSON.stringify(once.scenes));
  });
});
