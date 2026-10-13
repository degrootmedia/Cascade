/**
 * Thumbnail still resolution: a video-piped shot's printable/paintable
 * still is its feed still — never the clip file (a thumbnail renderer
 * asked for the mp4 comes back empty, which the timeline showed as a
 * missing link while the viewer played the clip fine).
 */
import { describe, it, expect } from "vitest";
import { shotStillRel } from "../src/shared/selected-output.js";
import type { ProductionShot } from "../src/shared/ipc.js";

const shot = (over: Partial<ProductionShot> = {}): ProductionShot =>
  ({ id: "s1", number: "0100", audio: "", visual: "", ...over }) as ProductionShot;

describe("shotStillRel", () => {
  it("a video-piped shot resolves its feed still, not the clip", () => {
    const s = shot({
      graphOutputSource: "videogen",
      graphOutputVideoNodeId: "vid0",
      graphVideoNodes: [{ id: "vid0", prompt: "", gens: [{ path: "boards/0100/clip.mp4", prompt: "", model: "", at: "" }], genIndex: 0 }],
      graphImageGens: [{ path: "boards/0100/feed.jpg", prompt: "", model: "", at: "" }],
      graphImageGenIndex: 0,
    });
    expect(shotStillRel(s)).toBe("boards/0100/feed.jpg");
  });

  it("a legacy clip mirror resolves its artwork still", () => {
    const s = shot({ videoPath: "boards/0100/clip.mp4", artwork: "boards/0100/feed.jpg" });
    expect(shotStillRel(s)).toBe("boards/0100/feed.jpg");
  });

  it("an image-piped shot resolves its selected still", () => {
    const s = shot({
      graphOutputSource: "imagegen",
      graphImageGens: [{ path: "boards/0100/a.jpg", prompt: "", model: "", at: "" }],
      graphImageGenIndex: 0,
    });
    expect(shotStillRel(s)).toBe("boards/0100/a.jpg");
  });

  it("a shot with no frame resolves nothing", () => {
    expect(shotStillRel(shot())).toBeUndefined();
  });
});
