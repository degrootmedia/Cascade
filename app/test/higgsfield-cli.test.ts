/**
 * HiggsfieldCliProvider tests — the module's interface IS the test surface.
 *
 * The subprocess is injected, so a fake `run` substitutes for the live
 * `higgsfield` binary: canned `--json` replies drive the listing, option,
 * end-frame, submit, wait, and recheck logic. Fixtures follow the shapes
 * documented by the official CLI (MODELS.md param tables + the
 * higgsfield-generate skill: `model get --json` →
 * `{aspect_ratios, durations, parameters, medias}`; `generate create
 * --json` without --wait → job ids; `generate wait/get --json` → final job
 * objects). fetch is stubbed for result downloads; scripting.js is mocked
 * so pipeline.ts loads in a plain node process.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  HiggsfieldCliProvider,
  higgsfieldCliRawId,
  HIGGSFIELD_CLI_ID_PREFIX,
  resolveHiggsfieldCliBinary,
  type CliRun,
  type CliRunResult,
} from "../src/main/providers/higgsfield-cli.js";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-higgs-cli-${process.pid}-${Date.now()}` };
});

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

// ---- fake runner ------------------------------------------------------------

type Handler = (args: string[]) => CliRunResult | Promise<CliRunResult>;

/** A CLI runner whose commands answer from a canned handler. Records every
 *  invocation's args for assertions. */
function fakeRun(handler: Handler): { run: CliRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: CliRun = async (args) => {
    calls.push(args);
    return handler(args);
  };
  return { run, calls };
}

const ok = (stdout: string): CliRunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): CliRunResult => ({ code: 1, stdout: "", stderr });

const IMAGE_LIST = JSON.stringify([
  { job_type: "cinematic_studio_2_5", name: "Cinematic Studio 2.5", description: "Stills." },
  { job_type: "nano_banana_2", name: "Nano Banana Pro", description: "Reference work." },
]);
const VIDEO_LIST = JSON.stringify([
  { job_type: "seedance_2_0", name: "Seedance 2.0", description: "Video." },
  { job_type: "seedance_2_5", name: "Seedance 2.5", description: "Video." },
  { job_type: "kling3_0", name: "Kling v3.0", description: "Video." },
  { job_type: "veo3", name: "Google Veo 3", description: "Video." },
  { job_type: "veo3_1_lite", name: "Google Veo 3.1 Lite", description: "Video." },
]);

/** Live `model get seedance_2_0` shape (2026-09-11): params with `enum`
 *  for closed sets, open integer duration (no options), and NO medias
 *  block — start/end frames and reference arrays are params. */
const seedanceGet = () =>
  JSON.stringify({
    display_name: "Seedance 2.0",
    job_type: "seedance_2_0",
    type: "video",
    params: [
      { name: "aspect_ratio", type: "string", default: "16:9", required: false, enum: ["auto", "16:9", "9:16"] },
      { name: "duration", type: "integer", default: 5, required: false },
      { name: "resolution", type: "string", default: "720p", required: false, enum: ["480p", "720p", "1080p", "4k"] },
      { name: "start_image", type: "object|null", default: null, required: false },
      { name: "end_image", type: "object|null", default: null, required: false },
      { name: "image_references", type: "array", default: null, required: false },
      { name: "video_references", type: "array", default: null, required: false },
      { name: "prompt", type: "string", default: null, required: true },
    ],
  });

/** A model with closed string duration options (live veo3_1_lite style). */
const veoLiteGet = () =>
  JSON.stringify({
    display_name: "Veo 3.1 Lite",
    job_type: "veo3_1_lite",
    type: "video",
    params: [
      { name: "duration", type: "integer", default: 8, required: false, enum: ["4", "6", "8"] },
      { name: "resolution", type: "string", default: "720p", required: false, enum: ["720p"] },
      { name: "start_image", type: "object|null", default: null, required: false },
      { name: "end_image", type: "object|null", default: null, required: false },
    ],
  });

