/**
 * Image Suite A/B resolution. The pairing rules (explicit A/B vs branch
 * parent, explicit A/B with no parent vs selection, edit before/after, seed
 * reveal) live in `suite-compare.ts`, so the React canvas only renders the
 * frames it returns.
 */
import { describe, it, expect } from "vitest";
import type { Production, SuiteEntry } from "../src/shared/ipc.js";
import {
  entrySourceFrame,
  referenceArtworkUrl,
  resolveSuiteCompare,
  seedSourceFrame,
} from "../src/renderer/src/features/suite/suite-compare.js";

const media = (rel: string) => `media:${rel}`;

function entry(id: string, over: Partial<SuiteEntry> = {}): SuiteEntry {
  return {
    id,
    parentId: null,
    kind: "generate",
    createdAt: "2020-01-01T00:00:00.000Z",
    model: "m",
    resolution: "1k",
    prompt: "",
    promptRefs: [],
    outputPath: `out/suite/${id}.png`,
    refIds: [],
    ...over,
  };
}

function prod(over: Partial<Production> = {}): Production {
  return { characters: [], products: [], references: [], ...over } as unknown as Production;
}

describe("referenceArtworkUrl", () => {
  it("prefers imagePath over a legacy inline artwork", () => {
    const p = prod({ references: [{ id: "r1", name: "R", imagePath: "references/r1.png", artwork: "data:old" }] as Production["references"] });
    expect(referenceArtworkUrl(p, "r1", media)).toBe("media:references/r1.png");
  });

  it("falls back to artwork and searches characters + products too", () => {
    const p = prod({
      characters: [{ id: "c1", name: "C", artwork: "data:char" }] as Production["characters"],
      products: [{ id: "pr1", name: "P", imagePath: "references/pr1.jpg" }] as Production["products"],
    });
    expect(referenceArtworkUrl(p, "c1", media)).toBe("data:char");
    expect(referenceArtworkUrl(p, "pr1", media)).toBe("media:references/pr1.jpg");
    expect(referenceArtworkUrl(p, "missing", media)).toBeNull();
  });
});

describe("resolveSuiteCompare", () => {
  it("resolves a selected edit against its source path (before/after)", () => {
    const edit = entry("e", { kind: "edit", sourcePath: "boards/0100/f.png" });
    const pair = resolveSuiteCompare({ entries: [edit], selectedId: "e", prod: prod(), media });
    expect(pair).toEqual({
      a: { url: "media:boards/0100/f.png", rel: "boards/0100/f.png", label: "Before edit" },
      b: { url: "media:out/suite/e.png", rel: "out/suite/e.png", label: "After edit" },
    });
  });

  it("resolves a selected edit's reference source from the production", () => {
    const edit = entry("e", { kind: "edit", sourceRefId: "r1" });
    const pair = resolveSuiteCompare({
      entries: [edit],
      selectedId: "e",
      prod: prod({ references: [{ id: "r1", name: "R", imagePath: "references/r1.png" }] as Production["references"] }),
      media,
    });
    expect(pair?.a).toEqual({ url: "media:references/r1.png", rel: "references/r1.png", label: "Before edit" });
  });

  it("returns null when a generate entry is selected with no source", () => {
    const gen = entry("g");
    expect(resolveSuiteCompare({ entries: [gen], selectedId: "g", prod: prod(), media })).toBeNull();
  });

  it("returns null when the selected edit's source cannot be resolved", () => {
    const edit = entry("e", { kind: "edit", sourceRefId: "missing" });
    expect(resolveSuiteCompare({ entries: [edit], selectedId: "e", prod: prod(), media })).toBeNull();
  });
});

describe("seedSourceFrame", () => {
  it("resolves a sourceRefId seed", () => {
    const p = prod({ characters: [{ id: "c1", name: "C", imagePath: "references/c1.png" }] as Production["characters"] });
    expect(seedSourceFrame({ sourceRefId: "c1" }, p, media)).toEqual({ url: "media:references/c1.png", rel: "references/c1.png", label: "Before edit" });
  });

  it("resolves a sourcePath seed and nulls an empty seed", () => {
    expect(seedSourceFrame({ sourcePath: "boards/0200/a.jpg" }, prod(), media)).toEqual({ url: "media:boards/0200/a.jpg", rel: "boards/0200/a.jpg", label: "Before edit" });
    expect(seedSourceFrame({}, prod(), media)).toBeNull();
    expect(seedSourceFrame({ sourceRefId: "missing" }, prod(), media)).toBeNull();
  });
});

describe("entrySourceFrame", () => {
  it("prefers a reference id over a path", () => {
    const e = entry("e", { kind: "edit", sourceRefId: "r1", sourcePath: "boards/x.png" });
    const p = prod({ references: [{ id: "r1", name: "R", imagePath: "references/r1.png" }] as Production["references"] });
    expect(entrySourceFrame(e, p, media)).toEqual({ url: "media:references/r1.png", rel: "references/r1.png", label: "Before edit" });
  });
});
