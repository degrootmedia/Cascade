/**
 * Higgsfield CLI model labels — same-named catalogue rows (Nano Banana Pro,
 * Topaz, Grok Image 2) are distinct catalogue items (different functions /
 * variants), not quality tiers of one model. The provider annotates each row
 * with its family + capability so the dropdowns stay distinguishable.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import {
  classifyFamily,
  shapeHiggsfieldCliChoices,
  HIGGSFIELD_CLI_ID_PREFIX,
} from "../src/main/providers/higgsfield-cli.js";

describe("classifyFamily", () => {
  it("classifies upscalers separately from generators", () => {
    expect(classifyFamily("topaz-upscale")?.kind).toBe("upscale");
    expect(classifyFamily("Topaz_Upscale_4K")?.kind).toBe("upscale");
  });

  it("labels Nano Banana rows as the Google text-to-image family", () => {
    const fam = classifyFamily("nano-banana-2");
    expect(fam?.kind).toBe("image");
    expect(fam?.label).toMatch(/Nano Banana/);
  });

  it("tells Grok Image (image) apart from Grok Imagine (video)", () => {
    expect(classifyFamily("grok-image-2")?.kind).toBe("image");
    expect(classifyFamily("grok-imagine-1-5")?.kind).toBe("video");
  });

  it("returns null for unrecognized ids", () => {
    expect(classifyFamily("seedance_2_5")).toBeNull();
    expect(classifyFamily("")).toBeNull();
  });
});

describe("shapeHiggsfieldCliChoices", () => {
  it("never produces duplicate display labels for distinct ids", () => {
    const choices = shapeHiggsfieldCliChoices(
      [
        { job_type: "nano-banana-pro-4k", display_name: "Nano Banana Pro" },
        { job_type: "nano-banana-pro-2k", display_name: "Nano Banana Pro" },
        { job_type: "topaz-upscale", display_name: "Topaz" },
        { job_type: "grok-image-2", display_name: "Grok Image 2" },
      ],
      "image"
    );
    const labels = choices.map((c) => c.displayName);
    expect(new Set(labels).size).toBe(labels.length);
    expect(choices.every((c) => c.id.startsWith(HIGGSFIELD_CLI_ID_PREFIX))).toBe(true);
  });

  it("keeps ids stable so generation routing is untouched", () => {
    const choices = shapeHiggsfieldCliChoices([{ job_type: "nano_banana_2", name: "Nano Banana Pro" }], "image");
    expect(choices).toHaveLength(1);
    expect(choices[0].id).toBe(`${HIGGSFIELD_CLI_ID_PREFIX}nano_banana_2`);
    expect(choices[0].displayName).toMatch(/Nano Banana/);
  });

  it("states that Topaz is an upscaler, not a generator", () => {
    const choices = shapeHiggsfieldCliChoices(
      [{ job_type: "topaz-upscale", display_name: "Topaz Upscale", description: "Upscaler." }],
      "image"
    );
    expect(choices[0].displayName).toMatch(/Upscale/);
    expect(choices[0].description ?? "").toMatch(/does not generate from a prompt/);
  });

  it("uses variant fields to tell same-family rows apart", () => {
    const choices = shapeHiggsfieldCliChoices(
      [
        { job_type: "m-4k", display_name: "M", resolution: "4K" },
        { job_type: "m-2k", display_name: "M", resolution: "2K" },
      ],
      "image"
    );
    expect(choices[0].displayName).toContain("4K");
    expect(choices[1].displayName).toContain("2K");
  });

  it("skips auto/empty ids and preserves the image/video classification", () => {
    const image = shapeHiggsfieldCliChoices([{ job_type: "auto" }, { job_type: "", }, { job_type: "a1" }], "image");
    expect(image.map((c) => c.id)).toEqual([`${HIGGSFIELD_CLI_ID_PREFIX}a1`]);
    expect(image[0]).toMatchObject({ imageInput: true, videoInput: false });
    const video = shapeHiggsfieldCliChoices([{ job_type: "v1" }], "video");
    expect(video[0]).toMatchObject({ imageInput: false, videoInput: true });
  });
});