/** Live shape: end frames arrive as params, no medias block. */
const klingGet = () =>
  JSON.stringify({
    display_name: "Kling v3.0",
    job_type: "kling3_0",
    type: "video",
    params: [
      { name: "duration", type: "integer", default: 5, required: false },
      { name: "start_image", type: "object|null", default: null, required: false },
      { name: "end_image", type: "object|null", default: null, required: false },
    ],
  });

/** Live shape: legacy single-`image` role as a param, no end frame. */
const veoGet = () =>
  JSON.stringify({
    display_name: "Google Veo 3",
    job_type: "veo3",
    type: "video",
    params: [
      { name: "prompt", type: "string", default: null, required: true },
      { name: "image", type: "object|null", default: null, required: false },
    ],
  });

const studioImageGet = () =>
  JSON.stringify({
    aspect_ratios: ["1:1", "16:9", "9:16"],
    parameters: [
      { name: "resolution", options: ["1k", "2k", "4k"], default: "1k" },
      { name: "quality", options: ["basic", "high"], default: "basic" },
      { name: "aspect_ratio", options: ["1:1", "16:9", "9:16"], default: "1:1" },
    ],
    medias: [{ roles: ["image"] }],
  });

/** Default fake: lists + per-model details + account. Matches on the
 *  command verbs so trailing `--json --no-color` never breaks routing. */
function baseHandler(extra: Record<string, Handler> = {}): Handler {
  return (args) => {
    const verb = args.slice(0, 2).join(" ");
    const key = `${verb} ${args[2] ?? ""}`.trim();
    if (extra[key]) return extra[key](args);
    if (verb === "model list") {
      if (args.includes("--image")) return ok(IMAGE_LIST);
      if (args.includes("--video")) return ok(VIDEO_LIST);
    }
    if (verb === "model get") {
      if (args[2] === "seedance_2_0") return ok(seedanceGet());
      if (args[2] === "seedance_2_5") return ok(seedance25Get());
      if (args[2] === "kling3_0") return ok(klingGet());
      if (args[2] === "veo3") return ok(veoGet());
      if (args[2] === "veo3_1_lite") return ok(veoLiteGet());
      if (args[2] === "cinematic_studio_2_5") return ok(studioImageGet());
      return fail(`Unknown model: ${args[2]}`);
    }
    if (verb === "account status") return ok(JSON.stringify({ credits: 1388.74 }));
    throw new Error(`No fake handler for higgs args "${args.join(" ")}"`);
  };
}

const seedance25Get = () =>
  JSON.stringify({
    aspect_ratios: ["auto", "16:9", "9:16"],
    parameters: [
      { name: "duration", options: [4, 8, 12], default: 4 },
      { name: "resolution", options: ["720p", "1080p"], default: "720p" },
      { name: "mode", options: ["t2v", "omni_reference"], default: "t2v" },
      { name: "prompt", options: [] },
    ],
    medias: [{ roles: ["start_image", "end_image"] }, { roles: ["image_references"] }, { roles: ["video_references"] }],
  });

function provider(run: CliRun, binary: string | null = "higgsfield"): HiggsfieldCliProvider {
  return new HiggsfieldCliProvider({ binary: () => binary, run });
}

