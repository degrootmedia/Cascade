/**
 * Narrow graph-field command (Step 2): `production:updateGraphShotFields`
 * applies only allow-listed renderer-owned fields onto the freshest shot.
 * These tests pin the merge the command runs, the allow-list's agreement
 * with the field-ownership table, and the IPC payload validation.
 */
import { describe, it, expect, vi } from "vitest";
import type { ProductionShot } from "../src/shared/ipc.js";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { applyGraphShotPatch } from "../src/main/productions.js";
import { GRAPH_SHOT_PATCH_FIELDS, pickGraphShotPatch } from "../src/shared/graph/shot-patch.js";
import { SHOT_FIELD_OWNERSHIP } from "../src/main/shot-ownership.js";

function freshShot(): ProductionShot {
  return {
    id: "s1",
    number: "0100",
    audio: "",
    visual: "",
    graphVideoNodes: [
      { id: "vid0", prompt: "old prompt", gens: [{ path: "new.mp4", prompt: "", model: "", at: "" }], genIndex: 0 },
    ],
    graphImageGens: [{ path: "fresh.jpg", prompt: "", model: "", at: "" }],
    graphImageGenIndex: 0,
  } as ProductionShot;
}

describe("applyGraphShotPatch", () => {
  it("applies the edited field without erasing a generation that landed later", () => {
    const stalePatch = {
      graphVideoNodes: [{ id: "vid0", prompt: "edited prompt", gens: [], genIndex: 0 }],
      graphOutputSource: "videogen",
    } as Partial<ProductionShot>;
    const merged = applyGraphShotPatch(freshShot(), stalePatch);
    expect(merged.graphVideoNodes?.[0].prompt).toBe("edited prompt");
    expect(merged.graphVideoNodes?.[0].gens?.map((g) => g.path)).toEqual(["new.mp4"]);
    expect(merged.graphOutputSource).toBe("videogen");
  });

  it("ignores main-owned fields carried in a patch", () => {
    const merged = applyGraphShotPatch(freshShot(), {
      artwork: "stale.jpg",
      graphImageGens: [{ path: "stale.jpg", prompt: "", model: "", at: "" }],
    } as Partial<ProductionShot>);
    expect(merged.artwork).toBeUndefined();
    expect(merged.graphImageGens?.map((g) => g.path)).toEqual(["fresh.jpg"]);
  });

  it("repeating the same patch is a fixed point (retry-safe)", () => {
    const patch = { graphOutputSource: "videogen", graphTweenRefIds: ["r1"] } as Partial<ProductionShot>;
    const once = applyGraphShotPatch(freshShot(), patch);
    expect(applyGraphShotPatch(once, patch)).toEqual(once);
  });
});

describe("graph shot patch allow-list", () => {
  it("every allowed field is renderer-owned or deprecated in the ownership table", () => {
    for (const field of GRAPH_SHOT_PATCH_FIELDS) {
      const policy = SHOT_FIELD_OWNERSHIP[field as keyof ProductionShot];
      expect(policy, field).toBeDefined();
      expect(["renderer", "deprecated"], field).toContain(policy.owner);
    }
  });

  it("pickGraphShotPatch drops non-listed keys and keeps explicit clears", () => {
    const picked = pickGraphShotPatch({ graphOutputSource: undefined, artwork: "x.jpg" });
    expect(Object.keys(picked)).toEqual(["graphOutputSource"]);
    expect("graphOutputSource" in picked).toBe(true);
  });
});

describe("updateGraphShotFields payload validation", () => {
  it("accepts a well-formed patch and rejects disallowed fields", async () => {
    const { validateIpcArgs } = await import("../src/shared/ipc-schemas.js");
    expect(() =>
      validateIpcArgs("production:updateGraphShotFields", ["p1", "s1", { graphOutputSource: "videogen" }])
    ).not.toThrow();
    expect(() =>
      validateIpcArgs("production:updateGraphShotFields", ["p1", "s1", { artwork: "x.jpg" }])
    ).toThrow(/not allowed/);
    expect(() =>
      validateIpcArgs("production:updateGraphShotFields", ["p1", "s1", "nope"])
    ).toThrow(/must be an object/);
  });
});
