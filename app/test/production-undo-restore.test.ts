/**
 * App-wide undo — main-process restore integration (Item 5 evidence).
 *
 * Drives the REAL persistence funnel: `installProductionHistory` hooks
 * `saveProduction`, mutations compose the same pipeline/shotter calls
 * the IPC handlers make, and undo/redo run the production service
 * against a real temp production folder — so board-folder archival,
 * renumber relocation, the outdated park, and the undo trash are all
 * asserted on disk, not just in the document.
 */
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

const { dataDir, prodParent } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  const root = `${base}/opencode/cascade-undo-${process.pid}-${Date.now()}`;
  return { dataDir: `${root}/userdata`, prodParent: `${root}/ws` };
});

vi.mock("electron", () => ({ app: { getPath: () => dataDir } }));
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { loadProduction, saveProduction, newProduction, type ProductionFile } from "../src/main/productions.js";
import {
  installProductionHistory,
  undoProduction,
  redoProduction,
  historyState,
  resetProductionHistoryForTests,
} from "../src/main/production-history.js";
import {
  assetPath,
  deleteGeneration,
  deleteShotBoards,
  relocateBoardsForRenumber,
  removeOutdatedShot,
} from "../src/main/pipeline.js";
import * as shotter from "../src/main/shotter.js";
import { projectForHistory } from "../src/shared/production-history.js";

let prod: ProductionFile;
let id: string;

function writeFile(rel: string, content: string): void {
  const abs = assetPath(prod, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}
function readFile(rel: string): string {
  return fs.readFileSync(assetPath(prod, rel), "utf8");
}
function exists(rel: string): boolean {
  return fs.existsSync(assetPath(prod, rel));
}
/** load → mutate → save, exactly one handler-style committed write. */
function commit(mutate: (p: Production) => void): Production {
  const fresh = loadProduction(id)!;
  mutate(fresh);
  saveProduction(fresh);
  return loadProduction(id)!;
}
function proj(p: Production): string {
  return JSON.stringify(projectForHistory(structuredClone(p) as Production));
}
function shotOf(p: Production, shotId: string): ProductionShot {
  return p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId)!;
}

beforeAll(() => {
  fs.mkdirSync(prodParent, { recursive: true });
  installProductionHistory();
  resetProductionHistoryForTests();
  prod = newProduction("HistProd", prodParent);
  id = prod.meta.id;
  // Three shots in two scenes, each with a board frame on disk.
  commit((p) => {
    const mk = (sid: string, number: string): ProductionShot =>
      ({
        id: sid,
        number,
        audio: `audio ${sid}`,
        visual: `visual ${sid}`,
        prompt: `prompt ${sid}`,
        artwork: `boards/${number}/shot-${number}-a.jpg`,
        graphImageGens: [{ path: `boards/${number}/shot-${number}-a.jpg` }],
        graphImageGenIndex: 0,
      }) as ProductionShot;
    p.scenes = [
      { number: 1, title: "Opening", shots: [mk("s1", "0100"), mk("s2", "0200")] },
      { number: 2, title: "Chase", shots: [mk("s3", "0300")] },
    ];
  });
  writeFile("boards/0100/shot-0100-a.jpg", "frame-one");
  writeFile("boards/0200/shot-0200-a.jpg", "frame-two");
  writeFile("boards/0300/shot-0300-a.jpg", "frame-three");
});

