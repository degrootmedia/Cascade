/**
 * Media model classification + ordering (shared/ipc.ts) — the pure helpers
 * every generation dropdown rides on. No Electron.
 */
import { describe, it, expect } from "vitest";
import { isImageModel, isVideoModel, sortByModelOrder, type OpenArtModelChoice } from "../src/shared/ipc.js";

const choice = (over: Partial<OpenArtModelChoice>): OpenArtModelChoice => ({
  id: "m",
  displayName: "M",
  description: "",
  imageInput: false,
  videoInput: false,
  cost: null,
  ...over,
});

describe("isImageModel / isVideoModel", () => {
  it("classifies a pure image model", () => {
    const m = choice({ imageInput: true, videoInput: false });
    expect(isImageModel(m)).toBe(true);
    expect(isVideoModel(m)).toBe(false);
  });

  it("never classifies a video model as image — video models flag imageInput too (image-to-video)", () => {
    const m = choice({ imageInput: true, videoInput: true });
    expect(isImageModel(m)).toBe(false);
    expect(isVideoModel(m)).toBe(true);
  });

  it("classifies a text-to-video model as video only", () => {
    const m = choice({ imageInput: false, videoInput: true });
    expect(isImageModel(m)).toBe(false);
    expect(isVideoModel(m)).toBe(true);
  });

  it("an 'image' kind override (videoInput cleared) classifies as image", () => {
    const m = choice({ imageInput: true, videoInput: false });
    expect(isImageModel(m)).toBe(true);
  });
});

describe("sortByModelOrder", () => {
  it("orders models by the saved arrangement", () => {
    const items = ["a", "b", "c"].map((id) => ({ id }));
    expect(sortByModelOrder(items, ["c", "a", "b"], (x) => x.id).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("appends unknown models after the known ones, keeping discovery order", () => {
    const items = ["x", "a", "y", "b"].map((id) => ({ id }));
    expect(sortByModelOrder(items, ["b", "a"], (x) => x.id).map((x) => x.id)).toEqual(["b", "a", "x", "y"]);
  });

  it("passes through untouched for an empty order (stable)", () => {
    const items = ["b", "a"].map((id) => ({ id }));
    expect(sortByModelOrder(items, [], (x) => x.id).map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the input list", () => {
    const items = ["a", "b"].map((id) => ({ id }));
    sortByModelOrder(items, ["b", "a"], (x) => x.id);
    expect(items.map((x) => x.id)).toEqual(["a", "b"]);
  });
});