function makeProduction(overrides: Partial<Production> = {}): Production {
  return {
    meta: { id: "prod-1", name: "Test Production", folder: "C:/workspace/test-production", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    currentStep: 1,
    visualStyle: "",
    styles: [],
    scenes: [],
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---- tests ------------------------------------------------------------------

describe("higgsfieldCliRawId / isAvailable", () => {
  it("strips the CLI prefix and reports binary presence", () => {
    expect(higgsfieldCliRawId(`${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`)).toBe("seedance_2_0");
    expect(higgsfieldCliRawId("seedance_2_0")).toBe("seedance_2_0");
    const { run } = fakeRun(baseHandler());
    expect(provider(run, "higgsfield").isAvailable()).toBe(true);
    expect(provider(run, null).isAvailable()).toBe(false);
    expect(provider(run, null).imageGenFn(makeProduction())).toBeNull();
  });
});

describe("resolveHiggsfieldCliBinary", () => {
  it("passes a real binary through and resolves npm .cmd shims to vendor/hf", async () => {
    const prefix = path.join(dataDir, "fake-npm");
    const binDir = path.join(prefix, "node_modules", ".bin");
    const vendorDir = path.join(prefix, "node_modules", "@higgsfield", "cli", "vendor");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(vendorDir, { recursive: true });
    // A real PE binary (MZ header) passes through as-is.
    const realExe = path.join(binDir, "higgsfield.exe");
    fs.writeFileSync(realExe, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
    expect(await resolveHiggsfieldCliBinary(realExe)).toBe(realExe);
    // A .cmd shim resolves to the npm layout's vendor binary.
    const shim = path.join(binDir, "higgsfield.cmd");
    fs.writeFileSync(shim, "@ECHO off");
    const vendorBin = path.join(vendorDir, process.platform === "win32" ? "hf.exe" : "hf");
    fs.writeFileSync(vendorBin, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
    expect(await resolveHiggsfieldCliBinary(shim)).toBe(vendorBin);
    // Missing paths resolve to null (PATH probe finds no test binary).
    expect(await resolveHiggsfieldCliBinary(path.join(dataDir, "nope", "higgsfield"))).toBeNull();
  });
});

describe("HiggsfieldCliProvider.listModelChoices", () => {
  it("namespaces ids and classifies by the requested list (no synthetic Auto)", async () => {
    const { run } = fakeRun(baseHandler());
    const choices = await provider(run).listModelChoices();
    expect(choices.map((c) => c.id)).toEqual([
      `${HIGGSFIELD_CLI_ID_PREFIX}cinematic_studio_2_5`,
      `${HIGGSFIELD_CLI_ID_PREFIX}nano_banana_2`,
      `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`,
      `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_5`,
      `${HIGGSFIELD_CLI_ID_PREFIX}kling3_0`,
      `${HIGGSFIELD_CLI_ID_PREFIX}veo3`,
      `${HIGGSFIELD_CLI_ID_PREFIX}veo3_1_lite`,
    ]);
    expect(choices.some((c) => c.id === "auto")).toBe(false);
    expect(choices[0]).toMatchObject({ imageInput: true, videoInput: false });
    expect(choices[2]).toMatchObject({ imageInput: false, videoInput: true });
  });

  it("tolerates envelope replies and isolates one list's failure", async () => {
    const { run } = fakeRun((args) => {
      if (args[2] === "--image") return ok(JSON.stringify({ data: [{ job_type: "m1", name: "M1" }] }));
      return fail("video list down");
    });
    const choices = await provider(run).listModelChoices();
    expect(choices.map((c) => c.id)).toEqual([`${HIGGSFIELD_CLI_ID_PREFIX}m1`]);
  });
});

describe("HiggsfieldCliProvider.getCredits", () => {
  it("reads the signed-in account's credit balance", async () => {
    const { run } = fakeRun(baseHandler());
    expect(await provider(run).getCredits()).toBe(1388.74);
  });

  it("returns null when account status fails", async () => {
    const { run } = fakeRun(() => fail("Session expired"));
    expect(await provider(run).getCredits()).toBeNull();
  });
});

describe("HiggsfieldCliProvider.videoModelOptions", () => {
  it("resolves resolutions/durations from model get and caches the detail", async () => {
    const { run, calls } = fakeRun(baseHandler());
    const p = provider(run);
    // Live seedance_2_0: closed resolution enum, open integer duration.
    const first = await p.videoModelOptions(`${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`, true);
    expect(first).toEqual({ resolutions: ["480p", "720p", "1080p", "4k"], durations: [] });
    await p.videoModelOptions(`${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`, true);
    expect(calls.filter((a) => a[0] === "model" && a[1] === "get").length).toBe(1); // cached
    // Closed string duration enums parse to numbers.
    const lite = await p.videoModelOptions(`${HIGGSFIELD_CLI_ID_PREFIX}veo3_1_lite`, true);
    expect(lite).toEqual({ resolutions: ["720p"], durations: [4, 6, 8] });
  });

  it("returns null for foreign ids and unknown models", async () => {
    const { run } = fakeRun(baseHandler());
    const p = provider(run);
    expect(await p.videoModelOptions("openart:foo", true)).toBeNull();
    expect(await p.videoModelOptions("auto", true)).toBeNull();
    expect(await p.videoModelOptions(`${HIGGSFIELD_CLI_ID_PREFIX}nope`, true)).toBeNull();
  });
});

describe("HiggsfieldCliProvider.imageModelOptions", () => {
  it("reads quality tiers + default from model get", async () => {
    const { run } = fakeRun(baseHandler());
    const o = await provider(run).imageModelOptions(`${HIGGSFIELD_CLI_ID_PREFIX}cinematic_studio_2_5`);
    expect(o).toEqual({ qualities: ["basic", "high"], defaultQuality: "basic" });
  });

  it("returns null when the model declares no quality", async () => {
    const { run } = fakeRun(baseHandler());
    expect(await provider(run).imageModelOptions(`${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`)).toBeNull();
  });
});

describe("HiggsfieldCliProvider.videoEndFrameModels", () => {
  it("lists only the end-image models, namespaced", async () => {
    const { run } = fakeRun(baseHandler());
    const ids = await provider(run).videoEndFrameModels();
    expect(ids).toEqual([
      `${HIGGSFIELD_CLI_ID_PREFIX}kling3_0`,
      `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`,
      `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_5`,
      `${HIGGSFIELD_CLI_ID_PREFIX}veo3_1_lite`,
    ]);
  });
});

describe("HiggsfieldCliProvider.imageGenFn", () => {
  it("submits with refs/aspect/resolution/quality, waits, downloads, and records", async () => {
    const seen: string[][] = [];
    const { run } = fakeRun(
      baseHandler({
        "generate create cinematic_studio_2_5": (args) => {
          seen.push(args.slice(2));
          return ok(JSON.stringify({ job_id: "11111111-2222-3333-4444-555555555555" }));
        },
        "generate wait 11111111-2222-3333-4444-555555555555": () =>
          ok(JSON.stringify([{ id: "11111111-2222-3333-4444-555555555555", status: "completed", image_url: "https://example.invalid/out.png" }])),
      })
    );
    const onGeneration = vi.fn();
    const p = new HiggsfieldCliProvider({ binary: () => "higgsfield", run, recorder: { onGeneration } });
    const gen = p.imageGenFn(makeProduction({ openArt: { model: `${HIGGSFIELD_CLI_ID_PREFIX}cinematic_studio_2_5`, resolution: "2k", quality: "high" } }), undefined, undefined, undefined, "16:9")!;
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([9, 9, 9]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      const out = await gen("A castle", [{ name: "Hero", dataUrl: "data:image/png;base64,SGVsbG8=" }]);
      expect(out).toEqual(Buffer.from([9, 9, 9]));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toHaveLength(1);
    const args = seen[0];
    expect(args.slice(0, 2)).toEqual(["cinematic_studio_2_5", "--prompt"]);
    expect(args).toContain("--resolution");
    expect(args[args.indexOf("--resolution") + 1]).toBe("2k");
    expect(args[args.indexOf("--quality") + 1]).toBe("high");
    expect(args[args.indexOf("--aspect_ratio") + 1]).toBe("16:9");
    const imageIdx = args.indexOf("--image");
    expect(imageIdx).toBeGreaterThan(-1);
    expect(args[imageIdx + 1]).toMatch(/\.png$/);
    expect(onGeneration).toHaveBeenCalledTimes(1);
    expect(onGeneration).toHaveBeenCalledWith({
      kind: "image",
      model: `${HIGGSFIELD_CLI_ID_PREFIX}cinematic_studio_2_5`,
      resolution: "2k",
      aspectRatio: "16:9",
      at: expect.any(Number),
      productionId: "prod-1",
      shotId: undefined,
    });
  });

  it("records a pending job when the wait outlives the cap, then a recheck reclaims it", async () => {
    const jobId = "22222222-3333-4444-5555-666666666666";
    let finished = false;
    const { run } = fakeRun(
      baseHandler({
        "generate create cinematic_studio_2_5": () => ok(JSON.stringify([jobId])),
        "generate wait 22222222-3333-4444-5555-666666666666": () =>
          ok(JSON.stringify([{ id: jobId, status: "running" }])),
        "generate get 22222222-3333-4444-5555-666666666666": () =>
          finished
            ? ok(JSON.stringify({ id: jobId, status: "completed", image_url: "https://example.invalid/late.png" }))
            : ok(JSON.stringify({ id: jobId, status: "running" })),
      })
    );
    const p = provider(run);
    const gen = p.imageGenFn(makeProduction())!;
    const shot: ProductionShot = { id: "s1", number: "0100", audio: "", visual: "" };
    await expect(gen("A castle", [], shot)).rejects.toThrow(/timed out/i);
    expect(shot.pendingImageGen).toMatchObject({ historyId: jobId, prompt: "A castle" });

    // Still rendering → recheck reports pending (null).
    await expect(p.recheckPendingImage(shot.pendingImageGen!)).resolves.toBeNull();

    // Once finished server-side, a recheck downloads the frame.
    finished = true;
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([1, 2]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      await expect(p.recheckPendingImage(shot.pendingImageGen!)).resolves.toEqual(Buffer.from([1, 2]));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("throws a login hint when the CLI reports an expired session", async () => {
    const { run } = fakeRun(() => fail("Error: Session expired"));
    const gen = provider(run).imageGenFn(makeProduction())!;
    await expect(gen("x", [])).rejects.toThrow(/higgsfield auth login/);
  });
});

describe("HiggsfieldCliProvider.generateVideoClip", () => {
  const prodDir = (name: string): Production => {
    const folder = path.join(dataDir, name);
    fs.mkdirSync(path.join(folder, "boards"), { recursive: true });
    fs.mkdirSync(path.join(folder, "videos"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards", "shot-0100.jpg"), Buffer.from("jpeg-bytes"));
    return makeProduction({
      meta: { id: "prod-1", name: "Test Production", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    });
  };
  const shot = (): ProductionShot => ({ id: "s1", number: "0100", audio: "", visual: "", artwork: "boards/shot-0100.jpg" });

  it("binds start/end/refs, validates length, and records", async () => {
    const seen: string[][] = [];
    const jobId = "33333333-4444-5555-6666-777777777777";
    const { run } = fakeRun(
      baseHandler({
        "generate create seedance_2_0": (args) => {
          seen.push(args.slice(2));
          return ok(JSON.stringify({ job_id: jobId }));
        },
        [`generate wait ${jobId}`]: () =>
          ok(JSON.stringify([{ id: jobId, status: "succeeded", video_url: "https://example.invalid/clip.mp4" }])),
      })
    );
    const onGeneration = vi.fn();
    const p = new HiggsfieldCliProvider({ binary: () => "higgsfield", run, recorder: { onGeneration } });
    const prod = prodDir("prod-vid");
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([7, 7]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      const { rel } = await p.generateVideoClip(
        prod,
        shot(),
        { model: `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`, resolution: "720p", durationSec: 8, prompt: "animate" },
        () => {},
        undefined,
        [{ name: "Extra", dataUrl: "data:image/png;base64,RXh0cmE=" }],
        { start: { name: "A", dataUrl: "data:image/png;base64,QQ==" }, end: { name: "B", dataUrl: "data:image/png;base64,Qg==" } }
      );
      expect(rel).toContain("shot-0100-");
      expect(fs.existsSync(path.join(prod.meta.folder, rel))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toHaveLength(1);
    const args = seen[0];
    expect(args[args.indexOf("--start-image") + 1]).toMatch(/\.png$/);
    expect(args[args.indexOf("--end-image") + 1]).toMatch(/\.png$/);
    expect(args).toContain("--image-references");
    expect(args[args.indexOf("--duration") + 1]).toBe("8");
    expect(args[args.indexOf("--resolution") + 1]).toBe("720p");
    expect(onGeneration).toHaveBeenCalledWith({
      kind: "video",
      model: `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`,
      resolution: "720p",
      durationSec: 8,
      at: expect.any(Number),
      productionId: "prod-1",
      shotId: "s1",
    });
  });

  it("selects omni_reference on seedance_2_5 whenever media is attached", async () => {
    const seen: string[][] = [];
    const jobId = "55555555-6666-7777-8888-999999999999";
    const { run } = fakeRun(
      baseHandler({
        "generate create seedance_2_5": (args) => {
          seen.push(args.slice(2));
          return ok(JSON.stringify([jobId]));
        },
        [`generate wait ${jobId}`]: () =>
          ok(JSON.stringify([{ id: jobId, status: "completed", video_url: "https://example.invalid/s25.mp4" }])),
      })
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([5]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      await provider(run).generateVideoClip(prodDir("prod-s25"), shot(), {
        model: `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_5`, resolution: "1080p", durationSec: 8, prompt: "animate",
      }, () => {});
    } finally {
      globalThis.fetch = realFetch;
    }
    const args = seen[0];
    // seedance_2_5 carries media only in omni_reference mode (t2v takes none).
    expect(args).toContain("--start-image");
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("omni_reference");
  });

  it("fails loudly instead of coercing when the model can't do the requested length", async () => {
    let submitted = false;
    const { run } = fakeRun(
      baseHandler({
        "generate create veo3_1_lite": () => {
          submitted = true;
          return ok(JSON.stringify({ job_id: "x" }));
        },
      })
    );
    await expect(
      provider(run).generateVideoClip(prodDir("prod-short"), shot(), {
        model: `${HIGGSFIELD_CLI_ID_PREFIX}veo3_1_lite`, resolution: "720p", durationSec: 5, prompt: "animate",
      }, () => {})
    ).rejects.toThrow(/doesn't support a 5s clip \(supports 4, 6, 8s\)/);
    expect(submitted).toBe(false);
  });

  it("sends a tween end frame through the reference array on models without an end slot", async () => {
    const seen: string[][] = [];
    const jobId = "44444444-5555-6666-7777-888888888888";
    const { run } = fakeRun(
      baseHandler({
        "generate create veo3": (args) => {
          seen.push(args);
          return ok(JSON.stringify([jobId]));
        },
        [`generate wait ${jobId}`]: () =>
          ok(JSON.stringify({ id: jobId, status: "completed", results: ["https://example.invalid/v.mp4"] })),
      })
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([3]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      await provider(run).generateVideoClip(prodDir("prod-veo"), shot(), {
        model: `${HIGGSFIELD_CLI_ID_PREFIX}veo3`, resolution: "", durationSec: 5, prompt: "animate",
      }, () => {}, undefined, undefined, {
        start: { name: "A", dataUrl: "data:image/png;base64,QQ==" },
        end: { name: "B", dataUrl: "data:image/png;base64,Qg==" },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    const args = seen[0];
    // veo3 declares only the legacy `image` role: start rides --image, the
    // end frame falls back to the reference array, never --end-image.
    expect(args).toContain("--image");
    expect(args).toContain("--image-references");
    expect(args).not.toContain("--end-image");
  });
});
