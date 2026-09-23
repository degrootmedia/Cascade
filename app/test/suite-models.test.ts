/**
 * Image Suite model-pool resolution. The suite must submit the model its
 * dropdown shows, so both the panel and the submit path resolve the effective
 * model through these pure helpers — a stale cross-vendor pick (or an empty
 * draft) can never fall through to the production's Step-3 model at the
 * provider layer.
 */
import { describe, it, expect } from "vitest";
import type { ModelSurface, OpenArtModelChoice } from "../src/shared/ipc.js";
import {
  resolveSuiteModel,
  resolveSuiteSurfacePool,
} from "../src/renderer/src/features/suite/suite-models.js";

function model(id: string, over: Partial<OpenArtModelChoice> = {}): OpenArtModelChoice {
  return {
    id,
    displayName: id,
    description: "",
    imageInput: true,
    videoInput: false,
    cost: null,
    ...over,
  };
}

describe("resolveSuiteSurfacePool", () => {
  const models: OpenArtModelChoice[] = [
    model("img-both"),
    model("img-edit", { surfaces: ["image:edit"] as ModelSurface[] }),
    model("img-gen", { surfaces: ["image:generate"] as ModelSurface[] }),
    model("vid", { imageInput: false, videoInput: true }),
    model("up-a", { surfaces: ["image:upscale"] as ModelSurface[] }),
    model("up-b", { surfaces: ["image:upscale"] as ModelSurface[] }),
  ];

  it("offers image models on their surface for generate", () => {
    expect(resolveSuiteSurfacePool(models, "generate", []).map((m) => m.id)).toEqual([
      "img-both",
      "img-gen",
    ]);
  });

  it("offers image models on their surface for edit", () => {
    expect(resolveSuiteSurfacePool(models, "edit", []).map((m) => m.id)).toEqual([
      "img-both",
      "img-edit",
    ]);
  });

  it("offers only the upscale capability list in upscale mode", () => {
    expect(resolveSuiteSurfacePool(models, "upscale", ["up-b", "up-a"]).map((m) => m.id)).toEqual([
      "up-a",
      "up-b",
    ]);
  });

  it("never offers video models", () => {
    for (const mode of ["generate", "edit", "upscale"] as const) {
      expect(resolveSuiteSurfacePool(models, mode, ["vid"]).some((m) => m.videoInput)).toBe(false);
    }
  });
});

describe("resolveSuiteModel", () => {
  const pool = [model("a"), model("b")];

  it("keeps a draft pick that's still in the pool", () => {
    expect(resolveSuiteModel("b", pool)).toBe("b");
  });

  it("falls back to the pool's first model for a stale/empty pick", () => {
    expect(resolveSuiteModel("higgsfield-cli:gone", pool)).toBe("a");
    expect(resolveSuiteModel("", pool)).toBe("a");
  });

  it("returns empty for an empty pool", () => {
    expect(resolveSuiteModel("a", [])).toBe("");
  });
});
