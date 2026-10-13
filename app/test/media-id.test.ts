/**
 * Media identity conversion (Step 6c foundation): generation takes carry
 * the stable registry id for their file alongside the compatibility path.
 * A file move re-points the registry entry; resolving by id follows it.
 */
import { describe, it, expect, vi } from "vitest";
import type { Production } from "../src/shared/ipc.js";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { backfillGenerationMediaIds } from "../src/main/productions.js";
import { mediaEntryForId, mediaPathForId, remapMediaPaths, type MediaEntry } from "../src/shared/media-registry.js";

const entry = (id: string, path: string): MediaEntry => ({ id, path, kind: "image", origin: "generated", state: "present" });

function prod(): Production {
  return {
    media: [entry("m-1", "boards/0100/a.jpg"), entry("m-2", "boards/0100/clip.mp4")],
    scenes: [{
      number: 1, title: "S1",
      shots: [{
        id: "s1", number: "0100", audio: "", visual: "",
        graphImageGens: [{ path: "boards/0100/a.jpg", prompt: "", model: "", at: "" }],
        graphVideoNodes: [{ id: "vid0", prompt: "", gens: [{ path: "boards/0100/clip.mp4", prompt: "", model: "", at: "" }] }],
      }],
    }],
  } as unknown as Production;
}

describe("backfillGenerationMediaIds", () => {
  it("attaches registry ids to takes and keeps them on a second pass", () => {
    const p = prod();
    backfillGenerationMediaIds(p);
    const shot = p.scenes[0].shots[0];
    expect(shot.graphImageGens?.[0].mediaId).toBe("m-1");
    expect(shot.graphVideoNodes?.[0].gens?.[0].mediaId).toBe("m-2");
    backfillGenerationMediaIds(p);
    expect(shot.graphImageGens?.[0].mediaId).toBe("m-1");
  });

  it("resolving by id follows a file move; the take's stored id does not change", () => {
    const p = prod();
    backfillGenerationMediaIds(p);
    const moved = remapMediaPaths(p.media, (rel) => (rel === "boards/0100/a.jpg" ? "boards/0100/moved-a.jpg" : rel));
    expect(mediaPathForId(moved, "m-1")).toBe("boards/0100/moved-a.jpg");
    expect(mediaEntryForId(moved, p.scenes[0].shots[0].graphImageGens?.[0].mediaId)?.path).toBe("boards/0100/moved-a.jpg");
    expect(mediaPathForId(moved, "nope")).toBeUndefined();
  });
});
