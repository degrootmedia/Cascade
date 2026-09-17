/**
 * Media-provider registry tests — the manual kind-override helper. Pure data
 * in/out (no provider instances needed), so the seam is the function itself.
 * The Higgsfield vendor is mocked: it drags in pipeline → scripting →
 * pdf-parse, which can't resolve in the test env, and the helper under test
 * never touches a provider.
 */
import { describe, it, expect, vi } from "vitest";

// scripting.ts pulls pdf-parse, which can't resolve in the test env (same
// reason openart.test.ts mocks it). The helper under test never touches it.
vi.mock("../src/main/scripting.js", () => ({}));

import { applyKindOverrides, getMediaCredits, mediaForModel, providerOfModelId } from "../src/main/providers/registry.js";
import type { OpenArtModelChoice } from "../src/shared/ipc.js";

const choice = (over: Partial<OpenArtModelChoice> = {}): OpenArtModelChoice => ({
  id: "m",
  displayName: "M",
  description: "",
  imageInput: true,
  videoInput: false,
  cost: null,
  ...over,
});

describe("applyKindOverrides", () => {
  it("forces flags to the manual kind and passes the rest through untouched", () => {
    const choices = [
      choice({ id: "img", imageInput: true, videoInput: false }),
      choice({ id: "vid", imageInput: true, videoInput: true }),
      choice({ id: "other", imageInput: true, videoInput: false }),
    ];
    const out = applyKindOverrides(choices, { vid: "image", img: "video" });
    // Forced to image: video flag cleared.
    expect(out[1]).toMatchObject({ id: "vid", imageInput: true, videoInput: false });
    // Forced to video: video flag set, image input kept.
    expect(out[0]).toMatchObject({ id: "img", imageInput: true, videoInput: true });
    // Unassigned models keep identity.
    expect(out[2]).toBe(choices[2]);
  });

  it("returns the input untouched when there are no overrides (or unknown ids)", () => {
    const choices = [choice({ id: "m" })];
    expect(applyKindOverrides(choices, {})).toBe(choices);
    const out = applyKindOverrides(choices, { nope: "video" });
    expect(out[0]).toBe(choices[0]);
  });
});

describe("providerOfModelId", () => {
  it("routes higgsfield-cli: and legacy higgsfield: picks to higgsfield-cli and defers the rest to active", () => {
    expect(providerOfModelId("higgsfield:seedance_2_5")).toBe("higgsfield-cli");
    expect(providerOfModelId("higgsfield-cli:seedance_2_5")).toBe("higgsfield-cli");
    expect(providerOfModelId("openart-cli:nano-banana-2")).toBe("openart-cli");
    expect(providerOfModelId("auto")).toBeNull();
    expect(providerOfModelId("")).toBeNull();
    expect(providerOfModelId(undefined)).toBeNull();
    expect(providerOfModelId("gemini-video")).toBeNull();
  });
});

describe("mediaForModel", () => {
  it("sends a saved Seedance pick to Higgsfield CLI even when the global is OpenArt", () => {
    const openart = { id: "openart" };
    const cli = { id: "higgsfield-cli" };
    const ocli = { id: "openart-cli" };
    const providers = { openart, "higgsfield-cli": cli, "openart-cli": ocli } as any;
    expect(mediaForModel(providers, "openart", "higgsfield:seedance_2_5")).toBe(cli);
    expect(mediaForModel(providers, "openart", "gemini-foo")).toBe(openart);
    expect(mediaForModel(providers, "openart", "auto")).toBe(openart);
    expect(mediaForModel(providers, "higgsfield-cli", "higgsfield:seedance_2_5")).toBe(cli);
    expect(mediaForModel(providers, "openart", "higgsfield-cli:seedance_2_0")).toBe(cli);
    expect(mediaForModel(providers, "higgsfield-cli", "higgsfield-cli:seedance_2_0")).toBe(cli);
    expect(mediaForModel(providers, "openart", "openart-cli:nano-banana-2")).toBe(ocli);
    expect(mediaForModel(providers, "higgsfield-cli", "openart-cli:nano-banana-2")).toBe(ocli);
  });
});

describe("getMediaCredits", () => {
  const stub = (credits: number | null | Error) =>
    ({
      getCredits: async () => {
        if (credits instanceof Error) throw credits;
        return credits;
      },
    }) as any;

  it("returns every vendor's balance at once", async () => {
    await expect(
      getMediaCredits({ openart: stub(42), "higgsfield-cli": stub(99.5), "openart-cli": stub(250) })
    ).resolves.toEqual({ openart: 42, "higgsfield-cli": 99.5, "openart-cli": 250 });
  });

  it("isolates a failure to its own vendor", async () => {
    await expect(
      getMediaCredits({ openart: stub(new Error("down")), "higgsfield-cli": stub(1), "openart-cli": stub(2) })
    ).resolves.toEqual({ openart: null, "higgsfield-cli": 1, "openart-cli": 2 });
    await expect(
      getMediaCredits({ openart: stub(7), "higgsfield-cli": stub(new Error("no binary")), "openart-cli": stub(null) })
    ).resolves.toEqual({ openart: 7, "higgsfield-cli": null, "openart-cli": null });
  });
});
