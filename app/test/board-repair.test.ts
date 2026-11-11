/**
 * board-repair tests — orphaned/mis-numbered board folders must never break
 * or silently corrupt a production:
 *  - an orphaned boards/<NNNN> folder (its shot was deleted) does not block a
 *    reorder, and its bytes are never overwritten;
 *  - deleting a shot archives its board folder out of the numbered namespace
 *    so no orphan is left behind;
 *  - a reorder that would genuinely overwrite a live shot's folder still
 *    refuses, and a mid-reorder failure leaves numbers, paths, and folders
 *    exactly as they were (atomicity);
 *  - the repair scan/apply relinks a drifted production (folder renamed to
 *    the shot's current number, stored paths + output pipe restored from the
 *    node graph) and reports frames that are truly missing;
 *  - a frame produced by an image EDIT node is registered as durably as an
 *    image generation: it is the shot's recorded artwork, survives a
 *    save/reopen round-trip and a renumber, and recording never silently
 *    drops a take when its node vanished mid-flight.
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import {
  applyBoardRelinks,
  completeEditGeneration,
  deleteShotBoards,
  recordGraphEditGen,
  rehomeJobFilesAfterRenumber,
  relocateBoardsForRenumber,
  scanBoardRelinks,
} from "../src/main/pipeline.js";
import { resolveShotDisplay } from "../src/shared/selected-output.js";
import { boardFrameHistory } from "../src/shared/board-frames.js";

function makeShot(number: string, overrides: Partial<ProductionShot> = {}): ProductionShot {
  return { id: `shot-${number}`, number, audio: "", visual: `Visual ${number}`, ...overrides };
}

function makeProduction(folder: string, shots: ProductionShot[]): Production {
  return {
    meta: { id: "prod-1", name: "Test", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: [{ number: 1, title: "S1", shots }],
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
  };
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cascade-board-repair-"));
}
function write(root: string, rel: string, bytes: string) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}
function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}
function exists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

describe("orphaned board folders and reorder", () => {
  it("reorders past a colliding orphan folder without overwriting its frames", () => {
    const root = tmp();
    try {
      const shot = makeShot("0100", { id: "a", artwork: "boards/0100/shot-0100-a.jpg" });
      const p = makeProduction(root, [shot]);
      write(root, "boards/0100/shot-0100-a.jpg", "A-bytes");
      // Orphan: boards/0200 exists but no shot numbered 0200 is in the doc.
      write(root, "boards/0200/shot-0200-ghost.jpg", "GHOST-bytes");

      shot.number = "0200";
      const result = relocateBoardsForRenumber(p, new Map([["a", "0100"]]));

      // The shot's frame landed under its new number…
      expect(shot.artwork).toBe("boards/0200/shot-0200-a.jpg");
      expect(read(root, "boards/0200/shot-0200-a.jpg")).toBe("A-bytes");
      // …and the orphan's bytes survive somewhere un-overwritten (parked
      // under the number-free archive namespace, never deleted).
      const parked = result.parkedOrphans.find((o) => o.from === "boards/0200");
      expect(parked, "orphan parked and reported").toBeDefined();
      expect(read(root, `${parked!.to}/shot-0200-ghost.jpg`)).toBe("GHOST-bytes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves a non-colliding orphan folder exactly where it is", () => {
    const root = tmp();
    try {
      const shot = makeShot("0100", { id: "a", artwork: "boards/0100/shot-0100-a.jpg" });
      const p = makeProduction(root, [shot]);
      write(root, "boards/0100/shot-0100-a.jpg", "A-bytes");
      write(root, "boards/0800/shot-0800-ghost.jpg", "GHOST-bytes");

      shot.number = "0200";
      relocateBoardsForRenumber(p, new Map([["a", "0100"]]));

      expect(read(root, "boards/0800/shot-0800-ghost.jpg")).toBe("GHOST-bytes");
      expect(read(root, "boards/0200/shot-0200-a.jpg")).toBe("A-bytes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("still refuses to overwrite a live shot's folder and rolls everything back", () => {
    const root = tmp();
    try {
      const a = makeShot("0100", { id: "a", artwork: "boards/0100/shot-0100-a.jpg" });
      const b = makeShot("0200", { id: "b", artwork: "boards/0200/shot-0200-b.jpg" });
      const c = makeShot("0300", { id: "c", artwork: "boards/0300/shot-0300-c.jpg" });
      const p = makeProduction(root, [a, b, c]);
      write(root, "boards/0100/shot-0100-a.jpg", "A-bytes");
      write(root, "boards/0200/shot-0200-b.jpg", "B-bytes");
      write(root, "boards/0300/shot-0300-c.jpg", "C-bytes");

      // Bogus renumber: a→0400 (would land first), c→0200 collides with the
      // live, unmoved shot b. The whole relocate must refuse atomically.
      a.number = "0400";
      c.number = "0200";
      expect(() =>
        relocateBoardsForRenumber(p, new Map([["a", "0100"], ["c", "0300"]]))
      ).toThrow(/already exists/);

      // Folders restored…
      expect(read(root, "boards/0100/shot-0100-a.jpg")).toBe("A-bytes");
      expect(read(root, "boards/0200/shot-0200-b.jpg")).toBe("B-bytes");
      expect(read(root, "boards/0300/shot-0300-c.jpg")).toBe("C-bytes");
      expect(exists(root, "boards/0400")).toBe(false);
      // …stored paths untouched…
      expect(a.artwork).toBe("boards/0100/shot-0100-a.jpg");
      expect(c.artwork).toBe("boards/0300/shot-0300-c.jpg");
      // …and shot numbers restored to their pre-relocate values.
      expect(a.number).toBe("0100");
      expect(c.number).toBe("0300");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("deleting a shot archives its board folder so a later reorder cannot trip on it", () => {
    const root = tmp();
    try {
      const dead = makeShot("0800", { id: "dead", artwork: "boards/0800/shot-0800-a.jpg" });
      const live = makeShot("0100", { id: "live", artwork: "boards/0100/shot-0100-a.jpg" });
      const p = makeProduction(root, [live, dead]);
      write(root, "boards/0800/shot-0800-a.jpg", "DEAD-bytes");
      write(root, "boards/0100/shot-0100-a.jpg", "LIVE-bytes");

      const archivedTo = deleteShotBoards(p, dead);
      p.scenes[0].shots = [live];

      // Numbered namespace is clean; the frames survive in the archive.
      expect(exists(root, "boards/0800")).toBe(false);
      expect(archivedTo).toBe("boards/outdated/dead");
      expect(read(root, "boards/outdated/dead/shot-0800-a.jpg")).toBe("DEAD-bytes");

      // A renumber onto 0800 now succeeds.
      live.number = "0800";
      expect(() => relocateBoardsForRenumber(p, new Map([["live", "0100"]]))).not.toThrow();
      expect(read(root, "boards/0800/shot-0800-a.jpg")).toBe("LIVE-bytes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("board repair (scan + apply)", () => {
  it("relinks a drifted shot from its node-graph truth and reports truly missing frames", () => {
    const root = tmp();
    try {
      // Shot is now 1400, but its edit node's take still lives under the old
      // 0800 folder, the flat output pipe was lost, and only the stored
      // graph wire (edit node → output) remembers the association.
      const drifted = makeShot("1400", {
        id: "drifted",
        graphEditNodes: [{
          id: "edit0",
          prompt: "night",
          gens: [{ path: "boards/0800/shot-0800-edit.jpg", prompt: "night", model: "m", at: "2026-01-01T00:00:00.000Z" }],
          genIndex: 0,
        }],
        graph: {
          version: 1,
          nodes: [
            { id: "editgen:edit0", kind: "editgen", pos: { x: 0, y: 0 } },
            { id: "output", kind: "output", pos: { x: 1, y: 0 } },
          ],
          edges: [{ id: "e-edit-out", from: { node: "editgen:edit0", port: "out" }, to: { node: "output", port: "in-out" } }],
        },
      } as Partial<ProductionShot>);
      // A shot whose recorded frame exists nowhere on disk.
      const gone = makeShot("1500", {
        id: "gone",
        artwork: "boards/1500/shot-1500-gone.jpg",
        graphImageGens: [{ path: "boards/1500/shot-1500-gone.jpg", prompt: "p", model: "m", at: "" }],
        graphOutputSource: "imagegen",
      });
      const p = makeProduction(root, [drifted, gone]);
      write(root, "boards/0800/shot-0800-edit.jpg", "EDIT-bytes");
      // An unrelated orphan the repair must surface, not touch.
      write(root, "boards/0900/shot-0900-ghost.jpg", "GHOST-bytes");

      const report = scanBoardRelinks(p);
      expect(report.relinks).toEqual([
        expect.objectContaining({
          shotId: "drifted",
          number: "1400",
          foundFolder: "boards/0800",
          expectedFolder: "boards/1400",
        }),
      ]);
      expect(report.missing).toEqual([expect.objectContaining({ shotId: "gone", number: "1500" })]);
      expect(report.orphans).toContain("boards/0900");
      // Scan is read-only: nothing moved yet.
      expect(exists(root, "boards/0800/shot-0800-edit.jpg")).toBe(true);
      expect(resolveShotDisplay(drifted).media).toBe("none");

      const applied = applyBoardRelinks(p, report);
      expect(applied.failures).toEqual([]);

      // Folder renamed to the shot's current number, inner file renamed,
      // stored paths + output pipe restored: storyboard == canvas.
      expect(exists(root, "boards/0800")).toBe(false);
      expect(read(root, "boards/1400/shot-1400-edit.jpg")).toBe("EDIT-bytes");
      expect(drifted.graphEditNodes![0].gens![0].path).toBe("boards/1400/shot-1400-edit.jpg");
      expect(drifted.graphOutputSource).toBe("editgen");
      expect(resolveShotDisplay(drifted)).toMatchObject({ media: "still", path: "boards/1400/shot-1400-edit.jpg" });
      // Nothing deleted: the unrelated orphan is untouched.
      expect(read(root, "boards/0900/shot-0900-ghost.jpg")).toBe("GHOST-bytes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("generation landing mid-renumber", () => {
  it("rehomes only the job's new file out of the stale-number folder", () => {
    const root = tmp();
    try {
      // The shot was renumbered 0100 → 0200 (folder already relocated);
      // a generation job that started before the reorder then wrote its
      // frame into the stale boards/0100 folder, which now also holds
      // another shot's frame.
      const shot = makeShot("0200", {
        id: "a",
        artwork: "boards/0100/shot-0100-new.jpg",
        graphImageGens: [{ path: "boards/0100/shot-0100-new.jpg", prompt: "p", model: "m", at: "" }],
        graphOutputSource: "imagegen",
      });
      const other = makeShot("0100", { id: "b", artwork: "boards/0100/shot-0100-b.jpg" });
      const p = makeProduction(root, [other, shot]);
      write(root, "boards/0100/shot-0100-new.jpg", "JOB-bytes");
      write(root, "boards/0100/shot-0100-b.jpg", "B-bytes");
      write(root, "boards/0200/shot-0200-old.jpg", "OLD-bytes");

      const moved = rehomeJobFilesAfterRenumber(p, shot, "0100");

      expect(moved).toBe(1);
      expect(read(root, "boards/0200/shot-0200-new.jpg")).toBe("JOB-bytes");
      expect(shot.artwork).toBe("boards/0200/shot-0200-new.jpg");
      expect(shot.graphImageGens![0].path).toBe("boards/0200/shot-0200-new.jpg");
      // The other shot's folder and files are untouched.
      expect(read(root, "boards/0100/shot-0100-b.jpg")).toBe("B-bytes");
      expect(read(root, "boards/0200/shot-0200-old.jpg")).toBe("OLD-bytes");
      // No-op when the number never changed under the job.
      expect(rehomeJobFilesAfterRenumber(p, shot, "0200")).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("edit-node frames are registered durably", () => {
  it("an edit take feeding the output becomes the shot's recorded artwork, survives reopen + renumber", () => {
    const root = tmp();
    try {
      const shot = makeShot("0100", {
        id: "a",
        graphEditNodes: [{ id: "edit0", prompt: "night" }],
        graphOutputSource: "editgen",
        graphOutputEditNodeId: "edit0",
      });
      const p = makeProduction(root, [shot]);
      write(root, "boards/0100/shot-0100-edit.jpg", "EDIT-bytes");

      // Node-surface generation on the node already wired to the output.
      completeEditGeneration(shot, "edit0", "boards/0100/shot-0100-edit.jpg", "night", "m", "node");

      expect(resolveShotDisplay(shot)).toMatchObject({ media: "still", path: "boards/0100/shot-0100-edit.jpg" });
      // Durably the shot's frame, not only the node's history.
      expect(shot.artwork).toBe("boards/0100/shot-0100-edit.jpg");

      // Save/reopen: edit history + artwork survive the JSON round-trip.
      const reopened = JSON.parse(JSON.stringify(shot)) as ProductionShot;
      expect(reopened.graphEditNodes![0].gens![0].path).toBe("boards/0100/shot-0100-edit.jpg");
      expect(reopened.artwork).toBe("boards/0100/shot-0100-edit.jpg");
      p.scenes[0].shots[0] = reopened;

      // Renumber: folder renamed, frame + history intact.
      reopened.number = "0200";
      relocateBoardsForRenumber(p, new Map([["a", "0100"]]));
      expect(read(root, "boards/0200/shot-0200-edit.jpg")).toBe("EDIT-bytes");
      expect(reopened.graphEditNodes![0].gens![0].path).toBe("boards/0200/shot-0200-edit.jpg");
      expect(reopened.artwork).toBe("boards/0200/shot-0200-edit.jpg");
      expect(resolveShotDisplay(reopened)).toMatchObject({ media: "still", path: "boards/0200/shot-0200-edit.jpg" });
      expect(boardFrameHistory(reopened)).not.toContain("boards/0100/shot-0100-edit.jpg");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recording an edit take recreates a vanished node instead of dropping the take", () => {
    const shot = makeShot("0100", { id: "a", graphEditNodes: [] });
    recordGraphEditGen(shot, "edit7", "boards/0100/shot-0100-edit.jpg", "night", "m");
    expect(shot.graphEditNodes?.find((n) => n.id === "edit7")?.gens?.[0].path)
      .toBe("boards/0100/shot-0100-edit.jpg");
  });
});
