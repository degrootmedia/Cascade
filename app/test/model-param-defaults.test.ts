/**
 * Per-surface parameter defaults: key shape, cache seeding, and the rule that
 * a saved value wins while media/reference roles are never seeded. Pure — the
 * IPC surface is stubbed on globalThis.
 */
import { describe, it, expect } from "vitest";
import {
  getParamDefaults,
  paramDefaultKey,
  primeModelParamDefaults,
  rememberModelParamDefault,
  seedModelOptionValues,
} from "../src/renderer/src/components/production/model-param-defaults.js";
import { buildModelSchema } from "../src/main/providers/model-schema.js";

const MODEL = "higgsfield-cli:seedance_2_5";
const g = globalThis as any;

const schema = buildModelSchema({
  jobType: "seedance_2_5",
  params: [
    { name: "seed", type: "integer", min: 0, max: 100 },
    { name: "mode", type: "string", options: ["std", "omni_reference"] },
    { name: "image_references", type: "array" },
  ],
});

describe("model-param-defaults", () => {
  it("keys defaults by model::surface::flag", () => {
    expect(paramDefaultKey(MODEL, "video:generate", "seed")).toBe(`${MODEL}::video:generate::seed`);
  });

  it("seeds declared non-media flags; stored values and media roles are untouched", async () => {
    g.cascade = {
      getModelParamDefaults: async () => ({
        [`${MODEL}::video:generate::seed`]: 7,
        [`${MODEL}::video:generate::mode`]: "omni_reference",
        [`${MODEL}::video:generate::image_references`]: ["a"],
      }),
      setModelParamDefault: () => {},
    };
    await primeModelParamDefaults();

    const seeded = seedModelOptionValues(schema, MODEL, "video:generate", { seed: 42 });
    expect(seeded.seed).toBe(42); // saved value wins
    expect(seeded.mode).toBe("omni_reference"); // default fills the gap
    expect(seeded.image_references).toBeUndefined(); // media role never seeded
  });

  it("returns the input unchanged when nothing new is seeded", async () => {
    g.cascade = { getModelParamDefaults: async () => ({}), setModelParamDefault: () => {} };
    await primeModelParamDefaults();
    const values = { mode: "std" };
    expect(seedModelOptionValues(schema, MODEL, "video:generate", values)).toBe(values);
  });

  it("scopes defaults to their surface and drops a blanked default", async () => {
    g.cascade = { getModelParamDefaults: async () => ({}), setModelParamDefault: () => {} };
    await primeModelParamDefaults();
    const key = paramDefaultKey(MODEL, "video:tween", "seed");
    rememberModelParamDefault(key, 5);
    expect(getParamDefaults(MODEL, "video:tween").seed).toBe(5);
    expect(getParamDefaults(MODEL, "video:generate").seed).toBeUndefined();
    rememberModelParamDefault(key, null);
    expect(getParamDefaults(MODEL, "video:tween").seed).toBeUndefined();
  });
});