afterAll(() => {
  const root = path.dirname(dataDir);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("document restore through the save funnel", () => {
  it("prompt edit: undo/redo restore the document exactly", () => {
    const start = proj(loadProduction(id)!);
    commit((p) => { shotOf(p, "s1").prompt = "edited prompt"; });
    expect(shotOf(loadProduction(id)!, "s1").prompt).toBe("edited prompt");
    const undone = undoProduction(id)!;
    expect(shotOf(undone, "s1").prompt).toBe("prompt s1");
    expect(proj(loadProduction(id)!)).toBe(start);
    const redone = redoProduction(id)!;
    expect(shotOf(redone, "s1").prompt).toBe("edited prompt");
    undoProduction(id); // leave the doc at start for the next case
  });

  it("shot delete: boards folder archives on delete and returns on undo (Item 3)", () => {
    const start = proj(loadProduction(id)!);
    // Mirror the production:deleteShot handler composition.
    commit((p) => {
      const doomed = shotOf(p, "s2");
      deleteShotBoards(p, doomed);
      shotter.removeShotById(p.scenes, "s2");
    });
    expect(loadProduction(id)!.scenes.flatMap((s) => s.shots.map((x) => x.id))).toEqual(["s1", "s3"]);
    expect(exists("boards/0200/shot-0200-a.jpg")).toBe(false);
    expect(exists("boards/outdated/s2/shot-0200-a.jpg")).toBe(true);

    undoProduction(id);
    const back = loadProduction(id)!;
    expect(proj(back)).toBe(start);
    expect(shotOf(back, "s2").artwork).toBe("boards/0200/shot-0200-a.jpg");
    expect(readFile("boards/0200/shot-0200-a.jpg")).toBe("frame-two");
    expect(exists("boards/outdated/s2")).toBe(false);

    redoProduction(id);
    expect(loadProduction(id)!.scenes.flatMap((s) => s.shots.map((x) => x.id))).toEqual(["s1", "s3"]);
    expect(exists("boards/outdated/s2/shot-0200-a.jpg")).toBe(true);
    undoProduction(id);
  });

  it("shot reorder: one step; undo relocates folders and numbers back", () => {
    const start = proj(loadProduction(id)!);
    const depthBefore = historyState(id).depth;
    commit((p) => {
      const { oldNumbers } = shotter.reorderShot(p.scenes, "s3", "s1");
      relocateBoardsForRenumber(p, oldNumbers);
    });
    expect(historyState(id).depth).toBe(depthBefore + 1);
    const moved = loadProduction(id)!;
    expect(moved.scenes.flatMap((s) => s.shots.map((x) => x.id))).toEqual(["s3", "s1", "s2"]);
    expect(shotOf(moved, "s3").number).toBe("0100");
    expect(readFile(shotOf(moved, "s3").artwork!)).toBe("frame-three");

    undoProduction(id);
    const back = loadProduction(id)!;
    expect(proj(back)).toBe(start);
    expect(shotOf(back, "s1").number).toBe("0100");
    expect(readFile("boards/0100/shot-0100-a.jpg")).toBe("frame-one");
    expect(readFile("boards/0300/shot-0300-a.jpg")).toBe("frame-three");

    redoProduction(id);
    expect(shotOf(loadProduction(id)!, "s3").number).toBe("0100");
    undoProduction(id);
  });

  it("scene delete (Feature #12): undo restores the scene, its shots, and folders", () => {
    const start = proj(loadProduction(id)!);
    // Mirror the production:deleteScene handler composition.
    commit((p) => {
      const scene = p.scenes.find((s) => s.number === 1)!;
      for (const s of [...scene.shots]) deleteShotBoards(p, s);
      shotter.deleteScene(p.scenes, 1);
    });
    const gone = loadProduction(id)!;
    expect(gone.scenes.map((s) => s.title)).toEqual(["Chase"]);
    expect(gone.scenes[0].number).toBe(1);
    expect(exists("boards/0100/shot-0100-a.jpg")).toBe(false);

    undoProduction(id);
    const back = loadProduction(id)!;
    expect(proj(back)).toBe(start);
    expect(back.scenes.map((s) => s.title)).toEqual(["Opening", "Chase"]);
    expect(readFile("boards/0100/shot-0100-a.jpg")).toBe("frame-one");
    expect(readFile("boards/0200/shot-0200-a.jpg")).toBe("frame-two");
    redoProduction(id);
    expect(loadProduction(id)!.scenes.map((s) => s.title)).toEqual(["Chase"]);
    undoProduction(id);
  });

  it("generation completion is its own entry; undo unregisters but never deletes the file (Item 4)", () => {
    writeFile("boards/0100/shot-0100-gen.jpg", "generated-bytes");
    const ledgerRel = path.join(dataDir, "ledger", `${id}.json`);
    fs.mkdirSync(path.dirname(ledgerRel), { recursive: true });
    fs.writeFileSync(ledgerRel, JSON.stringify({ entries: [{ id: "e1", amount: 12 }] }), "utf8");
    const ledgerBefore = fs.readFileSync(ledgerRel, "utf8");

    commit((p) => {
      const s = shotOf(p, "s1");
      s.graphImageGens = [{ path: "boards/0100/shot-0100-gen.jpg" } as never, ...(s.graphImageGens ?? [])];
    });
    expect(shotOf(loadProduction(id)!, "s1").graphImageGens).toHaveLength(2);

    undoProduction(id);
    expect(shotOf(loadProduction(id)!, "s1").graphImageGens).toHaveLength(1);
    // The generated file and the ledger are world state: untouched.
    expect(readFile("boards/0100/shot-0100-gen.jpg")).toBe("generated-bytes");
    expect(fs.readFileSync(ledgerRel, "utf8")).toBe(ledgerBefore);
    redoProduction(id);
    expect(shotOf(loadProduction(id)!, "s1").graphImageGens).toHaveLength(2);
    undoProduction(id);
  });

  it("take deletion goes to the undo trash; undo restores entry + bytes", () => {
    writeFile("boards/0100/shot-0100-old.jpg", "old-take");
    commit((p) => {
      const s = shotOf(p, "s1");
      s.graphImageGens = [...(s.graphImageGens ?? []), { path: "boards/0100/shot-0100-old.jpg" } as never];
      s.graphOutputSource = undefined;
    });
    commit((p) => {
      deleteGeneration(p, shotOf(p, "s1"), "boards/0100/shot-0100-old.jpg");
    });
    expect(exists("boards/0100/shot-0100-old.jpg")).toBe(false);
    expect(exists("boards/undo-trash/shot-0100-old.jpg")).toBe(true);

    undoProduction(id);
    const s = shotOf(loadProduction(id)!, "s1");
    expect(s.graphImageGens?.map((g) => g.path)).toContain("boards/0100/shot-0100-old.jpg");
    expect(readFile("boards/0100/shot-0100-old.jpg")).toBe("old-take");
    undoProduction(id); // undo the setup add, leaving a clean baseline
  });

  it("permanent outdated removal parks recoverably; undo un-parks it", () => {
    writeFile("boards/outdated/s9/shot-0900-a.jpg", "outdated-frame");
    commit((p) => {
      p.outdatedShots = [
        {
          id: "s9",
          number: "0900",
          audio: "",
          visual: "",
          artwork: "boards/outdated/s9/shot-0900-a.jpg",
          outdated: true,
        } as ProductionShot,
      ];
    });
    commit((p) => { removeOutdatedShot(p, "s9"); });
    expect(loadProduction(id)!.outdatedShots ?? []).toHaveLength(0);
    expect(exists("boards/outdated/s9/shot-0900-a.jpg")).toBe(false);
    expect(exists("boards/outdated-removed/s9/shot-0900-a.jpg")).toBe(true);

    undoProduction(id);
    const back = loadProduction(id)!;
    expect(back.outdatedShots?.map((s) => s.id)).toEqual(["s9"]);
    expect(readFile("boards/outdated/s9/shot-0900-a.jpg")).toBe("outdated-frame");
    redoProduction(id);
    expect(loadProduction(id)!.outdatedShots ?? []).toHaveLength(0);
    expect(exists("boards/outdated-removed/s9/shot-0900-a.jpg")).toBe(true);
    undoProduction(id);
    undoProduction(id); // undo the setup add
  });

  it("undo at the bottom / redo at the top are null no-ops", () => {
    while (undoProduction(id)) { /* drain */ }
    expect(historyState(id).canUndo).toBe(false);
    expect(undoProduction(id)).toBeNull();
    while (redoProduction(id)) { /* refill */ }
    expect(historyState(id).canRedo).toBe(false);
    expect(redoProduction(id)).toBeNull();
  });
});
