/**
 * Shot Sequence main-side seams: preserving a sequence's generated video as a
 * "Shot Sequences" reference when the sequence goes away (explicit delete, or
 * its last member deleted for good). The copy is independent of the sequence
 * folder so nothing generated is lost with the span.
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Production, ShotSequence } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import {
  ensureReferenceCategory,
  relocateClipToSequence,
  removeShotSequence,
  removeShotsFromSequences,
  saveSequenceVideoAsReference,
  SHOT_SEQUENCE_CATEGORY,
} from "../src/main/pipeline.js";
import { recordSequenceVideoGen } from "../src/shared/ipc.js";

function makeProduction(folder: string, seqs: ShotSequence[] = []): Production {
  return {
    meta: { id: "prod-1", name: "Test", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: [
      { number: 1, title: "S1", shots: [
        { id: "a", number: "0100", audio: "", visual: "v" },
        { id: "b", number: "0200", audio: "", visual: "v" },
      ] },
    ],
    characters: [],
    products: [],
    shotSequences: seqs,
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
  } as Production;
}

function withClip(root: string, seq: ShotSequence, rel = "out/sequences/s1/sequence-t.mp4"): ShotSequence {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "clip-bytes");
  recordSequenceVideoGen(seq, "vid0", rel, "motion", "m");
  return seq;
}

describe("saveSequenceVideoAsReference", () => {
  it("copies the clip into referencesDir under the Shot Sequences category", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-seq-del-"));
    try {
      const seq = withClip(root, { id: "s1", name: "Sequence 01", shotIds: ["a", "b"] });
      const p = makeProduction(root, [seq]);

      const ref = saveSequenceVideoAsReference(p, seq);

      expect(ref).not.toBeNull();
      expect(ref!.name).toBe("Sequence 01");
      expect(ref!.media).toBe("video");
      expect(ref!.mediaPath).toBe("references/Sequence 01.mp4");
      expect(ref!.shotIds).toEqual(["a", "b"]);
      const cat = p.referenceCategories!.find((c) => c.id === ref!.categoryId);
      expect(cat?.name).toBe(SHOT_SEQUENCE_CATEGORY);
      expect(fs.readFileSync(path.join(root, ref!.mediaPath!), "utf8")).toBe("clip-bytes");
      // The sequence's own clip is untouched (the copy is independent).
      expect(fs.existsSync(path.join(root, "out/sequences/s1/sequence-t.mp4"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses the category and suffixes colliding names/files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-seq-del-"));
    try {
      const p = makeProduction(root, []);
      const s1 = withClip(root, { id: "s1", name: "Sequence 01", shotIds: ["a"] });
      const s2 = withClip(root, { id: "s2", name: "Sequence 01", shotIds: ["b"] }, "out/sequences/s2/sequence-t.mp4");
      const r1 = saveSequenceVideoAsReference(p, s1)!;
      const r2 = saveSequenceVideoAsReference(p, s2)!;
      expect(r2.name).toBe("Sequence 01 (2)");
      expect(r2.mediaPath).toBe("references/Sequence 01 (2).mp4");
      expect(r1.categoryId).toBe(r2.categoryId);
      expect(p.referenceCategories).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when the sequence has no clip (nothing to preserve)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-seq-del-"));
    try {
      const seq: ShotSequence = { id: "s1", name: "Sequence 01", shotIds: ["a", "b"] };
      const p = makeProduction(root, [seq]);
      expect(saveSequenceVideoAsReference(p, seq)).toBeNull();
      // A recorded take whose file vanished is nothing to preserve either.
      recordSequenceVideoGen(seq, "vid0", "out/sequences/s1/gone.mp4", "", "m");
      expect(saveSequenceVideoAsReference(p, seq)).toBeNull();
      expect(p.references ?? []).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("removeShotSequence", () => {
  it("preserves the clip then drops the sequence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-seq-del-"));
    try {
      const seq = withClip(root, { id: "s1", name: "Sequence 01", shotIds: ["a", "b"] });
      const p = makeProduction(root, [seq]);

      const { saved } = removeShotSequence(p, "s1");

      expect(saved?.name).toBe("Sequence 01");
      expect(p.shotSequences).toEqual([]);
      expect(p.references).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when the sequence is gone", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-seq-del-"));
    try {
      expect(() => removeShotSequence(makeProduction(root, []), "s1")).toThrow(/no longer exists/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("removeShotsFromSequences", () => {
  it("prunes members (and their wired inputs) without dissolving", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-seq-del-"));
    try {
      const p = makeProduction(root, [
        { id: "s1", name: "Sequence 01", shotIds: ["a", "b"], graph: { id: "s1", number: "Sequence 01", audio: "", visual: "", graphVideoNodes: [{ id: "vid0", prompt: "", refIds: ["a", "b"] }], graphSequence: { segments: [{ shotId: "a", durationSec: 3, prompt: "" }, { shotId: "b", durationSec: 3, prompt: "" }] } } },
      ]);
      expect(removeShotsFromSequences(p, ["a"])).toEqual([]);
      expect(p.shotSequences![0]).toMatchObject({ shotIds: ["b"] });
      expect(p.shotSequences![0].graph!.graphVideoNodes![0].refIds).toEqual(["b"]);
      expect(p.shotSequences![0].graph!.graphSequence!.segments).toEqual([{ shotId: "b", durationSec: 3, prompt: "" }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("dissolves a sequence whose span is gone, preserving its clip", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-seq-del-"));
    try {
      const seq = withClip(root, { id: "s1", name: "Sequence 01", shotIds: ["a", "b"] });
      const p = makeProduction(root, [seq]);
      const dissolved = removeShotsFromSequences(p, ["a", "b"]);
      expect(dissolved.map((s) => s.id)).toEqual(["s1"]);
      expect(p.shotSequences).toEqual([]);
      expect(p.references).toHaveLength(1);
      expect(p.references![0].mediaPath).toBe("references/Sequence 01.mp4");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves sequences without removed members untouched", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-seq-del-"));
    try {
      const p = makeProduction(root, [{ id: "s1", name: "Sequence 01", shotIds: ["a"] }]);
      expect(removeShotsFromSequences(p, ["b"])).toEqual([]);
      expect(p.shotSequences![0].shotIds).toEqual(["a"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ensureReferenceCategory", () => {
  it("creates a category once and reuses it by name", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-seq-del-"));
    try {
      const p = makeProduction(root, []);
      const id1 = ensureReferenceCategory(p, "Shot Sequences");
      const id2 = ensureReferenceCategory(p, "shot sequences");
      expect(id1).toBe(id2);
      expect(p.referenceCategories).toEqual([{ id: id1, name: "Shot Sequences" }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("relocateClipToSequence", () => {
  it("moves a provider-written clip out of the board folder into out/sequences/", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-seq-del-"));
    try {
      const p = makeProduction(root, []);
      const src = path.join(root, "boards/0100/video/shot-0100-clip.mp4");
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.writeFileSync(src, "clip-bytes");

      const rel = relocateClipToSequence(p, { id: "s1" }, "boards/0100/video/shot-0100-clip.mp4");

      expect(rel.startsWith("out/sequences/s1/sequence-")).toBe(true);
      expect(rel.endsWith(".mp4")).toBe(true);
      expect(fs.readFileSync(path.join(root, rel), "utf8")).toBe("clip-bytes");
      // Detached from the shot: the board folder no longer holds it, so a
      // renumber (or shot delete) can't take the sequence's takes with it.
      expect(fs.existsSync(src)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
