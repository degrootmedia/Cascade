import { describe, expect, it } from "vitest";
import { boardFrameHistory } from "../src/shared/board-frames.js";
import type { ProductionShot } from "../src/shared/ipc.js";

function makeShot(overrides: Partial<ProductionShot> = {}): ProductionShot {
  return { id: "shot1", number: "0100", audio: "", visual: "Hero walks", ...overrides };
}

describe("boardFrameHistory", () => {
  it("includes both complete node histories, even frames that were never primary", () => {
    const generations = Array.from({ length: 40 }, (_, i) => ({
      path: `boards/0100/frame-${i}.jpg`, prompt: `prompt ${i}`, model: "auto",
      at: new Date(Date.UTC(2026, 8, 7, 0, 39 - i)).toISOString(),
    }));
    const shot = makeShot({
      graphImageGens: generations.filter((_, i) => i % 2 === 0),
      graphEditGens: generations.filter((_, i) => i % 2 === 1),
      artworkHistory: ["boards/0100/legacy.jpg", generations[0].path, "boards/0100/older.jpg"],
    });
    expect(boardFrameHistory(shot)).toEqual([
      ...generations.map((g) => g.path), "boards/0100/legacy.jpg", "boards/0100/older.jpg",
    ]);
    expect(shot.artworkHistory).toHaveLength(3);
  });

  it("sorts newest-first with stable ties and empty timestamps, then appends deduped legacy paths", () => {
    const shot = makeShot({
      artwork: "current.jpg",
      graphImageGens: [
        { path: "image-blank-1.jpg", prompt: "", model: "", at: "" },
        { path: "image-tie-1.jpg", prompt: "i1", model: "m1", at: "2026-09-06T00:00:00.000Z" },
        { path: "image-tie-2.jpg", prompt: "i2", model: "m2", at: "2026-09-06T00:00:00.000Z" },
        { path: "image-blank-2.jpg", prompt: "", model: "", at: "" },
        { path: "current.jpg", prompt: "current", model: "m", at: "2026-09-07T00:00:00.000Z" },
      ],
      graphEditGens: [
        { path: "edit-tie.jpg", prompt: "e1", model: "m3", at: "2026-09-06T00:00:00.000Z" },
        { path: "edit-new.jpg", prompt: "e2", model: "m4", at: "2026-09-07T00:00:00.000Z" },
        { path: "image-tie-1.jpg", prompt: "duplicate", model: "m", at: "2026-09-05T00:00:00.000Z" },
        { path: "edit-blank.jpg", prompt: "", model: "", at: "" },
        { path: "", prompt: "", model: "", at: "" },
      ],
      artworkHistory: ["legacy.jpg", "edit-new.jpg", "current.jpg", "", "legacy.jpg", "older.jpg"],
    });
    const before = structuredClone(shot);
    Object.freeze(shot.graphImageGens);
    Object.freeze(shot.graphEditGens);
    Object.freeze(shot.artworkHistory);
    expect(boardFrameHistory(shot)).toEqual([
      "edit-new.jpg", "image-tie-1.jpg", "image-tie-2.jpg", "edit-tie.jpg",
      "image-blank-1.jpg", "image-blank-2.jpg", "edit-blank.jpg", "legacy.jpg", "older.jpg",
    ]);
    expect(shot).toEqual(before);
  });

  it("orders ISO timestamps by instant, including offsets and equivalent timestamp formats", () => {
    const shot = makeShot({
      graphImageGens: [
        { path: "older.jpg", prompt: "", model: "", at: "2026-09-07T12:00:00+02:00" },
        { path: "same-image.jpg", prompt: "", model: "", at: "2026-09-07T11:00:00Z" },
      ],
      graphEditGens: [
        { path: "same-edit.jpg", prompt: "", model: "", at: "2026-09-07T11:00:00.000Z" },
        { path: "newest.jpg", prompt: "", model: "", at: "2026-09-07T11:00:00.001Z" },
      ],
    });
    expect(boardFrameHistory(shot)).toEqual(["newest.jpg", "same-image.jpg", "same-edit.jpg", "older.jpg"]);
  });

  it("keeps the current still selectable under video output without duplicating it", () => {
    const shot = makeShot({
      artwork: "current.jpg", videoPath: "clip.mp4", graphOutputSource: "videogen",
      graphImageGens: [{ path: "current.jpg", prompt: "p", model: "m", at: "" }],
      artworkHistory: ["current.jpg", "older.jpg"],
      graphVideoGens: [{ path: "clip.mp4", prompt: "p", model: "m", at: "" }],
    });
    expect(boardFrameHistory(shot)).toEqual(["current.jpg", "older.jpg"]);
    shot.videoPath = undefined;
    expect(boardFrameHistory(shot)).toEqual(["older.jpg"]);
  });

  it("also exposes an untracked current legacy still when the output is video", () => {
    const shot = makeShot({ artwork: "legacy.jpg", videoPath: "clip.mp4" });
    expect(boardFrameHistory(shot)).toEqual(["legacy.jpg"]);
    shot.videoPath = undefined;
    expect(boardFrameHistory(shot)).toEqual([]);
  });

  it("handles absent histories and omits empty paths", () => {
    expect(boardFrameHistory(makeShot())).toEqual([]);
    expect(boardFrameHistory(makeShot({
      artwork: "", artworkHistory: ["", "old.jpg", "old.jpg"],
      graphImageGens: [{ path: "", prompt: "", model: "", at: "" }],
    }))).toEqual(["old.jpg"]);
  });
});
