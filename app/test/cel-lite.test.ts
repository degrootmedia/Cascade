import { describe, it, expect } from "vitest";
import { evalCel, rulesAllow, resolutionsAllowedByRules } from "../src/shared/cel-lite.js";

const fast = { cel: 'params.mode != "fast" || !(params.resolution in ["1080p", "4k"])' };
const refs = { cel: "size(params.image_references) + (params.start_image == null ? 0 : 1) <= 9" };

describe("cel-lite", () => {
  it("evaluates Seedance's fast-mode resolution rule", () => {
    expect(rulesAllow([fast], { mode: "fast", resolution: "1080p" })).toBe(false);
    expect(rulesAllow([fast], { mode: "fast", resolution: "720p" })).toBe(true);
    expect(rulesAllow([fast], { mode: "std", resolution: "4k" })).toBe(true);
  });
  it("filters resolutions by rules (mode fast caps at 720p)", () => {
    expect(resolutionsAllowedByRules([fast], { mode: "fast" }, ["480p", "720p", "1080p", "4k"])).toEqual(["480p", "720p"]);
  });
  it("handles size/ternary/null and allows unknown constructs", () => {
    expect(evalCel("size(params.image_references) + (params.start_image == null ? 0 : 1) <= 9", { image_references: [1, 2] })).toBe(true);
    expect(rulesAllow([{ cel: "params.x.matches('a')" }], {})).toBe(true);
    expect(rulesAllow([refs], { image_references: new Array(10).fill(1) })).toBe(false);
  });
});

import { resolutionsForSchema } from "../src/renderer/src/components/resolution.js";

describe("resolutionsForSchema", () => {
  const schema = {
    raw: { rules: [{ cel: 'params.mode != "fast" || !(params.resolution in ["1080p", "4k"])' }] },
    fields: [{ name: "mode", default: "std" }],
  };
  const ladder = ["480p", "720p", "1080p", "4k"];
  it("uses schema defaults, then narrows when the mode changes", () => {
    expect(resolutionsForSchema(schema, {}, ladder)).toEqual(ladder);
    expect(resolutionsForSchema(schema, { mode: "fast" }, ladder)).toEqual(["480p", "720p"]);
  });
  it("passes the ladder through when the model has no rules", () => {
    expect(resolutionsForSchema({ raw: {}, fields: [] }, {}, ladder)).toEqual(ladder);
  });
});
