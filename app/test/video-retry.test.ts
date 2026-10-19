/**
 * 720p manual-retry flow — oversize inventory/eligibility, ref-swap
 * application, the file-to-file 720p transcode, and duplicate-reference
 * creation. The ffmpeg seam is faked throughout (no binary needed): the
 * fake `run` writes marker bytes to the output path and `probe` reports a
 * scripted height.
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomRef, Production, ProductionShot } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import { create720pReference } from "../src/main/pipeline.js";
import { transcodeVideoFileTo720p, type VideoRef720Deps } from "../src/main/video-ref.js";
import {
  applyRefSwapsToIds,
  applyRefSwapsToPrompt,
  probeVideoInputs,
  resolveRefSwaps,
  retry720pOffer,
  unionVideoInputs,
  videoRefForEditSource,
  videoRefsForIds,
  videoRefsForPromptTags,
  type ProbedVideoInput,
} from "../src/main/video-retry.js";
import { normalizeRefs } from "../src/main/providers/submit-wrapper.js";

function makeProduction(folder: string, references: CustomRef[]): Production {
  const shot: ProductionShot = { id: "shot-0100", number: "0100", audio: "", visual: "" };
  return {
    meta: { id: "prod-1", name: "Test", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 1 },
    currentStep: 3,
    visualStyle: "",
    styles: [],
    scenes: [{ number: 1, title: "S1", shots: [shot] }],
    characters: [],
    products: [],
    references,
    referenceCategories: [
      { id: "cat-style", name: "Style", kind: "style" },
      { id: "cat-props", name: "Props", kind: "content" },
    ],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
  } as Production;
}

const CLIP: CustomRef = { id: "r-clip", name: "Clip", media: "video", mediaPath: "references/clip.mp4", shotIds: [] };
const STILL: CustomRef = { id: "r-still", name: "Still", imagePath: "references/still.jpg", shotIds: [] };
const STYLE_ONLY: CustomRef = { id: "r-style", name: "Look", media: "video", mediaPath: "references/look.mp4", shotIds: [], styleOnly: true };
const STYLE_CAT: CustomRef = { id: "r-stylecat", name: "Mood", media: "video", mediaPath: "references/mood.mp4", shotIds: [], categoryId: "cat-style" };

function fakeTranscodeDeps(height: number, captured: string[][] = []): VideoRef720Deps {
  return {
    resolveBin: async () => "ffmpeg",
    run: async (_bin, argv) => {
      captured.push(argv);
      fs.writeFileSync(argv[argv.length - 1], Buffer.from("720p-bytes"));
    },
    probe: async () => ({ width: Math.round((height * 16) / 9), height }),
  };
}

describe("transcodeVideoFileTo720p", () => {
  it("scales an oversize source to height 720 with the shared recipe", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-720-"));
    try {
      const src = path.join(root, "clip.mp4");
      const dest = path.join(root, "clip_720p.mp4");
      fs.writeFileSync(src, "1080p-bytes");
      const captured: string[][] = [];
      await transcodeVideoFileTo720p(src, dest, fakeTranscodeDeps(1080, captured));
      expect(fs.readFileSync(dest, "utf8")).toBe("720p-bytes");
      const argv = captured[0];
      expect(argv[argv.indexOf("-vf") + 1]).toBe("scale=-2:720");
      expect(argv).toContain("libx264");
      expect(argv[argv.length - 1]).toBe(dest);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-encodes a within-cap source without scaling (never a byte copy)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-720-"));
    try {
      const src = path.join(root, "clip.webm");
      const dest = path.join(root, "clip_720p.mp4");
      fs.writeFileSync(src, "720p-webm-source");
      const captured: string[][] = [];
      await transcodeVideoFileTo720p(src, dest, fakeTranscodeDeps(720, captured));
      expect(captured).toHaveLength(1);
      expect(captured[0]).not.toContain("-vf");
      // The fake run wrote fresh MP4 bytes — proof the path isn't a copy of
      // the (differently-containered) source bytes.
      expect(fs.readFileSync(dest, "utf8")).toBe("720p-bytes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects with nothing written when no encoder or no readable size", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-720-"));
    try {
      const src = path.join(root, "clip.mp4");
      const dest = path.join(root, "clip_720p.mp4");
      fs.writeFileSync(src, "bytes");
      await expect(
        transcodeVideoFileTo720p(src, dest, { resolveBin: async () => null, run: async () => {}, probe: async () => null })
      ).rejects.toThrow(/no video encoder/i);
      await expect(
        transcodeVideoFileTo720p(src, dest, { resolveBin: async () => "ffmpeg", run: async () => {}, probe: async () => null })
      ).rejects.toThrow(/couldn't read/i);
      expect(fs.existsSync(dest)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("create720pReference", () => {
  function withClip(heightDeps: VideoRef720Deps, refs: CustomRef[] = [CLIP]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-720ref-"));
    fs.mkdirSync(path.join(root, "references"), { recursive: true });
    fs.writeFileSync(path.join(root, "references", "clip.mp4"), "1080p-bytes");
    const p = makeProduction(root, refs);
    return { root, p, deps: heightDeps };
  }

  it("transcodes into referencesDir and appends a <name>_720p video reference", async () => {
    const { root, p, deps } = withClip(fakeTranscodeDeps(1080));
    try {
      const ref = await create720pReference(p, "r-clip", deps);
      expect(ref.name).toBe("Clip_720p");
      expect(ref.media).toBe("video");
      expect(ref.mediaPath).toBe("references/clip_720p.mp4");
      expect(ref.imagePath).toBeUndefined();
      expect(ref.styleOnly).toBeUndefined();
      expect(p.references).toHaveLength(2);
      expect(fs.readFileSync(path.join(root, ref.mediaPath!), "utf8")).toBe("720p-bytes");
      // The original is untouched.
      expect(fs.readFileSync(path.join(root, "references", "clip.mp4"), "utf8")).toBe("1080p-bytes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent — a second call reuses the duplicate without transcoding", async () => {
    const captured: string[][] = [];
    const { root, p, deps } = withClip(fakeTranscodeDeps(1080, captured));
    try {
      const first = await create720pReference(p, "r-clip", deps);
      const second = await create720pReference(p, "r-clip", deps);
      expect(second.id).toBe(first.id);
      expect(p.references).toHaveLength(2);
      expect(captured).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("copies a content category but never a style category or styleOnly", async () => {
    const inProps: CustomRef = { ...CLIP, categoryId: "cat-props" };
    const a = withClip(fakeTranscodeDeps(1080), [inProps]);
    try {
      expect((await create720pReference(a.p, "r-clip", a.deps)).categoryId).toBe("cat-props");
    } finally {
      fs.rmSync(a.root, { recursive: true, force: true });
    }
    const inStyle: CustomRef = { ...CLIP, categoryId: "cat-style", styleOnly: true };
    const b = withClip(fakeTranscodeDeps(1080), [inStyle]);
    try {
      const dup = await create720pReference(b.p, "r-clip", b.deps);
      expect(dup.categoryId).toBeUndefined();
      expect(dup.styleOnly).toBeUndefined();
    } finally {
      fs.rmSync(b.root, { recursive: true, force: true });
    }
  });

  it("throws for unknown, non-video, and missing-file references, writing nothing", async () => {
    const { root, p, deps } = withClip(fakeTranscodeDeps(1080), [CLIP, STILL]);
    try {
      await expect(create720pReference(p, "nope", deps)).rejects.toThrow(/no longer exists/);
      await expect(create720pReference(p, "r-still", deps)).rejects.toThrow(/isn't a video reference/);
      fs.unlinkSync(path.join(root, "references", "clip.mp4"));
      await expect(create720pReference(p, "r-clip", deps)).rejects.toThrow(/isn't on disk/);
      expect(p.references).toHaveLength(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("video input inventory", () => {
  const p = () => makeProduction("/tmp/inv", [CLIP, STILL, STYLE_ONLY, STYLE_CAT]);

  it("collects explicit video ref ids, skipping images, unknowns, and style refs", () => {
    expect(videoRefsForIds(p(), ["r-clip", "r-still", "r-style", "r-stylecat", "missing", 42]).map((r) => r.refId)).toEqual(["r-clip"]);
    expect(videoRefsForIds(p(), undefined)).toEqual([]);
    expect(videoRefsForIds(p(), "r-clip")).toEqual([]);
  });

  it("collects prompt-tagged video refs case-insensitively", () => {
    expect(videoRefsForPromptTags(p(), "animate @[clip] and @[Still] and @[Look]").map((r) => r.refId)).toEqual(["r-clip"]);
    expect(videoRefsForPromptTags(p(), "no tags here")).toEqual([]);
  });

  it("resolves the edit source by ref id or by file path, but not for bare takes", () => {
    expect(videoRefForEditSource(p(), { sourceRefId: "r-clip" }).map((r) => r.refId)).toEqual(["r-clip"]);
    expect(videoRefForEditSource(p(), { sourcePath: "references/clip.mp4" }).map((r) => r.refId)).toEqual(["r-clip"]);
    expect(videoRefForEditSource(p(), { sourcePath: "boards/0100/video/take.mp4" })).toEqual([]);
    expect(videoRefForEditSource(p(), { sourceRefId: "r-style" })).toEqual([]);
  });

  it("unions channels without duplicates", () => {
    const one = videoRefsForIds(p(), ["r-clip"]);
    const two = videoRefsForPromptTags(p(), "@[Clip]");
    expect(unionVideoInputs(one, two)).toHaveLength(1);
  });

  it("probes heights per input and keeps unreadable ones null", async () => {
    const probed = await probeVideoInputs(p(), videoRefsForIds(p(), ["r-clip"]), async () => ({ width: 1920, height: 1080 }));
    expect(probed).toEqual([{ refId: "r-clip", name: "Clip", relPath: "references/clip.mp4", height: 1080 }]);
    const unread = await probeVideoInputs(p(), videoRefsForIds(p(), ["r-clip"]), async () => null);
    expect(unread[0].height).toBeNull();
    const boom = await probeVideoInputs(p(), videoRefsForIds(p(), ["r-clip"]), async () => { throw new Error("probe died"); });
    expect(boom[0].height).toBeNull();
  });
});

describe("retry720pOffer", () => {
  const over: ProbedVideoInput = { refId: "r-clip", name: "Clip", relPath: "references/clip.mp4", height: 1080 };
  const under: ProbedVideoInput = { ...over, height: 720 };
  const unread: ProbedVideoInput = { ...over, height: null };
  const base = { hasPending: false, providerId: "openart", shotId: "s1", surface: "classic" as const, mayHaveBilled: true };

  it("offers the oversize refs with billing/shape intact", () => {
    expect(retry720pOffer({ ...base, inputs: [over, under] })).toEqual({
      kind: "retry720p",
      shotId: "s1",
      surface: "classic",
      refs: [{ refId: "r-clip", name: "Clip", height: 1080 }],
      mayHaveBilled: true,
    });
  });

  it("suppresses the offer for pending jobs, openart-cli, and nothing-oversize", () => {
    expect(retry720pOffer({ ...base, inputs: [over], hasPending: true })).toBeNull();
    expect(retry720pOffer({ ...base, inputs: [over], providerId: "openart-cli" })).toBeNull();
    expect(retry720pOffer({ ...base, inputs: [under] })).toBeNull();
    expect(retry720pOffer({ ...base, inputs: [unread] })).toBeNull();
    expect(retry720pOffer({ ...base, inputs: [] })).toBeNull();
  });
});

describe("ref swaps", () => {
  const dup: CustomRef = { id: "r-clip-720", name: "Clip_720p", media: "video", mediaPath: "references/clip_720p.mp4", shotIds: [] };
  const p = () => makeProduction("/tmp/swaps", [CLIP, dup]);

  it("validates swaps against the library and drops unknown/self entries", () => {
    const resolved = resolveRefSwaps(p(), [
      { fromRefId: "r-clip", toRefId: "r-clip-720" },
      { fromRefId: "r-clip", toRefId: "r-clip" },
      { fromRefId: "ghost", toRefId: "r-clip-720" },
      { fromRefId: 42, toRefId: "r-clip-720" },
      null,
    ]);
    expect(resolved).toEqual([{ fromId: "r-clip", fromName: "Clip", fromPath: "references/clip.mp4", toId: "r-clip-720", toName: "Clip_720p", toPath: "references/clip_720p.mp4" }]);
    expect(resolveRefSwaps(p(), undefined)).toEqual([]);
  });

  it("rewrites prompt tags and ref ids for one submission", () => {
    const resolved = resolveRefSwaps(p(), [{ fromRefId: "r-clip", toRefId: "r-clip-720" }]);
    expect(applyRefSwapsToPrompt("animate @[Clip] with @[clip] energy", resolved)).toBe("animate @[Clip_720p] with @[Clip_720p] energy");
    expect(applyRefSwapsToIds(["r-clip", "other", 7], resolved)).toEqual(["r-clip-720", "other"]);
    expect(applyRefSwapsToIds(undefined, resolved)).toEqual([]);
  });
});

describe("normalizeRefs (submit-wrapper)", () => {
  it("passes refs through at native resolution, tagging video vs image", async () => {
    const video = "data:video/mp4;base64,AAAA";
    const image = "data:image/png;base64,BBBB";
    const out = await normalizeRefs([
      { name: "Clip", dataUrl: video },
      { name: "Still", dataUrl: image },
    ]);
    expect(out.map((r) => [r.dataUrl, r.isVideo, r.downscaled])).toEqual([
      [video, true, false],
      [image, false, false],
    ]);
  });
});
