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
  costCacheKey,
  emitSchemaField,
  parseCostCredits,
  resolveHiggsfieldCliBinary,
  type CliRun,
  type CliRunResult,
} from "../src/main/providers/higgsfield-cli.js";
import type { PendingImageGen, Production, ProductionShot } from "../src/shared/ipc.js";

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
  { job_type: "nano_banana_pro", name: "Nano Banana Pro", description: "Reference work." },
  { job_type: "gpt_image_2_5", name: "GPT Image 2.5", description: "Newest GPT image model." },
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

/** gpt_image_2_5's full parameter surface (the plan's worked example):
 *  quality/resolution/variant/aspect_ratio/background enums, a repeatable
 *  reference array capped at 16, a bounded integer, and a required prompt. */
const gptImageGet = () =>
  JSON.stringify({
    display_name: "GPT Image 2.5",
    job_type: "gpt_image_2_5",
    type: "image",
    parameters: [
      { name: "quality", type: "string", options: ["low", "medium", "high", "xhigh", "max"], default: "low" },
      { name: "resolution", type: "string", options: ["1k", "2k", "4k"], default: "1k" },
      { name: "variant", type: "string", options: ["flare", "sunburst"], default: "flare" },
      { name: "aspect_ratio", type: "string", options: ["auto", "1:1", "16:9"], default: "1:1" },
      { name: "background", type: "string", options: ["auto", "opaque", "transparent"], default: "auto" },
      { name: "image_references", type: "array", default: null },
      { name: "seed", type: "integer", default: 0, min: 0, max: 1000000 },
      { name: "prompt", type: "string", required: true },
    ],
  });

const studioImageGet = () =>
  JSON.stringify({
    aspect_ratios: ["1:1", "16:9", "9:16"],
    parameters: [
      { name: "resolution", options: ["1k", "2k", "4k"], default: "1k" },
      { name: "quality", options: ["basic", "high"], default: "basic" },
      { name: "aspect_ratio", options: ["1:1", "16:9", "9:16"], default: "1:1" },
      { name: "prompt", type: "string", required: true },
    ],
    medias: [{ roles: ["image"] }],
  });

/** Live nano_banana_pro shape (from a failed job's params): a single
 *  `input_image` base slot AND an `input_images` reference array. */
const nanoBananaProGet = () =>
  JSON.stringify({
    display_name: "Nano Banana Pro",
    job_type: "nano_banana_pro",
    type: "image",
    params: [
      { name: "input_image", type: "object|null", default: null },
      { name: "input_images", type: "array", default: null },
      { name: "aspect_ratio", type: "string", enum: ["1:1", "16:9", "9:16"], default: "16:9" },
      { name: "resolution", type: "string", enum: ["1k", "2k", "4k"], default: "2k" },
      { name: "prompt", type: "string", required: true },
    ],
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
      if (args[2] === "nano_banana_pro") return ok(nanoBananaProGet());
      if (args[2] === "gpt_image_2_5") return ok(gptImageGet());
      return fail(`Unknown model: ${args[2]}`);
    }
    if (verb === "account status") return ok(JSON.stringify({ credits: 1388.74 }));
    throw new Error(`No fake handler for higgs args "${args.join(" ")}"`);
  };
}

/** Live `model get seedance_2_5` shape (probed 2026-10-16): `params`
 *  vocabulary, duration is an OPEN integer (no enum, no min/max — the
 *  server enforces its own bounds), media slots are params, no medias. */
const seedance25Get = () =>
  JSON.stringify({
    display_name: "Seedance 2.5",
    job_type: "seedance_2_5",
    type: "video",
    params: [
      { name: "aspect_ratio", type: "string", default: "16:9", required: false, enum: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] },
      { name: "audio_references", type: "array", default: null, required: false },
      { name: "bitrate_mode", type: "string", default: "standard", required: false, enum: ["standard", "high"] },
      { name: "draft", type: "boolean", default: false, required: false },
      { name: "draft_job_id", type: "string|null", default: null, required: false },
      { name: "duration", type: "integer", default: 5, required: false },
      { name: "end_image", type: "object|null", default: null, required: false },
      { name: "extension_mode", type: "string|null", default: null, required: false, enum: ["backward", "forward"] },
      { name: "generate_audio", type: "boolean", default: true, required: false },
      { name: "image_references", type: "array", default: null, required: false },
      { name: "mode", type: "string", default: "t2v", required: false, enum: ["t2v", "omni_reference", "video_edit", "video_extension"] },
      { name: "prompt", type: "string", default: null, required: true },
      { name: "resolution", type: "string", default: "720p", required: false, enum: ["480p", "720p", "1080p"] },
      { name: "start_image", type: "object|null", default: null, required: false },
      { name: "video_references", type: "array", default: null, required: false },
    ],
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
      `${HIGGSFIELD_CLI_ID_PREFIX}nano_banana_pro`,
      `${HIGGSFIELD_CLI_ID_PREFIX}gpt_image_2_5`,
      `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`,
      `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_5`,
      `${HIGGSFIELD_CLI_ID_PREFIX}kling3_0`,
      `${HIGGSFIELD_CLI_ID_PREFIX}veo3`,
      `${HIGGSFIELD_CLI_ID_PREFIX}veo3_1_lite`,
    ]);
    expect(choices.some((c) => c.id === "auto")).toBe(false);
    expect(choices[0]).toMatchObject({ imageInput: true, videoInput: false });
    expect(choices[4]).toMatchObject({ imageInput: false, videoInput: true });
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

