/**
 * Shared model-option vocabulary: the 16:9 default, the OpenArt
 * quality/resolution split, and the field projection that feeds the
 * exposed/advanced form. Pure — no Electron.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_ASPECT_RATIO, resolveAspectRatio, type ModelParamOption } from "../src/shared/ipc.js";
import { extractOpenArtVideoOptions, openArtSchemaFromProps } from "../src/main/providers/openart-core.js";
import { applyOptionExposure, buildModelSchema } from "../src/main/providers/model-schema.js";
import { optionFieldsFromModelOptions } from "../src/renderer/src/components/ModelOptionsForm.js";

describe("DEFAULT_ASPECT_RATIO / resolveAspectRatio", () => {
  it("forces 16:9 for missing/empty choices and passes real ones through", () => {
    expect(DEFAULT_ASPECT_RATIO).toBe("16:9");
    expect(resolveAspectRatio(undefined)).toBe("16:9");
    expect(resolveAspectRatio(null)).toBe("16:9");
    expect(resolveAspectRatio("")).toBe("16:9");
    expect(resolveAspectRatio("   ")).toBe("16:9");
    expect(resolveAspectRatio("9:16")).toBe("9:16");
  });
});

describe("extractOpenArtVideoOptions", () => {
  it("splits quality from resolution and routes aspect + advanced params", () => {
    const o = extractOpenArtVideoOptions({
      quality: { type: "string", enum: ["low", "medium", "high"], default: "medium" },
      resolution: { type: "string", enum: ["480p", "720p"] },
      aspect_ratio: { type: "string", enum: ["16:9", "9:16"] },
      cfg_scale: { type: "number", enum: ["1", "2", "3"] },
      prompt: { type: "string" },
    });
    expect(o.qualities).toEqual(["low", "medium", "high"]);
    expect(o.defaultQuality).toBe("medium");
    expect(o.resolutions).toEqual(["480p", "720p"]);
    expect(o.aspectRatios).toEqual(["16:9", "9:16"]);
    const keys = (o.params ?? []).map((p: ModelParamOption) => p.key);
    expect(keys).toContain("cfg_scale");
    expect(keys).not.toContain("prompt");
  });

  it("keeps a resolution-shaped quality ladder on the resolution list (Wan)", () => {
    const o = extractOpenArtVideoOptions({ quality: { type: "string", enum: ["720p", "1080p"] } });
    expect(o.resolutions).toEqual(["720p", "1080p"]);
    expect(o.qualities).toBeUndefined();
  });
});

describe("buildModelSchema", () => {
  it("classifies params into kinds/groups and skips prompt", () => {
    const schema = buildModelSchema({
      jobType: "gpt_image_2_5",
      params: [
        { name: "quality", type: "string", options: ["low", "high"], default: "low" },
        { name: "variant", type: "string", options: ["flare", "sunburst"] },
        { name: "seed", type: "integer", min: 0, max: 100 },
        { name: "background", type: "string", options: ["auto", "opaque"] },
        { name: "image_references", type: "array" },
        { name: "prompt", type: "string" },
      ],
      aspectRatios: ["1:1", "16:9"],
    });
    const byFlag = (f: string) => schema.fields.find((x) => x.flag === f);
    expect(byFlag("quality")!.group).toBe("core");
    expect(byFlag("variant")!.group).toBe("core");
    expect(byFlag("seed")!.kind).toBe("integer");
    expect(byFlag("seed")!.group).toBe("advanced");
    expect(byFlag("background")!.group).toBe("control");
    expect(byFlag("image_references")!.mediaRole).toBe("image_references");
    expect(byFlag("image_references")!.maxItems).toBe(16);
    expect(schema.fields.some((x) => x.name === "prompt")).toBe(false);
  });

  it("keeps variant advanced for non-GPT models", () => {
    const schema = buildModelSchema({ jobType: "flux_2", params: [{ name: "variant", type: "string", options: ["pro", "flex"] }] });
    expect(schema.fields.find((x) => x.flag === "variant")!.group).toBe("advanced");
  });
});

describe("applyOptionExposure", () => {
  const schema = buildModelSchema({
    jobType: "gpt_image_2_5",
    params: [
      { name: "quality", type: "string", options: ["low", "high"] },
      { name: "variant", type: "string", options: ["flare", "sunburst"] },
      { name: "seed", type: "integer", min: 0, max: 10 },
      { name: "resolution", type: "string", options: ["1k", "2k"] },
    ],
  });
  it("moves a core field (e.g. preset) to advanced", () => {
    const s = buildModelSchema({
      jobType: "bytedance_video_upscale",
      params: [{ name: "preset", type: "string", options: ["common", "aigc"] }],
    });
    expect(s.fields.find((x) => x.flag === "preset")!.group).toBe("core");
    const out = applyOptionExposure(s, "higgsfield-cli:bytedance_video_upscale", {
      "higgsfield-cli:bytedance_video_upscale::preset": "advanced",
    });
    expect(out.fields.find((x) => x.flag === "preset")!.group).toBe("advanced");
  });

  it("moves, hides, and locks fields by override", () => {
    const out = applyOptionExposure(schema, "higgsfield-cli:gpt_image_2_5", {
      "higgsfield-cli:gpt_image_2_5::seed": "core",
      "higgsfield-cli:gpt_image_2_5::variant": "hidden",
      "higgsfield-cli:gpt_image_2_5::resolution": "hidden", // dedicated → locked
    });
    const byFlag = (f: string) => out.fields.find((x) => x.flag === f);
    expect(byFlag("seed")!.group).toBe("core");
    expect(byFlag("variant")).toBeUndefined();
    // resolution is an owned/dedicated flag → the override is ignored.
    expect(byFlag("resolution")).toBeDefined();
  });
});

describe("openArtSchemaFromProps", () => {
  it("builds a schema from form properties (enum + oneOf consts)", () => {
    const schema = openArtSchemaFromProps("some-model", {
      resolution: { type: "string", enum: ["480p", "720p"], default: "720p" },
      aspect_ratio: { type: "string", enum: ["16:9", "9:16"] },
      duration: { oneOf: [{ const: 5 }, { const: 8 }] },
      cfg_scale: { type: "number", enum: [1, 2, 3] },
      prompt: { type: "string" },
    });
    const byFlag = (f: string) => schema.fields.find((x) => x.flag === f);
    expect(byFlag("resolution")!.values).toEqual(["480p", "720p"]);
    expect(byFlag("duration")!.values).toEqual(["5", "8"]);
    expect(schema.aspectRatios).toEqual(["16:9", "9:16"]);
    expect(byFlag("cfg_scale")!.group).toBe("control");
    expect(schema.fields.some((x) => x.name === "prompt")).toBe(false);
  });
});

describe("optionFieldsFromModelOptions", () => {
  it("builds exposed fields and keeps advanced params advanced", () => {
    const fields = optionFieldsFromModelOptions(
      {
        qualities: ["low", "high"],
        resolutions: ["1k", "2k"],
        defaultResolution: "2k",
        aspectRatios: ["1:1", "16:9"],
        submodels: ["flare", "sunburst"],
        defaultSubmodel: "flare",
        params: [{ flag: "--mode", key: "mode", values: ["std", "quality"], exposure: "advanced" }],
      },
      "image"
    );
    const core = fields.filter((f) => f.group === "core").map((f) => f.name);
    expect(core).toEqual(["aspectratio", "resolution", "quality", "variant"]);
    expect(fields.find((f) => f.name === "mode")?.group).toBe("advanced");
    expect(fields.find((f) => f.name === "aspectratio")?.default).toBe("16:9");
  });
});
