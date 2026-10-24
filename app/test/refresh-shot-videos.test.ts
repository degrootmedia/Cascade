/**
 * refreshShotVideos tests — the video counterpart of refreshBoardLinks.
 *
 * A generated clip is written to `boards/<number>/video/` by the provider
 * BEFORE the generating job records it on the shot. If the app dies (or a
 * concurrent job's commit drops the record) in between, the file sits on
 * disk with no node-history entry and no pending receipt — invisible in
 * the shot's node tree and on the storyboard. `refreshShotVideos` adopts
 * those orphan clips: plain takes onto the video node, `-edit-` takes
 * onto `ev0`, a `-tween-` stitch onto `graphTweenOutput` when unset. A
 * shot already showing a clip keeps its selection; a shot showing none
 * gets the newest recovered clip applied.
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Production, ProductionScene, ProductionShot } from "../src/shared/ipc.js";

// pipeline.ts imports scripting.ts; the tests never call its helpers and its
// dynamic pdf-parse import doesn't resolve under Vitest — mock it away.
vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { refreshShotVideos } from "../src/main/pipeline.js";

function makeShot(number: string, overrides: Partial<ProductionShot> = {}): ProductionShot {
  return {
    id: `shot-${number}`,
    number,
    audio: "",
    visual: `Visual ${number}`,
    ...overrides,
  };
}

function makeProduction(folder: string, shots: ProductionShot[]): Production {
  return {
    meta: { id: "prod-1", name: "Test", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: shots.length },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: shots.map((shot): ProductionScene => ({ number: 1, title: "S1", shots: [shot] })),
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
  };
}

/** Write one clip file into a shot's video/ folder with a pinned mtime. */
function clipFile(root: string, number: string, name: string, mtimeSec: number, body = "fake-mp4"): string {
  const dir = path.join(root, "boards", number, "video");
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, body);
  fs.utimesSync(abs, Date.now() / 1000, mtimeSec);
  return `boards/${number}/video/${name}`;
}

