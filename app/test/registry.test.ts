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

import { applyKindOverrides } from "../src/main/providers/registry.js";
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