describe("HiggsfieldCliProvider catalog caching", () => {
  it("does not cache a failed list fetch — the next call retries and surfaces new models", async () => {
    // Regression: a failed `model list` was cached as an EMPTY list for
    // the whole TTL, so one congested minute hid the catalog (including
    // brand-new models like nano_banana_2_1) long after the vendor
    // recovered — Refresh probe then appeared to do nothing.
    let imageCalls = 0;
    const { run } = fakeRun(
      baseHandler({
        "model list --image": () => {
          imageCalls++;
          return imageCalls === 1
            ? fail("Error: timed out")
            : ok(JSON.stringify([{ job_type: "nano_banana_2_1", display_name: "Nano Banana 2.1", type: "image" }]));
        },
      })
    );
    const p = provider(run);
    const first = await p.listModelChoices();
    expect(first.some((c) => c.id === `${HIGGSFIELD_CLI_ID_PREFIX}nano_banana_2_1`)).toBe(false);
    const second = await p.listModelChoices();
    expect(second.some((c) => c.id === `${HIGGSFIELD_CLI_ID_PREFIX}nano_banana_2_1`)).toBe(true);
    expect(imageCalls).toBe(2);
  });

  it("retries after a failed refresh instead of caching the outage", async () => {
    let down = false;
    const { run } = fakeRun(
      baseHandler({
        "model list --image": () =>
          down ? fail("Error: timed out") : ok(JSON.stringify([{ job_type: "m1", name: "M1" }])),
      })
    );
    const p = provider(run);
    await p.listModelChoices();
    p.refreshProbes();
    down = true;
    const during = await p.listModelChoices();
    expect(during.some((c) => c.id === `${HIGGSFIELD_CLI_ID_PREFIX}m1`)).toBe(false);
    down = false;
    const after = await p.listModelChoices();
    expect(after.some((c) => c.id === `${HIGGSFIELD_CLI_ID_PREFIX}m1`)).toBe(true);
  });

  it("does not cache an empty/garbled list reply — the next call retries and surfaces new models", async () => {
    // A reply that exits 0 but parses to zero items (truncated/garbled
    // stdout) is a failed fetch, not an empty catalog: caching it hid
    // brand-new models (nano_banana_2_1) for the full TTL even though
    // Refresh appeared to run.
    let imageCalls = 0;
    const { run } = fakeRun(
      baseHandler({
        "model list --image": () => {
          imageCalls++;
          return imageCalls === 1
            ? ok("[]")
            : ok(JSON.stringify([{ job_type: "nano_banana_2_1", display_name: "Nano Banana 2.1", type: "image" }]));
        },
      })
    );
    const p = provider(run);
    const first = await p.listModelChoices();
    expect(first.some((c) => c.id === `${HIGGSFIELD_CLI_ID_PREFIX}nano_banana_2_1`)).toBe(false);
    const second = await p.listModelChoices();
    expect(second.some((c) => c.id === `${HIGGSFIELD_CLI_ID_PREFIX}nano_banana_2_1`)).toBe(true);
    // One shared fetch per listModelChoices call (concurrent callers
    // dedupe onto a single in-flight pair of CLI spawns).
    expect(imageCalls).toBe(2);
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
    expect(first).toMatchObject({ resolutions: ["480p", "720p", "1080p", "4k"], durations: [] });
    // Open integer duration → an open durationRange, not a closed empty list.
    expect(first!.durationRange).toEqual({});
    expect(first!.aspectRatios).toEqual(["auto", "16:9", "9:16"]);
    await p.videoModelOptions(`${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`, true);
    expect(calls.filter((a) => a[0] === "model" && a[1] === "get").length).toBe(1); // cached
    // Closed string duration enums parse to numbers.
    const lite = await p.videoModelOptions(`${HIGGSFIELD_CLI_ID_PREFIX}veo3_1_lite`, true);
    expect(lite).toMatchObject({ resolutions: ["720p"], durations: [4, 6, 8] });
    expect(lite!.durationRange).toBeUndefined();
    // Live seedance_2_5: open integer duration like seedance_2_0.
    const s25 = await p.videoModelOptions(`${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_5`, true);
    expect(s25).toMatchObject({ resolutions: ["480p", "720p", "1080p"], durations: [] });
    expect(s25!.durationRange).toEqual({});
  });

  it("carries declared min/max bounds into durationRange for an open-integer model", async () => {
    const { run } = fakeRun(baseHandler({
      "model get bounded_1": () => ok(JSON.stringify({
        display_name: "Bounded",
        job_type: "bounded_1",
        type: "video",
        params: [
          { name: "duration", type: "integer", default: 5, required: false, min: 3, max: 12 },
          { name: "resolution", type: "string", default: "720p", required: false, enum: ["720p"] },
          { name: "start_image", type: "object|null", default: null, required: false },
        ],
      })),
    }));
    const o = await provider(run).videoModelOptions(`${HIGGSFIELD_CLI_ID_PREFIX}bounded_1`, true);
    expect(o).toMatchObject({ resolutions: ["720p"], durations: [] });
    expect(o!.durationRange).toEqual({ min: 3, max: 12 });
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
    expect(o).toMatchObject({
      qualities: ["basic", "high"],
      defaultQuality: "basic",
      aspectRatios: ["1:1", "16:9", "9:16"],
      resolutions: ["1k", "2k", "4k"],
      defaultResolution: "1k",
    });
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

describe("HiggsfieldCliProvider.videoEditModels / generateVideoEdit", () => {
  it("lists models declaring a video input role", async () => {
    const { run } = fakeRun(baseHandler());
    const ids = await provider(run).videoEditModels();
    expect(ids).toEqual([
      `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`,
      `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_5`,
    ]);
  });

  it("submits the source clip via --video-references", async () => {
    const seen: string[][] = [];
    const jobId = "99999999-aaaa-bbbb-cccc-dddddddddddd";
    const { run } = fakeRun(
      baseHandler({
        "generate create seedance_2_0": (args) => {
          seen.push(args);
          return ok(JSON.stringify({ job_id: jobId }));
        },
        [`generate wait ${jobId}`]: () =>
          ok(JSON.stringify([{ id: jobId, status: "completed", video_url: "https://example.invalid/edit.mp4" }])),
      })
    );
    const folder = path.join(dataDir, "prod-edit");
    fs.mkdirSync(path.join(folder, "videos"), { recursive: true });
    fs.writeFileSync(path.join(folder, "videos", "source.mp4"), Buffer.from("video-bytes"));
    const prod = makeProduction({
      meta: { id: "prod-1", name: "T", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    });
    const shot: ProductionShot = { id: "s1", number: "0100", audio: "", visual: "" };
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([8]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      await provider(run).generateVideoEdit(
        prod,
        shot,
        { model: `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`, resolution: "720p", durationSec: 0, prompt: "replace the sky" },
        () => {},
        "videos/source.mp4"
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    const args = seen[0];
    const vIdx = args.indexOf("--video-references");
    expect(vIdx).toBeGreaterThan(-1);
    expect(args[vIdx + 1]).toMatch(/\.mp4$/);
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

  it("routes reference art to --image-references on an array-reference model", async () => {
    const seen: string[][] = [];
    const jobId = "55555555-6666-7777-8888-999999999999";
    const { run } = fakeRun(
      baseHandler({
        "generate create gpt_image_2_5": (args) => {
          seen.push(args.slice(2));
          return ok(JSON.stringify({ job_id: jobId }));
        },
        [`generate wait ${jobId}`]: () =>
          ok(JSON.stringify([{ id: jobId, status: "completed", image_url: "https://example.invalid/out.png" }])),
      })
    );
    const p = provider(run);
    const gen = p.imageGenFn(
      makeProduction({ openArt: { model: `${HIGGSFIELD_CLI_ID_PREFIX}gpt_image_2_5`, resolution: "2k" } }),
      undefined, undefined, undefined, "16:9"
    )!;
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([7]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      await gen("A castle", [{ name: "Hero", dataUrl: "data:image/png;base64,SGVsbG8=" }]);
    } finally {
      globalThis.fetch = realFetch;
    }
    const args = seen[0];
    expect(args).toContain("--image-references");
    expect(args).not.toContain("--image");
  });

  it("routes the base image to the single slot and extras to the array (nano_banana_pro)", async () => {
    const seen: string[][] = [];
    const jobId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const { run } = fakeRun(
      baseHandler({
        "generate create nano_banana_pro": (args) => {
          seen.push(args.slice(2));
          return ok(JSON.stringify({ job_id: jobId }));
        },
        [`generate wait ${jobId}`]: () =>
          ok(JSON.stringify([{ id: jobId, status: "completed", image_url: "https://example.invalid/out.png" }])),
      })
    );
    const p = provider(run);
    const gen = p.imageGenFn(
      makeProduction({ openArt: { model: `${HIGGSFIELD_CLI_ID_PREFIX}nano_banana_pro`, resolution: "2k" } }),
      undefined, undefined, undefined, "16:9"
    )!;
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([8]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      await gen("A castle", [
        { name: "Source", dataUrl: "data:image/png;base64,SGVsbG8=" },
        { name: "Ref", dataUrl: "data:image/png;base64,SGVsbG8=" },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
    const args = seen[0];
    // Base image → --image (input_image); extra → --image-references (input_images).
    expect(args.filter((a) => a === "--image")).toHaveLength(1);
    expect(args.filter((a) => a === "--image-references")).toHaveLength(1);
    expect(args[args.indexOf("--image") + 1]).toMatch(/\.png$/);
    expect(args[args.indexOf("--image-references") + 1]).toMatch(/\.png$/);
  });

  it("records a pending job when the wait outlives the cap, then a recheck reclaims it", async () => {
    const jobId = "22222222-3333-4444-5555-666666666666";
    let finished = false;
    const { run } = fakeRun(
      baseHandler({
        // makeProduction() has no model → the house default (gpt_image_2_5,
        // now present in the fixture list) resolves.
        "generate create gpt_image_2_5": () => ok(JSON.stringify([jobId])),
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

  it("records the pending job at submission (before the wait ends) and clears it on success", async () => {
    const jobId = "33333333-4444-5555-6666-777777777777";
    const seen: (PendingImageGen | null)[] = [];
    let atWait: PendingImageGen | undefined;
    const shot: ProductionShot = { id: "s1", number: "0100", audio: "", visual: "" };
    const { run } = fakeRun(
      baseHandler({
        "generate create gpt_image_2_5": () => ok(JSON.stringify([jobId])),
        [`generate wait ${jobId}`]: () => {
          atWait = shot.pendingImageGen;
          return ok(JSON.stringify([{ id: jobId, status: "completed", image_url: "https://example.invalid/fast.png" }]));
        },
      })
    );
    const p = provider(run);
    const gen = p.imageGenFn(makeProduction())!;
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([7]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      const out = await gen("A castle", [], shot, undefined, (rec) => { seen.push(rec); });
      expect(out).toEqual(Buffer.from([7]));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(atWait).toMatchObject({ historyId: jobId, prompt: "A castle" });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ historyId: jobId });
    expect(seen[1]).toBeNull();
    expect(shot.pendingImageGen).toBeUndefined();
  });

  it("throws a login hint when the CLI reports an expired session", async () => {
    const { run } = fakeRun(() => fail("Error: Session expired"));
    const gen = provider(run).imageGenFn(makeProduction())!;
    await expect(gen("x", [])).rejects.toThrow(/higgsfield auth login/);
  });

  it("surfaces the vendor reason when a job fails", async () => {
    const jobId = "44444444-5555-6666-7777-888888888888";
    const { run } = fakeRun(
      baseHandler({
        "generate create gpt_image_2_5": () => ok(JSON.stringify({ job_id: jobId })),
        // `generate wait` exits non-zero on a terminal failure.
        [`generate wait ${jobId}`]: () => fail(`Error: job ${jobId} ended with status "failed"`),
        // The follow-up get carries the vendor's reason.
        [`generate get ${jobId}`]: () =>
          ok(JSON.stringify({ id: jobId, status: "failed", error: "content flagged: reference image rejected" })),
      })
    );
    const gen = provider(run).imageGenFn(makeProduction())!;
    await expect(gen("x", [])).rejects.toThrow(/content flagged: reference image rejected/);
  });
});

describe("HiggsfieldCliProvider upscale", () => {
  const upscaleList = JSON.stringify([
    { job_type: "gpt_image_2_5", name: "GPT Image 2.5" },
    { job_type: "bytedance_image_upscale", name: "Bytedance Image Upscale" },
    { job_type: "topaz_image", name: "Topaz" },
  ]);
  const upscaleDetail = JSON.stringify({
    display_name: "Bytedance Image Upscale",
    job_type: "bytedance_image_upscale",
    type: "image",
    params: [
      { name: "image_references", type: "array", required: true },
      { name: "remove_bg", type: "boolean", default: false },
      { name: "resolution", type: "string", enum: ["2k", "4k"], default: "4k" },
    ],
    rules: [{ cel: "size(params.image_references) == 1" }],
  });

  function upscaleRun(extra: Record<string, Handler> = {}): Handler {
    return (args) => {
      const verb = args.slice(0, 2).join(" ");
      const key = `${verb} ${args[2] ?? ""}`.trim();
      if (extra[key]) return extra[key](args);
      if (verb === "model list") return ok(args.includes("--image") ? upscaleList : "[]");
      if (verb === "model get") {
        if (args[2] === "bytedance_image_upscale") return ok(upscaleDetail);
        return fail(`Unknown model: ${args[2]}`);
      }
      throw new Error(`No fake handler for higgs args "${args.join(" ")}"`);
    };
  }

  it("lists only the catalog's upscale models, namespaced", async () => {
    const { run } = fakeRun(upscaleRun());
    const ids = await provider(run).imageUpscaleModels();
    expect(ids).toEqual([
      `${HIGGSFIELD_CLI_ID_PREFIX}bytedance_image_upscale`,
      `${HIGGSFIELD_CLI_ID_PREFIX}topaz_image`,
    ]);
  });

  it("submits an upscale without --prompt (schema declares none)", async () => {
    const seen: string[][] = [];
    const jobId = "11111111-2222-3333-4444-555555555555";
    const { run } = fakeRun(upscaleRun({
      "generate create bytedance_image_upscale": (args) => {
        seen.push(args.slice(2));
        return ok(JSON.stringify({ job_id: jobId }));
      },
      [`generate wait ${jobId}`]: () =>
        ok(JSON.stringify([{ id: jobId, status: "completed", image_url: "https://example.invalid/up.png" }])),
    }));
    const p = provider(run);
    const gen = p.imageGenFn(
      makeProduction({ openArt: { model: `${HIGGSFIELD_CLI_ID_PREFIX}bytedance_image_upscale`, resolution: "4k" } }),
      undefined, undefined, undefined, "16:9"
    )!;
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([7]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      const out = await gen("", [{ name: "frame", dataUrl: "data:image/png;base64,SGVsbG8=" }]);
      expect(out).toEqual(Buffer.from([7]));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toHaveLength(1);
    const args = seen[0];
    // No prompt: the upscale model rejects it.
    expect(args).not.toContain("--prompt");
    expect(args.slice(0, 1)).toEqual(["bytedance_image_upscale"]);
    // The source image rides the declared array slot.
    const refIdx = args.indexOf("--image-references");
    expect(refIdx).toBeGreaterThan(-1);
    expect(args[refIdx + 1]).toMatch(/\.png$/);
    // Resolution is emitted only when the model lists it.
    expect(args[args.indexOf("--resolution") + 1]).toBe("4k");
  });

  it("derives required output_width/output_height from the source image", async () => {
    const seen: string[][] = [];
    const jobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const topazDetail = JSON.stringify({
      display_name: "Topaz",
      job_type: "topaz_image",
      type: "image",
      params: [
        { name: "image_references", type: "array", required: true },
        { name: "output_width", type: "integer", required: true },
        { name: "output_height", type: "integer", required: true },
      ],
    });
    const { run } = fakeRun((args) => {
      const verb = args.slice(0, 2).join(" ");
      const key = `${verb} ${args[2] ?? ""}`.trim();
      if (verb === "model list") return ok(args.includes("--image") ? JSON.stringify([{ job_type: "topaz_image", name: "Topaz" }]) : "[]");
      if (verb === "model get") return ok(topazDetail);
      if (key === "generate create topaz_image") {
        seen.push(args.slice(2));
        return ok(JSON.stringify({ job_id: jobId }));
      }
      if (key === `generate wait ${jobId}`) {
        return ok(JSON.stringify([{ id: jobId, status: "completed", image_url: "https://example.invalid/up.png" }]));
      }
      throw new Error(`No fake handler for higgs args "${args.join(" ")}"`);
    });
    const p = provider(run);
    const gen = p.imageGenFn(
      makeProduction({ openArt: { model: `${HIGGSFIELD_CLI_ID_PREFIX}topaz_image`, resolution: "4k" } }),
      undefined, undefined, undefined, "16:9"
    )!;
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([1]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    // A 4×2 PNG source → the derived 2× target is 8×4.
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    png.set([0x00, 0x00, 0x00, 0x0d], 8);
    png.set([0x49, 0x48, 0x44, 0x52], 12);
    const dv = new DataView(png.buffer);
    dv.setUint32(16, 4);
    dv.setUint32(20, 2);
    const source = { name: "frame", dataUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}` };
    let auto: string[] = [];
    let user: string[] = [];
    try {
      await gen("", [source]);
      auto = seen[0];
      seen.length = 0;
      // A user-supplied size wins and is never duplicated.
      await gen("", [source], undefined, { output_width: 100, output_height: 50 });
      user = seen[0];
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(auto[auto.indexOf("--output_width") + 1]).toBe("8");
    expect(auto[auto.indexOf("--output_height") + 1]).toBe("4");
    expect(user.filter((a) => a === "--output_width")).toHaveLength(1);
    expect(user[user.indexOf("--output_width") + 1]).toBe("100");
    expect(user[user.indexOf("--output_height") + 1]).toBe("50");
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
    // In-between mode is start/end ONLY: the extra reference never rides a
    // reference array alongside the frame slots (models reject the mix).
    expect(args).not.toContain("--image-references");
    expect(args).not.toContain("--video-references");
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

  it("submits a Seedance draft at 480p with --draft and returns the draft job id", async () => {
    const seen: string[][] = [];
    const jobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const { run } = fakeRun(
      baseHandler({
        "generate create seedance_2_5": (args) => {
          seen.push(args.slice(2));
          return ok(JSON.stringify({ job_id: jobId }));
        },
        [`generate wait ${jobId}`]: () =>
          ok(JSON.stringify([{ id: jobId, status: "succeeded", video_url: "https://example.invalid/draft.mp4" }])),
      })
    );
    const onGeneration = vi.fn();
    const p = new HiggsfieldCliProvider({ binary: () => "higgsfield", run, recorder: { onGeneration } });
    const prod = prodDir("prod-draft");
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([1, 1]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    let res: { rel: string; jobId?: string };
    try {
      res = await p.generateVideoClip(
        prod,
        shot(),
        { model: `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_5`, resolution: "1080p", durationSec: 4, prompt: "animate", draft: true },
        () => {}
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    const args = seen[0];
    expect(args[args.indexOf("--draft") + 1]).toBe("true");
    // Draft forces 480p even though the caller asked for 1080p.
    expect(args[args.indexOf("--resolution") + 1]).toBe("480p");
    // The returned job id is what a later finalize needs.
    expect(res.jobId).toBe(jobId);
    expect(onGeneration).toHaveBeenCalledWith(expect.objectContaining({ kind: "video", resolution: "480p" }));
  });

  it("translates the vendor's bare 'Not found' draft rejection into an actionable error", async () => {
    // Live behavior (2026-10-16): `draft: true` is advertised in the
    // seedance_2_5 schema but the API answers "Error: Not found" wherever
    // Draft Mode isn't enabled (region-restricted — not offered in the US),
    // while the identical request without `draft` prices/submits fine.
    const { run } = fakeRun(
      baseHandler({
        "generate create seedance_2_5": () => fail("Error: Not found"),
      })
    );
    const p = provider(run);
    const prod = prodDir("prod-draft-404");
    const s = shot();
    await expect(p.generateVideoClip(
      prod,
      s,
      { model: `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_5`, resolution: "1080p", durationSec: 6, prompt: "animate", draft: true },
      () => {}
    )).rejects.toThrow(/Draft Mode isn't available/);
    // Nothing was submitted — no pending record to reclaim.
    expect(s.pendingVideoGen).toBeUndefined();
  });

  it("reports live status between wait slices instead of going silent for the whole wait", async () => {
    // A slow vendor queue: the first `generate wait` slice elapses with the
    // job still queued (exit 3, "timed out waiting … (last status
    // \"queued\")" — verified against the live CLI), the next slice lands
    // it. The caller must hear "queued" as progress, not silence/failure.
    const jobId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    let waits = 0;
    const { run } = fakeRun(
      baseHandler({
        "generate create seedance_2_0": () => ok(JSON.stringify({ job_id: jobId })),
        [`generate wait ${jobId}`]: () => {
          waits++;
          return waits === 1
            ? fail(`Error: timed out waiting for job ${jobId} (last status "queued")`)
            : ok(JSON.stringify([{ id: jobId, status: "succeeded", video_url: "https://example.invalid/out.mp4" }]));
        },
      })
    );
    const p = provider(run);
    const prod = prodDir("prod-sliced-wait");
    const emits: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      arrayBuffer: async () => Uint8Array.from([9]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      const res = await p.generateVideoClip(
        prod,
        shot(),
        { model: `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`, resolution: "720p", durationSec: 8, prompt: "animate" },
        (m) => emits.push(String(m))
      );
      expect(res.rel).toMatch(/\.mp4$/);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(waits).toBe(2);
    expect(emits.some((m) => /video queued/i.test(m))).toBe(true);
  });

  it("finalizes a draft via --draft-job-id with no prompt or references", async () => {
    const seen: string[][] = [];
    const newId = "11111111-2222-3333-4444-555555555555";
    const draftId = "99999999-8888-7777-6666-555555555555";
    const { run } = fakeRun(
      baseHandler({
        "generate create seedance_2_5": (args) => {
          seen.push(args.slice(2));
          return ok(JSON.stringify({ job_id: newId }));
        },
        [`generate wait ${newId}`]: () =>
          ok(JSON.stringify([{ id: newId, status: "succeeded", video_url: "https://example.invalid/final.mp4" }])),
      })
    );
    const onGeneration = vi.fn();
    const p = new HiggsfieldCliProvider({ binary: () => "higgsfield", run, recorder: { onGeneration } });
    const prod = prodDir("prod-finalize");
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([2, 2]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      await p.generateVideoClip(
        prod,
        shot(),
        { model: `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_5`, resolution: "1080p", durationSec: 5, prompt: "", draftJobId: draftId },
        () => {}
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    const args = seen[0];
    expect(args[0]).toBe("seedance_2_5");
    expect(args[args.indexOf("--draft-job-id") + 1]).toBe(draftId);
    expect(args).not.toContain("--prompt");
    expect(args).not.toContain("--start-image");
    expect(args).not.toContain("--draft");
    expect(onGeneration).toHaveBeenCalledWith(expect.objectContaining({ kind: "video", resolution: "1080p" }));
  });

  it("records a pending video when the wait outlives the cap, then a recheck reclaims it", async () => {
    const jobId = "66666666-7777-8888-9999-000000000000";
    let finished = false;
    const { run } = fakeRun(
      baseHandler({
        "generate create seedance_2_0": () => ok(JSON.stringify({ job_id: jobId })),
        [`generate wait ${jobId}`]: () => ok(JSON.stringify([{ id: jobId, status: "running" }])),
        [`generate get ${jobId}`]: () =>
          finished
            ? ok(JSON.stringify({ id: jobId, status: "completed", video_url: "https://example.invalid/late.mp4" }))
            : ok(JSON.stringify({ id: jobId, status: "running" })),
      })
    );
    const p = provider(run);
    const prod = prodDir("prod-vid-pending");
    const s = shot();
    await expect(
      p.generateVideoClip(prod, s, { model: `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`, resolution: "720p", durationSec: 5, prompt: "animate" }, () => {})
    ).rejects.toThrow(/timed out/i);
    expect(s.pendingVideoGen).toMatchObject({ historyId: jobId, prompt: "animate", durationSec: 5 });

    // Still rendering → recheck reports pending (null).
    await expect(p.recheckPendingVideo(s.pendingVideoGen!)).resolves.toBeNull();

    // Once finished server-side, a recheck downloads the clip.
    finished = true;
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([5, 5]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      await expect(p.recheckPendingVideo(s.pendingVideoGen!)).resolves.toEqual({ buf: Buffer.from([5, 5]), ext: "mp4" });
    } finally {
      globalThis.fetch = realFetch;
    }
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
    // Generation surfaces use reference mode: the source frame rides the
    // reference array, never the start slot. seedance_2_5 carries media
    // only in omni_reference mode (t2v takes none).
    expect(args).not.toContain("--start-image");
    expect(args).toContain("--image-references");
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("omni_reference");
  });

  it("fails loudly instead of coercing when the model can't do the requested length", async () => {    let submitted = false;
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

  it("fails loudly when a tween model has no end slot (never falls back to the reference array)", async () => {
    let submitted = false;
    const { run } = fakeRun(
      baseHandler({
        "generate create veo3": () => {
          submitted = true;
          return ok(JSON.stringify({ job_id: "x" }));
        },
      })
    );
    // veo3 declares only the legacy `image` role — in-betweening needs a
    // real end-image slot, and routing the end frame through a reference
    // array alongside the start slot is exactly the mix vendors reject.
    await expect(
      provider(run).generateVideoClip(prodDir("prod-veo"), shot(), {
        model: `${HIGGSFIELD_CLI_ID_PREFIX}veo3`, resolution: "", durationSec: 5, prompt: "animate",
      }, () => {}, undefined, undefined, {
        start: { name: "A", dataUrl: "data:image/png;base64,QQ==" },
        end: { name: "B", dataUrl: "data:image/png;base64,Qg==" },
      })
    ).rejects.toThrow(/doesn't accept an end frame/);
    expect(submitted).toBe(false);
  });

  it("never mixes frame slots with reference media on generation surfaces (minimax_h3 / wan shape)", async () => {
    const seen: string[][] = [];
    const jobId = "12121212-3434-5656-7878-909090909090";
    const minimaxGet = JSON.stringify({
      display_name: "MiniMax H3",
      job_type: "minimax_h3",
      type: "video",
      params: [
        { name: "duration", type: "integer", default: 5, required: false },
        { name: "resolution", type: "string", default: "768P", required: false, enum: ["768P", "1080P"] },
        { name: "start_image", type: "object|null", default: null, required: false },
        { name: "end_image", type: "object|null", default: null, required: false },
        { name: "image_references", type: "array", default: null, required: false },
        { name: "video_references", type: "array", default: null, required: false },
        { name: "audio_references", type: "array", default: null, required: false },
        { name: "prompt", type: "string", default: null, required: true },
      ],
    });
    const { run } = fakeRun(
      baseHandler({
        "model list --video": () => ok(JSON.stringify([{ job_type: "minimax_h3", name: "MiniMax H3" }])),
        "model get minimax_h3": () => ok(minimaxGet),
        "generate create minimax_h3": (args) => {
          seen.push(args);
          return ok(JSON.stringify({ job_id: jobId }));
        },
        [`generate wait ${jobId}`]: () =>
          ok(JSON.stringify([{ id: jobId, status: "succeeded", video_url: "https://example.invalid/mm.mp4" }])),
      })
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([9]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      // Video-node/classic shape: source frame + wired image/video refs.
      await provider(run).generateVideoClip(prodDir("prod-mm"), shot(), {
        model: `${HIGGSFIELD_CLI_ID_PREFIX}minimax_h3`, resolution: "768P", durationSec: 5, prompt: "animate",
        refsOnly: true,
      }, () => {}, undefined, [
        { name: "Extra", dataUrl: "data:image/png;base64,RXh0cmE=" },
        { name: "Clip", dataUrl: "data:video/mp4;base64,AAAA" },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
    const args = seen[0];
    expect(args).not.toContain("--start-image");
    expect(args).not.toContain("--end-image");
    expect(args.filter((a) => a === "--image-references")).toHaveLength(2);
    expect(args.filter((a) => a === "--video-references")).toHaveLength(1);
  });

  it("falls back to a lone start frame on start-only models and fails loudly with extra refs", async () => {
    const seen: string[][] = [];
    const jobId = "23232323-4545-6767-8989-010101010101";
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
      // veo3 declares only the legacy `image` slot: a single source frame
      // rides it alone (nothing to mix), with no reference flags at all.
      await provider(run).generateVideoClip(prodDir("prod-veo-single"), shot(), {
        model: `${HIGGSFIELD_CLI_ID_PREFIX}veo3`, resolution: "", durationSec: 5, prompt: "animate",
        refsOnly: true,
      }, () => {});
      const args = seen[0];
      expect(args).toContain("--image");
      expect(args).not.toContain("--image-references");
      expect(args).not.toContain("--start-image");
      // Extra references have no array to ride — fail before submitting
      // instead of mixing them beside the start slot.
      await expect(
        provider(run).generateVideoClip(prodDir("prod-veo-extra"), shot(), {
          model: `${HIGGSFIELD_CLI_ID_PREFIX}veo3`, resolution: "", durationSec: 5, prompt: "animate",
          refsOnly: true,
        }, () => {}, undefined, [{ name: "Extra", dataUrl: "data:image/png;base64,RXh0cmE=" }])
      ).rejects.toThrow(/no reference array/);
      expect(seen).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("routes video refs at native resolution into --video-references", async () => {
    const seen: string[][] = [];
    let videoBytes: Buffer | null = null;
    const jobId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const { run } = fakeRun(
      baseHandler({
        "generate create seedance_2_0": (args) => {
          seen.push(args);
          const at = args.indexOf("--video-references");
          if (at >= 0) videoBytes = fs.readFileSync(args[at + 1]);
          return ok(JSON.stringify({ job_id: jobId }));
        },
        [`generate wait ${jobId}`]: () =>
          ok(JSON.stringify([{ id: jobId, status: "succeeded", video_url: "https://example.invalid/clip.mp4" }])),
      })
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([7, 7]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      await provider(run).generateVideoClip(prodDir("prod-vidref"), shot(), {
        model: `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`, resolution: "720p", durationSec: 8, prompt: "animate",
      }, () => {}, undefined, [{ name: "Clip", dataUrl: "data:video/mp4;base64,AAAA" }]);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen[0]).toContain("--video-references");
    // The temp file handed to the CLI is the source clip bytes untouched —
    // no submit-time downscale/transcode (720p copies are user-approved).
    expect(videoBytes).not.toBeNull();
    expect(videoBytes!.equals(Buffer.from("AAAA", "base64"))).toBe(true);
  });

  it("submits every frame as a reference with refsOnly (no start/end slots — the sequence canvas)", async () => {
    const seen: string[][] = [];
    const jobId = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
    const { run } = fakeRun(
      baseHandler({
        "generate create seedance_2_0": (args) => {
          seen.push(args);
          return ok(JSON.stringify({ job_id: jobId }));
        },
        [`generate wait ${jobId}`]: () =>
          ok(JSON.stringify([{ id: jobId, status: "succeeded", video_url: "https://example.invalid/clip.mp4" }])),
      })
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([7, 7]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      await provider(run).generateVideoClip(prodDir("prod-refsonly"), shot(), {
        model: `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`, resolution: "720p", durationSec: 8, prompt: "animate",
        refsOnly: true,
      }, () => {}, undefined, [{ name: "Extra", dataUrl: "data:image/png;base64,RXh0cmE=" }]);
    } finally {
      globalThis.fetch = realFetch;
    }
    const args = seen[0];
    // No frame slot — both the source frame and the extra ride the array.
    expect(args).not.toContain("--start-image");
    expect(args).not.toContain("--end-image");
    expect(args).not.toContain("--image");
    const imgRefs = args.filter((a) => a === "--image-references").length;
    expect(imgRefs).toBe(2);
  });
});

describe("HiggsfieldCliProvider.modelOptions (schema normalization)", () => {
  it("normalizes gpt_image_2_5's full parameter surface", async () => {
    const { run } = fakeRun(baseHandler());
    const s = await provider(run).modelOptions(`${HIGGSFIELD_CLI_ID_PREFIX}gpt_image_2_5`);
    expect(s).not.toBeNull();
    expect(s!.jobType).toBe("gpt_image_2_5");
    const byName = (n: string) => s!.fields.find((f) => f.flag === n || f.name === n)!;
    const quality = byName("quality");
    expect(quality.kind).toBe("enum");
    expect(quality.values).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(quality.default).toBe("low");
    expect(byName("resolution").default).toBe("1k");
    expect(byName("resolution").values).toEqual(["1k", "2k", "4k"]);
    expect(byName("variant").values).toEqual(["flare", "sunburst"]);
    expect(byName("aspect_ratio").values).toContain("auto");
    expect(byName("background").group).toBe("control");
    const refs = byName("image_references");
    expect(refs.group).toBe("reference");
    expect(refs.maxItems).toBe(16);
    expect(byName("seed").kind).toBe("integer");
    expect(byName("seed").group).toBe("advanced");
    expect(s!.fields.some((f) => f.name === "prompt")).toBe(false);
  });

  it("caches the schema and returns null for foreign/unknown ids", async () => {
    const { run, calls } = fakeRun(baseHandler());
    const p = provider(run);
    await p.modelOptions(`${HIGGSFIELD_CLI_ID_PREFIX}gpt_image_2_5`);
    await p.modelOptions(`${HIGGSFIELD_CLI_ID_PREFIX}gpt_image_2_5`);
    expect(calls.filter((a) => a[0] === "model" && a[1] === "get").length).toBe(1);
    expect(await p.modelOptions("openart:foo")).toBeNull();
    expect(await p.modelOptions("auto")).toBeNull();
    expect(await p.modelOptions(`${HIGGSFIELD_CLI_ID_PREFIX}nope`)).toBeNull();
  });
});

describe("emitSchemaField", () => {
  const enumField = { name: "quality", flag: "quality", aliases: [], kind: "enum" as const, group: "core" as const, values: ["low", "high"], emit: "value" as const, source: "parameters" as const };
  it("matches enum values case-insensitively and rejects unlisted ones", () => {
    const args: string[] = [];
    expect(emitSchemaField(enumField, "HIGH", args)).toBe(true);
    expect(args).toEqual(["--quality", "high"]);
    expect(emitSchemaField(enumField, "nope", [])).toBe(false);
  });
  it("clamps integers to min/max", () => {
    const seed = { name: "seed", flag: "seed", aliases: [], kind: "integer" as const, group: "advanced" as const, min: 0, max: 100, emit: "value" as const, source: "parameters" as const };
    const args: string[] = [];
    emitSchemaField(seed, 999, args);
    expect(args).toEqual(["--seed", "100"]);
  });
  it("emits booleans explicitly and repeats arrays up to maxItems", () => {
    const bool = { name: "enhance_prompt", flag: "enhance_prompt", aliases: [], kind: "boolean" as const, group: "advanced" as const, emit: "boolean-flag" as const, source: "parameters" as const };
    const args: string[] = [];
    emitSchemaField(bool, true, args);
    emitSchemaField(bool, "false", args);
    expect(args).toEqual(["--enhance_prompt", "true", "--enhance_prompt", "false"]);
    const arr = { name: "image_references", flag: "image-references", aliases: [], kind: "array" as const, group: "reference" as const, maxItems: 2, emit: "repeat" as const, source: "parameters" as const };
    const a2: string[] = [];
    emitSchemaField(arr, ["a", "b", "c"], a2);
    expect(a2).toEqual(["--image-references", "a", "--image-references", "b"]);
  });
});

describe("HiggsfieldCliProvider schema-driven arg emission", () => {
  it("emits board params (variant/background/seed) for gpt_image_2_5", async () => {
    const seen: string[][] = [];
    const jobId = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
    const { run } = fakeRun(
      baseHandler({
        "generate create gpt_image_2_5": (args) => {
          seen.push(args.slice(2));
          return ok(JSON.stringify({ job_id: jobId }));
        },
        [`generate wait ${jobId}`]: () =>
          ok(JSON.stringify([{ id: jobId, status: "completed", image_url: "https://example.invalid/g.png" }])),
      })
    );
    const p = provider(run);
    const gen = p.imageGenFn(
      makeProduction({
        openArt: {
          model: `${HIGGSFIELD_CLI_ID_PREFIX}gpt_image_2_5`,
          resolution: "2k",
          quality: "high",
          params: { quality: "high", resolution: "2k", variant: "sunburst", aspect_ratio: "16:9", background: "auto", seed: 999 },
        },
      })
    )!;
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([4]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      await gen("A castle", []);
    } finally {
      globalThis.fetch = realFetch;
    }
    const args = seen[0];
    expect(args[args.indexOf("--quality") + 1]).toBe("high");
    expect(args[args.indexOf("--resolution") + 1]).toBe("2k");
    expect(args[args.indexOf("--variant") + 1]).toBe("sunburst");
    expect(args[args.indexOf("--aspect_ratio") + 1]).toBe("16:9");
    expect(args[args.indexOf("--background") + 1]).toBe("auto");
    expect(args[args.indexOf("--seed") + 1]).toBe("999");
  });

  it("honors an explicit mode over the seedance omni_reference special case", async () => {
    const seen: string[][] = [];
    const jobId = "88888888-9999-aaaa-bbbb-cccccccccccc";
    const { run } = fakeRun(
      baseHandler({
        "generate create seedance_2_5": (args) => {
          seen.push(args);
          return ok(JSON.stringify([jobId]));
        },
        [`generate wait ${jobId}`]: () =>
          ok(JSON.stringify([{ id: jobId, status: "completed", video_url: "https://example.invalid/m.mp4" }])),
      })
    );
    const p = provider(run);
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([5]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    const prod = makeProduction({
      meta: { id: "prod-1", name: "T", folder: path.join(dataDir, "prod-mode"), createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    });
    fs.mkdirSync(path.join(prod.meta.folder, "boards"), { recursive: true });
    fs.mkdirSync(path.join(prod.meta.folder, "videos"), { recursive: true });
    fs.writeFileSync(path.join(prod.meta.folder, "boards", "shot-0100.jpg"), Buffer.from("jpeg"));
    const shot: ProductionShot = { id: "s1", number: "0100", audio: "", visual: "", artwork: "boards/shot-0100.jpg" };
    try {
      await p.generateVideoClip(prod, shot, {
        model: `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_5`, resolution: "1080p", durationSec: 8, prompt: "animate",
        params: { mode: "t2v" },
      }, () => {});
    } finally {
      globalThis.fetch = realFetch;
    }
    const args = seen[0];
    expect(args.filter((a) => a === "--mode")).toHaveLength(1);
    expect(args[args.indexOf("--mode") + 1]).toBe("t2v");
  });
});

describe("parseCostCredits / costCacheKey", () => {
  it("reads the flat live shape and keeps fractions", () => {
    expect(parseCostCredits(JSON.stringify({ credits: 32.5 }))).toBe(32.5);
    expect(parseCostCredits(JSON.stringify({ credits: 1 }))).toBe(1);
  });

  it("tolerates envelope spellings and numeric strings", () => {
    expect(parseCostCredits(JSON.stringify({ data: { total_credits: 12 } }))).toBe(12);
    expect(parseCostCredits(JSON.stringify({ cost: "7.25" }))).toBe(7.25);
    expect(parseCostCredits(JSON.stringify([{ price: 3 }]))).toBe(3);
  });

  it("returns null when no credit field parses", () => {
    expect(parseCostCredits("not json")).toBeNull();
    expect(parseCostCredits(JSON.stringify({ status: "ok" }))).toBeNull();
    expect(parseCostCredits(JSON.stringify({ credits: -1 }))).toBeNull();
  });

  it("keys stably regardless of params order", () => {
    const a = costCacheKey({ model: "higgsfield-cli:seedance_2_5", kind: "video", params: { mode: "t2v", seed: 1 } });
    const b = costCacheKey({ model: "higgsfield-cli:seedance_2_5", kind: "video", params: { seed: 1, mode: "t2v" } });
    expect(a).toBe(b);
    expect(costCacheKey({ model: "higgsfield-cli:seedance_2_5", kind: "video", durationSec: 5 })).not.toBe(
      costCacheKey({ model: "higgsfield-cli:seedance_2_5", kind: "video", durationSec: 10 })
    );
  });
});

describe("HiggsfieldCliProvider.getGenerationCost", () => {
  it("quotes a video config through generate cost (no job submitted)", async () => {
    const seen: string[][] = [];
    const { run, calls } = fakeRun(
      baseHandler({
        "generate cost seedance_2_0": (args) => {
          seen.push(args);
          return ok(JSON.stringify({ credits: 32.5 }));
        },
      })
    );
    const p = provider(run);
    const cost = await p.getGenerationCost({
      model: `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`, kind: "video",
      resolution: "720p", durationSec: 5, aspectRatio: "16:9",
    });
    expect(cost).toBe(32.5);
    // Preflight argv mirrors the submit path (no --wait, no media flags).
    const args = seen[0];
    expect(args.slice(0, 3)).toEqual(["generate", "cost", "seedance_2_0"]);
    expect(args).not.toContain("--wait");
    expect(args).not.toContain("--start-image");
    expect(args[args.indexOf("--prompt") + 1]).toBe("cost probe");
    expect(args[args.indexOf("--duration") + 1]).toBe("5");
    expect(args[args.indexOf("--resolution") + 1]).toBe("720p");
    // Second call serves the cache — no new spawn.
    expect(await p.getGenerationCost({
      model: `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`, kind: "video",
      resolution: "720p", durationSec: 5, aspectRatio: "16:9",
    })).toBe(32.5);
    expect(calls.filter((a) => a[0] === "generate" && a[1] === "cost").length).toBe(1);
  });

  it("quotes an image config without --duration and passes schema extras", async () => {
    const seen: string[][] = [];
    const { run } = fakeRun(
      baseHandler({
        "generate cost gpt_image_2_5": (args) => {
          seen.push(args);
          return ok(JSON.stringify({ credits: 1 }));
        },
      })
    );
    const cost = await provider(run).getGenerationCost({
      model: "gpt_image_2_5", kind: "image", resolution: "2k",
      aspectRatio: "16:9", quality: "high", params: { variant: "sunburst" },
    });
    expect(cost).toBe(1);
    const args = seen[0];
    expect(args).not.toContain("--duration");
    expect(args[args.indexOf("--resolution") + 1]).toBe("2k");
    expect(args[args.indexOf("--quality") + 1]).toBe("high");
    expect(args[args.indexOf("--variant") + 1]).toBe("sunburst");
  });

  it("resolves null without spawning for foreign/auto ids, and null on CLI failure", async () => {
    const { run, calls } = fakeRun(baseHandler({
      "generate cost kling3_0": () => fail("boom"),
    }));
    const p = provider(run);
    expect(await p.getGenerationCost({ model: "openart:foo", kind: "video" })).toBeNull();
    expect(await p.getGenerationCost({ model: "auto", kind: "video" })).toBeNull();
    expect(await p.getGenerationCost({ model: `${HIGGSFIELD_CLI_ID_PREFIX}kling3_0`, kind: "video", durationSec: 5 })).toBeNull();
    expect(await p.getGenerationCost({ model: `${HIGGSFIELD_CLI_ID_PREFIX}nope`, kind: "image" })).toBeNull();
    expect(calls.filter((a) => a[0] === "generate" && a[1] === "cost").length).toBe(2);
  });

  it("retries a media-requiring mode with a placeholder start frame", async () => {
    // Regression: a per-surface/shot `mode` like `omni_reference` can't be
    // priced without media, so the quote silently vanished. The submit always
    // carries a source frame, so the probe retries once with a placeholder
    // bound to the model's start-image slot; refs don't move the price.
    const costCalls: string[][] = [];
    let first = true;
    const { run } = fakeRun((args) => {
      if (args[0] === "generate" && args[1] === "cost") {
        costCalls.push(args);
        if (first) {
          first = false;
          return fail("mode 'omni_reference' requires at least one reference media item");
        }
        return ok(JSON.stringify({ credits: 60 }));
      }
      return baseHandler()(args);
    });
    const p = provider(run);
    const cost = await p.getGenerationCost({
      model: `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_5`, kind: "video",
      resolution: "1080p", durationSec: 5, aspectRatio: "16:9",
      params: { mode: "omni_reference", bitrate_mode: "high" },
    });
    expect(cost).toBe(60);
    expect(costCalls.length).toBe(2);
    expect(costCalls[0]).not.toContain("--start-image");
    const retry = costCalls[1];
    expect(retry).toContain("--start-image");
    // The placeholder temp file is cleaned up after the retry.
    expect(fs.existsSync(retry[retry.indexOf("--start-image") + 1])).toBe(false);
  });
});

describe("submit-time credit quotes", () => {
  it("prefers a per-surface params quality over the production default (submit + quote)", async () => {
    // Regression: node/ref option forms render quality, but the submit used
    // to skip it as an "owned" flag and bill the storyboard default — the
    // node control was dead and its quote mirrored master. Nearest pick wins.
    const costSeen: string[][] = [];
    const createSeen: string[][] = [];
    const jobId = "56565656-7777-8888-9999-000000000000";
    const { run } = fakeRun(
      baseHandler({
        "generate cost gpt_image_2_5": (args) => {
          costSeen.push(args);
          return ok(JSON.stringify({ credits: 2 }));
        },
        "generate create gpt_image_2_5": (args) => {
          createSeen.push(args);
          return ok(JSON.stringify([jobId]));
        },
        [`generate wait ${jobId}`]: () =>
          ok(JSON.stringify([{ id: jobId, status: "completed", image_url: "https://example.invalid/q2.png" }])),
      })
    );
    const onGeneration = vi.fn();
    const p = new HiggsfieldCliProvider({ binary: () => "higgsfield", run, recorder: { onGeneration } });
    const gen = p.imageGenFn(makeProduction({
      openArt: { model: `${HIGGSFIELD_CLI_ID_PREFIX}gpt_image_2_5`, resolution: "1k", quality: "low" },
    }))!;
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([6]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      await gen("A castle", [], undefined, { quality: "high" });
    } finally {
      globalThis.fetch = realFetch;
    }
    // Both the submit and its ledger quote carry the node's pick, not master.
    expect(createSeen[0][createSeen[0].indexOf("--quality") + 1]).toBe("high");
    expect(costSeen[0][costSeen[0].indexOf("--quality") + 1]).toBe("high");
    expect(onGeneration).toHaveBeenCalledWith(expect.objectContaining({ credits: 2 }));
    // And the quote API itself prefers params.quality over top-level quality.
    expect(await p.getGenerationCost({
      model: `${HIGGSFIELD_CLI_ID_PREFIX}gpt_image_2_5`, kind: "image",
      resolution: "1k", aspectRatio: "16:9", quality: "low", params: { quality: "max" },
    })).not.toBeNull();
    const maxProbe = costSeen[costSeen.length - 1];
    expect(maxProbe[maxProbe.indexOf("--quality") + 1]).toBe("max");
  });
  it("attaches the image quote to the ledger meta (absent when unreadable)", async () => {
    const jobId = "12121212-3333-4444-5555-666666666666";
    const { run } = fakeRun(
      baseHandler({
        "generate cost gpt_image_2_5": () => ok(JSON.stringify({ credits: 2 })),
        "generate create gpt_image_2_5": () => ok(JSON.stringify([jobId])),
        [`generate wait ${jobId}`]: () =>
          ok(JSON.stringify([{ id: jobId, status: "completed", image_url: "https://example.invalid/q.png" }])),
      })
    );
    const onGeneration = vi.fn();
    const p = new HiggsfieldCliProvider({ binary: () => "higgsfield", run, recorder: { onGeneration } });
    const gen = p.imageGenFn(makeProduction({
      openArt: { model: `${HIGGSFIELD_CLI_ID_PREFIX}gpt_image_2_5`, resolution: "1k", quality: "high" },
    }))!;
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([3]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      await gen("A castle", []);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(onGeneration).toHaveBeenCalledWith(expect.objectContaining({ credits: 2 }));
  });

  it("attaches the video quote to the ledger meta", async () => {
    const jobId = "34343434-5555-6666-7777-888888888888";
    const { run } = fakeRun(
      baseHandler({
        "generate cost seedance_2_0": () => ok(JSON.stringify({ credits: 65 })),
        "generate create seedance_2_0": () => ok(JSON.stringify({ job_id: jobId })),
        [`generate wait ${jobId}`]: () =>
          ok(JSON.stringify([{ id: jobId, status: "completed", video_url: "https://example.invalid/q.mp4" }])),
      })
    );
    const onGeneration = vi.fn();
    const p = new HiggsfieldCliProvider({ binary: () => "higgsfield", run, recorder: { onGeneration } });
    const folder = path.join(dataDir, "prod-q");
    fs.mkdirSync(path.join(folder, "boards"), { recursive: true });
    fs.mkdirSync(path.join(folder, "videos"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards", "shot-0100.jpg"), Buffer.from("jpeg"));
    const prod = makeProduction({
      meta: { id: "prod-1", name: "T", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([4]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      await p.generateVideoClip(
        prod,
        { id: "s1", number: "0100", audio: "", visual: "", artwork: "boards/shot-0100.jpg" },
        { model: `${HIGGSFIELD_CLI_ID_PREFIX}seedance_2_0`, resolution: "720p", durationSec: 10, prompt: "animate" },
        () => {}
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(onGeneration).toHaveBeenCalledWith(expect.objectContaining({ credits: 65, durationSec: 10 }));
  });
});