describe("refreshShotVideos", () => {
  it("adopts an orphan clip onto the video node and applies it when the shot shows no clip", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-vidrefresh-"));
    const rel = clipFile(root, "0100", "shot-0100-abc123.mp4", 1_000_000_000);
    const shot = makeShot("0100");
    const p = makeProduction(root, [shot]);
    expect(refreshShotVideos(p)).toBe(1);
    const node = shot.graphVideoNodes?.find((n) => n.id === "vid0");
    expect(node?.gens?.map((g) => g.path)).toEqual([rel]);
    expect(node?.gens?.[0].model).toBe("refresh");
    expect(node?.genIndex ?? 0).toBe(0);
    // Applied: the recovered clip becomes the shot's output feed.
    expect(shot.graphOutputSource).toBe("videogen");
    // Registered with the media registry like every generated clip.
    expect(p.media?.some((m) => m.path === rel && m.state === "present")).toBe(true);
  });

  it("is idempotent — a second run adopts nothing and adds no history entry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-vidrefresh-"));
    clipFile(root, "0100", "shot-0100-abc123.mp4", 1_000_000_000);
    const shot = makeShot("0100");
    const p = makeProduction(root, [shot]);
    expect(refreshShotVideos(p)).toBe(1);
    expect(refreshShotVideos(p)).toBe(0);
    expect(shot.graphVideoNodes?.[0].gens).toHaveLength(1);
  });

  it("never re-adopts a clip already recorded in node history", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-vidrefresh-"));
    const rel = clipFile(root, "0100", "shot-0100-abc123.mp4", 1_000_000_000);
    const shot = makeShot("0100", {
      graphOutputSource: "videogen",
      graphVideoNodes: [{ id: "vid0", prompt: "", gens: [{ path: rel, prompt: "p", model: "m", at: "" }], genIndex: 0 }],
    });
    const p = makeProduction(root, [shot]);
    expect(refreshShotVideos(p)).toBe(0);
    expect(shot.graphVideoNodes?.[0].gens).toHaveLength(1);
  });

  it("adopts multiple orphans newest-first, leaving the newest selected", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-vidrefresh-"));
    const older = clipFile(root, "0100", "shot-0100-older.mp4", 1_000_000_000);
    const newer = clipFile(root, "0100", "shot-0100-newer.mp4", 1_000_000_100);
    const shot = makeShot("0100");
    const p = makeProduction(root, [shot]);
    expect(refreshShotVideos(p)).toBe(2);
    const node = shot.graphVideoNodes?.find((n) => n.id === "vid0");
    expect(node?.gens?.map((g) => g.path)).toEqual([newer, older]);
    expect(node?.gens?.[node.genIndex ?? 0].path).toBe(newer);
  });

  it("routes -edit- clips to the edit-video node (ev0)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-vidrefresh-"));
    const rel = clipFile(root, "0100", "shot-0100-edit-xyz789.mp4", 1_000_000_000);
    const shot = makeShot("0100");
    const p = makeProduction(root, [shot]);
    expect(refreshShotVideos(p)).toBe(1);
    expect(shot.graphVideoNodes?.find((n) => n.id === "ev0")?.gens?.[0].path).toBe(rel);
  });

  it("adopts a -tween- stitch as graphTweenOutput only when none is set", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-vidrefresh-"));
    const rel = clipFile(root, "0100", "shot-0100-tween-qqq111.mp4", 1_000_000_000);
    const shot = makeShot("0100");
    const p = makeProduction(root, [shot]);
    expect(refreshShotVideos(p)).toBe(1);
    expect(shot.graphTweenOutput).toBe(rel);

    const shot2 = makeShot("0200", { graphTweenOutput: "boards/0200/video/shot-0200-tween-kept.mp4" });
    clipFile(root, "0200", "shot-0200-tween-other.mp4", 1_000_000_200);
    const p2 = makeProduction(root, [shot2]);
    expect(refreshShotVideos(p2)).toBe(0);
    expect(shot2.graphTweenOutput).toBe("boards/0200/video/shot-0200-tween-kept.mp4");
  });

  it("keeps the shown selection when the shot already displays a clip", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-vidrefresh-"));
    const shown = clipFile(root, "0100", "shot-0100-shown.mp4", 1_000_000_100);
    const orphan = clipFile(root, "0100", "shot-0100-orphan.mp4", 1_000_000_200);
    const shot = makeShot("0100", {
      graphOutputSource: "videogen",
      graphVideoNodes: [{ id: "vid0", prompt: "", gens: [{ path: shown, prompt: "p", model: "m", at: "" }], genIndex: 0 }],
    });
    const p = makeProduction(root, [shot]);
    expect(refreshShotVideos(p)).toBe(1);
    const node = shot.graphVideoNodes![0];
    // Recovered into history, but the take on screen does not change.
    expect(node.gens?.map((g) => g.path)).toContain(orphan);
    expect(node.gens?.[node.genIndex ?? 0].path).toBe(shown);
    expect(shot.graphOutputSource).toBe("videogen");
  });

  it("applies the orphan when the piped clip's file is missing on disk", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-vidrefresh-"));
    const orphan = clipFile(root, "0100", "shot-0100-orphan.mp4", 1_000_000_000);
    const shot = makeShot("0100", {
      graphOutputSource: "videogen",
      graphVideoNodes: [{ id: "vid0", prompt: "", gens: [{ path: "boards/0100/video/shot-0100-gone.mp4", prompt: "p", model: "m", at: "" }], genIndex: 0 }],
    });
    const p = makeProduction(root, [shot]);
    expect(refreshShotVideos(p)).toBe(1);
    const node = shot.graphVideoNodes![0];
    expect(node.gens?.[node.genIndex ?? 0].path).toBe(orphan);
  });

  it("ignores other shots' clips, stills, and zero-byte partial writes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-vidrefresh-"));
    clipFile(root, "0100", "shot-0200-wrongshot.mp4", 1_000_000_000);
    clipFile(root, "0100", "shot-0100-still.jpg", 1_000_000_000);
    clipFile(root, "0100", "shot-0100-partial.mp4", 1_000_000_000, "");
    const shot = makeShot("0100");
    const p = makeProduction(root, [shot]);
    expect(refreshShotVideos(p)).toBe(0);
    expect(shot.graphVideoNodes ?? []).toHaveLength(0);
  });

  it("onlyShotId restricts the scan to one shot", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-vidrefresh-"));
    clipFile(root, "0100", "shot-0100-aaa111.mp4", 1_000_000_000);
    clipFile(root, "0200", "shot-0200-bbb222.mp4", 1_000_000_000);
    const a = makeShot("0100");
    const b = makeShot("0200");
    const p = makeProduction(root, [a, b]);
    // makeProduction wraps each shot in its own scene — ids are shot-<number>.
    expect(refreshShotVideos(p, b.id)).toBe(1);
    expect(a.graphVideoNodes ?? []).toHaveLength(0);
    expect(b.graphVideoNodes?.[0].gens).toHaveLength(1);
  });

  it("is a no-op when no video folder exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-vidrefresh-"));
    const p = makeProduction(root, [makeShot("0100")]);
    expect(refreshShotVideos(p)).toBe(0);
  });
});

describe("fetch-pending-videos wiring (source guards)", () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

  it("main registers a bulk fetch handler that reclaims pendings and adopts orphans", () => {
    const main = read("../src/main/index.ts");
    expect(main).toContain('handle("production:fetchPendingVideos"');
    expect(main).toContain("refreshShotVideos(");
    // The bulk fetch dispatches the existing per-shot recheck (one reclaim
    // path — billing/apply logic is never duplicated).
    expect(main).toContain('ipcListeners.get("production:recheckVideo")');
  });

  it("the channel is exposed to the renderer", () => {
    expect(read("../src/shared/ipc-channels/production.ts")).toContain('"production:fetchPendingVideos"');
    expect(read("../src/shared/ipc.ts")).toContain("fetchPendingVideos(");
  });

  it("the storyboard shows the fetch affordance for any pending video target", () => {
    const ws = read("../src/renderer/src/components/ProductionWorkspace.tsx");
    expect(ws).toContain("videoPending={!!shot.pendingVideoGen}");
    expect(ws).not.toContain('pendingVideoGen?.target?.kind === "videoPath"');
    expect(ws).toContain("fetchPendingVideos");
  });
});
