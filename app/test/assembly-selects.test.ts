import { describe, it, expect } from "vitest";
import { assemblyPlan, sendAssetToAssembly } from "../src/main/assembly";
import { assemblySendTarget } from "../src/renderer/src/components/generation-menu";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("assembly selects + send", () => {
  it("includes tagged selects that are not the active clip", () => {
    const shot: any = { id: "s1", number: "0100", durationSec: 3, graphVideoNodes: [{ id: "vid0", prompt: "", gens: [
      { path: "videos/a.mp4", select: true }, { path: "videos/b.mp4" }] }] };
    const p: any = { scenes: [{ shots: [shot] }], references: [], assets: { outDir: "o", assemblyDir: "a" } };
    const plan = assemblyPlan(p);
    expect(plan.media.map((m) => m.srcRel)).toContain("videos/a.mp4");
    expect(plan.media.map((m) => m.srcRel)).not.toContain("videos/b.mp4");
  });
  it("derives send target from media url", () => {
    expect(assemblySendTarget({ rel: "x/y.png", src: "cascade-media://prod1/x%2Fy.png" })).toEqual({ productionId: "prod1", relPath: "x/y.png" });
    expect(assemblySendTarget({ rel: "x" })).toBeNull();
  });
  it("copies an asset into the assembly folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asm-"));
    fs.writeFileSync(path.join(root, "f.png"), "x");
    const p: any = { assets: { outDir: "out", assemblyDir: "asm" }, meta: { folder: root }, assembly: undefined };
    const dest = sendAssetToAssembly(p, "f.png");
    expect(dest).toContain("media/sent/f.png");
    expect(fs.existsSync(path.join(root, dest))).toBe(true);
  });
});
