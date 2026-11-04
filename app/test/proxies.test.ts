/**
 * Proxy service tests — Animatic Editor Expansion Item A6.
 *
 * Real temp production folder, fake ffmpeg runner (writes the output
 * file). Covers: deterministic paths, 720p args, freshness (mtime)
 * skip/regenerate, per-file failure collection, ready listing, and the
 * safety invariant — with proxies present on disk, the assembly plan
 * still references ORIGINALS only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Production } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { buildProxyArgs, generateProxies, listReadyProxies, proxyRelFor, timelineVideoSources } from "../src/main/proxies.js";
import { assemblyPlanFromTimeline } from "../src/main/assembly.js";

let dir: string;
let prod: Production;

function write(rel: string, content = "x", mtimeMs?: number): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  if (mtimeMs != null) fs.utimesSync(abs, new Date(mtimeMs), new Date(mtimeMs));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-proxies-"));
  write("clips/a.mp4", "AAAA", 1_000_000);
  write("clips/b.mp4", "BBBB", 1_000_000);
  prod = {
    meta: { id: "px1", name: "Proxies", folder: dir, createdAt: "", updatedAt: "", stepDone: 4, shotCount: 0 },
    currentStep: 4, visualStyle: "", styles: [], scenes: [], characters: [], products: [], status: {},
    timeline: {
      version: 1,
      tracks: [{ id: "v1", kind: "video", name: "V1" }],
      clips: [
        { id: "c1", trackId: "v1", sourceKind: "video", srcRel: "clips/a.mp4", sourceInSec: 0, sourceOutSec: 4, timelineStartSec: 0 },
        { id: "c2", trackId: "v1", sourceKind: "video", srcRel: "clips/b.mp4", sourceInSec: 0, sourceOutSec: 4, timelineStartSec: 4 },
        { id: "c3", trackId: "v1", sourceKind: "still", srcRel: "stills/s.jpg", holdSec: 2, timelineStartSec: 8 },
      ],
    },
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
  } as unknown as Production;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const fakeRun = (failOn?: string) => async (args: string[]): Promise<void> => {
  const out = args[args.length - 1];
  if (failOn && args.some((a) => a.includes(failOn))) throw new Error("encode failed");
  fs.writeFileSync(out, "proxy-bytes");
};

describe("proxy paths and args", () => {
  it("proxyRelFor is deterministic, hashed, and under out/proxies", () => {
    expect(proxyRelFor("clips/a.mp4")).toMatch(/^out\/proxies\/a-[0-9a-f]{8}\.mp4$/);
    expect(proxyRelFor("clips/a.mp4")).toBe(proxyRelFor("clips/a.mp4"));
    expect(proxyRelFor("other/a.mp4")).not.toBe(proxyRelFor("clips/a.mp4"));
  });

  it("args downscale to at most 720p with a short GOP and faststart", () => {
    const args = buildProxyArgs("/in.mp4", "/out.mp4");
    const joined = args.join(" ");
    expect(joined).toContain("scale=-2:'min(720,ih)'");
    expect(joined).toContain("-g 24");
    expect(joined).toContain("+faststart");
  });

  it("timelineVideoSources collects unique video sources only", () => {
    expect(timelineVideoSources(prod.timeline)).toEqual(["clips/a.mp4", "clips/b.mp4"]);
    expect(timelineVideoSources(undefined)).toEqual([]);
  });
});

describe("generateProxies", () => {
  it("encodes missing proxies, then reports them fresh and ready", async () => {
    const rels = timelineVideoSources(prod.timeline);
    const r1 = await generateProxies(prod, rels, fakeRun(), () => {});
    expect(r1).toMatchObject({ generated: 2, fresh: 0, failed: [] });
    expect(Object.keys(r1.proxies).sort()).toEqual(rels);
    expect(fs.existsSync(path.join(dir, proxyRelFor("clips/a.mp4")))).toBe(true);
    // Second pass: everything fresh, nothing re-encoded.
    const r2 = await generateProxies(prod, rels, fakeRun(), () => {});
    expect(r2).toMatchObject({ generated: 0, fresh: 2, failed: [] });
    expect(listReadyProxies(prod)).toEqual(r1.proxies);
  });

  it("regenerates when the source is newer than the proxy (stale)", async () => {
    const rels = timelineVideoSources(prod.timeline);
    await generateProxies(prod, rels, fakeRun(), () => {});
    write("clips/a.mp4", "AAAA-new", Date.now() + 60_000);
    expect(listReadyProxies(prod)).not.toHaveProperty("clips/a.mp4");
    const r = await generateProxies(prod, rels, fakeRun(), () => {});
    expect(r).toMatchObject({ generated: 1, fresh: 1 });
  });

  it("collects per-file failures and cleans partials; deleting proxies is safe", async () => {
    const rels = timelineVideoSources(prod.timeline);
    const r = await generateProxies(prod, rels, fakeRun("b.mp4"), () => {});
    expect(r.generated).toBe(1);
    expect(r.failed).toEqual(["clips/b.mp4"]);
    expect(r.proxies).not.toHaveProperty("clips/b.mp4");
    // Wipe the whole proxy dir: listing is empty, regeneration restores.
    fs.rmSync(path.join(dir, "out", "proxies"), { recursive: true, force: true });
    expect(listReadyProxies(prod)).toEqual({});
    const r2 = await generateProxies(prod, rels, fakeRun(), () => {});
    expect(r2.generated).toBe(2);
  });

  it("assembly plans reference originals even with proxies on disk", async () => {
    await generateProxies(prod, timelineVideoSources(prod.timeline), fakeRun(), () => {});
    const plan = assemblyPlanFromTimeline(prod);
    const srcs = plan.media.map((m) => m.srcRel);
    expect(srcs).toContain("clips/a.mp4");
    expect(srcs.every((s) => !s.startsWith("out/proxies/"))).toBe(true);
    for (const ev of plan.events) {
      if (ev.srcRel) expect(ev.srcRel.startsWith("out/proxies/")).toBe(false);
    }
  });
});
