/**
 * shotter tests — the 4-digit numbering module. Pins the scene-level helpers
 * (blankScenes, insertScene) and the shot-insert/reorder behavior that keeps
 * numbers and board folders consistent.
 */
import { describe, it, expect } from "vitest";
import type { ProductionScene } from "../src/shared/ipc.js";
import {
  FIRST_NUMBER,
  blankScenes,
  insertMid,
  insertScene,
  insertShotAt,
  nextNumber,
  reorderShot,
  renumber,
  validate,
} from "../src/main/shotter.js";

function scene(number: number, numbers: string[]): ProductionScene {
  return {
    number,
    title: `Scene ${number}`,
    shots: numbers.map((n) => ({ id: `id-${n}`, number: n, audio: "", visual: "" })),
  };
}

describe("blankScenes", () => {
  it("starts with one scene of five blank shots on the 100-grid", () => {
    const scenes = blankScenes();
    expect(scenes).toHaveLength(1);
    expect(scenes[0].number).toBe(1);
    expect(scenes[0].shots).toHaveLength(5);
    expect(scenes[0].shots.map((s) => s.number)).toEqual([
      "0100", "0200", "0300", "0400", "0500",
    ]);
    for (const shot of scenes[0].shots) {
      expect(shot.audio).toBe("");
      expect(shot.visual).toBe("");
      expect(shot.id).toBeTruthy();
    }
    expect(validate(scenes)).toEqual([]);
  });
});

describe("insertScene", () => {
  it("appends at the end when after is null", () => {
    const scenes = [scene(1, ["0100"]), scene(2, ["0200"])];
    const added = insertScene(scenes, null);
    expect(scenes).toHaveLength(3);
    expect(added.shots).toEqual([]);
    expect(scenes.map((s) => s.number)).toEqual([1, 2, 3]);
  });

  it("inserts after the given scene and renumbers later ordinals", () => {
    const scenes = [scene(1, ["0100"]), scene(2, ["0200"]), scene(3, ["0300"])];
    insertScene(scenes, 2);
    expect(scenes).toHaveLength(4);
    expect(scenes[2].title).toBe("New Scene");
    expect(scenes.map((s) => s.number)).toEqual([1, 2, 3, 4]);
    // Shot numbers are untouched — scene ordinals are display-only.
    expect(scenes.flatMap((s) => s.shots.map((x) => x.number))).toEqual(["0100", "0200", "0300"]);
  });

  it("inserts before the first scene when after is 0", () => {
    const scenes = [scene(1, ["0100"]), scene(2, ["0200"])];
    insertScene(scenes, 0);
    expect(scenes.map((s) => s.number)).toEqual([1, 2, 3]);
    expect(scenes[0].title).toBe("New Scene");
  });

  it("throws when the anchor scene does not exist", () => {
    expect(() => insertScene([scene(1, ["0100"])], 7)).toThrow(/Scene 7 not found/);
  });
});

describe("insertShotAt", () => {
  it("mid-numbers between neighbours without renumbering", () => {
    const scenes = [scene(1, ["0100", "0200"])];
    const shot = insertShotAt(scenes, 1, 1);
    expect(shot.number).toBe("0150");
    expect(scenes[0].shots.map((s) => s.number)).toEqual(["0100", "0150", "0200"]);
    expect(validate(scenes)).toEqual([]);
  });

  it("renumbers the show on the 100-grid when the gap is exhausted", () => {
    const scenes = [scene(1, ["0100", "0101"])];
    const shot = insertShotAt(scenes, 1, 1);
    expect(shot.number).toBe("0200");
    expect(scenes[0].shots.map((s) => s.number)).toEqual(["0100", "0200", "0300"]);
    expect(validate(scenes)).toEqual([]);
  });

  it("inserts at the front and renumbers from 0100", () => {
    const scenes = [scene(1, ["0100", "0200"])];
    const shot = insertShotAt(scenes, 1, 0);
    expect(shot.number).toBe(FIRST_NUMBER);
    expect(scenes[0].shots.map((s) => s.number)).toEqual(["0100", "0200", "0300"]);
    expect(validate(scenes)).toEqual([]);
  });

  it("extends the grid when appending after the last shot", () => {
    const scenes = [scene(1, ["0100"]), scene(2, ["0200"])];
    const shot = insertShotAt(scenes, 2, 1);
    expect(shot.number).toBe("0300");
    expect(validate(scenes)).toEqual([]);
  });
});

describe("reorderShot", () => {
  it("moves a shot across scenes and renumbers, reporting old numbers", () => {
    const scenes = [scene(1, ["0100", "0200"]), scene(2, ["0300"])];
    const { oldNumbers } = reorderShot(scenes, "id-0300", "id-0100");
    expect(scenes[0].shots.map((s) => s.id)).toEqual(["id-0300", "id-0100", "id-0200"]);
    expect(scenes[0].shots.map((s) => s.number)).toEqual(["0100", "0200", "0300"]);
    expect(oldNumbers.get("id-0300")).toBe("0300");
    expect(validate(scenes)).toEqual([]);
  });
});

describe("numbering primitives", () => {
  it("advances on the 100-grid and mid-numbers the gap", () => {
    expect(nextNumber("0100")).toBe("0200");
    expect(insertMid("0100", "0200")).toBe("0150");
    expect(insertMid("0150", "0151")).toBeNull();
  });

  it("renumber re-derives the global grid across scenes", () => {
    const scenes = [scene(1, ["0400"]), scene(2, ["0420", "9999"])];
    renumber(scenes);
    expect(scenes.flatMap((s) => s.shots.map((x) => x.number))).toEqual(["0100", "0200", "0300"]);
  });
});
