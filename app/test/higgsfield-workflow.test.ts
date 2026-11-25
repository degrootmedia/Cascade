/**
 * Higgsfield workflow support tests — discovery, cost, submit, landing,
 * pending/recheck, all against a fake CLI runner.
 *
 * Fixtures are the live v1.1.25 shapes (probed 2026-11-12): `workflow
 * list --json` -> `[{display_name, job_type, type}]`; `workflow get`
 * -> `{cost_params, params, rules, type}`; `generate cost workflow`
 * accepts ONLY cost_params (media fails with "Model does not accept
 * media inputs.", other params with "Unknown params") while
 * `generate workflow` takes `--image-references <path>` normally.
 * fetch is stubbed for result downloads; scripting.js is mocked so
 * pipeline.ts loads in a plain node process (same seams as
 * higgsfield-cli.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  HiggsfieldCliProvider,
  HiggsfieldCliPendingError,
  HIGGSFIELD_CLI_WORKFLOW_ID_PREFIX,
  isHiggsfieldWorkflowId,
  higgsfieldWorkflowName,
  shapeHiggsfieldWorkflowChoices,
  parseWorkflowDetail,
  planWorkflowMedia,
  workflowCostCacheKey,
  workflowResultAssets,
  type CliRun,
  type CliRunResult,
} from "../src/main/providers/higgsfield-cli.js";
import { mediaRegistryOf } from "../src/shared/media-registry.js";
import type { LedgerGenMeta, PendingWorkflowGen, Production } from "../src/shared/ipc.js";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-higgs-wf-${process.pid}-${Date.now()}` };
});

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

type Handler = (args: string[]) => CliRunResult | Promise<CliRunResult>;

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

const JOB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const WORKFLOW_LIST = JSON.stringify([
  { display_name: "Image Decompose", job_type: "image_decompose", type: "image" },
  { display_name: "Reframe", job_type: "reframe", type: "video" },
  { display_name: "dubbing", job_type: "dubbing", type: "video" },
]);

const decomposeGet = () =>
  JSON.stringify({
    cost_params: [],
    display_name: "Image Decompose",
    job_type: "image_decompose",
    params: [
      { name: "folder_id", type: "string|null", default: null, required: false },
      { name: "image_references", type: "array", default: null, required: false },
      { name: "mode", type: "string", default: "granular", required: false, enum: ["granular", "standard"] },
    ],
    rules: [{ cel: "size(params.image_references) == 1", message: "exactly one image_references entry is required" }],
    type: "image",
  });

const reframeGet = () =>
  JSON.stringify({
    cost_params: [
      { name: "duration", type: "number|null", default: null, required: false },
      { name: "resolution", type: "string", default: "720p", required: false, enum: ["480p", "720p", "1080p"] },
    ],
    display_name: "Reframe",
    job_type: "reframe",
    params: [
      { name: "aspect_ratio", type: "string", default: null, required: true, enum: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] },
      { name: "duration", type: "number|null", default: null, required: false },
      { name: "image_references", type: "array", default: null, required: false },
      { name: "resolution", type: "string", default: "720p", required: false, enum: ["480p", "720p", "1080p"] },
      { name: "start_image", type: "object|null", default: null, required: false },
      { name: "video_references", type: "array", default: null, required: false },
    ],
    rules: [{ cel: "size(params.video_references) == 1", message: "exactly one video_references entry is required" }],
    type: "video",
  });

const dubbingGet = () =>
  JSON.stringify({
    cost_params: [{ name: "duration", type: "number", default: null, required: true }],
    display_name: "dubbing",
    job_type: "dubbing",
    params: [
      { name: "folder_id", type: "string|null", default: null, required: false },
      { name: "input_video", type: "object", default: null, required: true },
      { name: "target_language", type: "string", default: null, required: true, enum: ["eng", "deu"] },
    ],
    rules: [],
    type: "video",
  });

function baseHandler(extra: Record<string, Handler> = {}): Handler {
  return (args) => {
    const verb = args.slice(0, 2).join(" ");
    const key = `${verb} ${args[2] ?? ""}`.trim();
    if (extra[key]) return extra[key](args);
    if (verb === "workflow list") return ok(WORKFLOW_LIST);
    if (verb === "workflow get") {
      if (args[2] === "image_decompose") return ok(decomposeGet());
      if (args[2] === "reframe") return ok(reframeGet());
      if (args[2] === "dubbing") return ok(dubbingGet());
      return fail(`Unknown workflow: ${args[2]}`);
    }
    if (verb === "generate cost") return ok(JSON.stringify({ credits: 2 }));
    if (verb === "model list") {
      if (args.includes("--image")) return ok(JSON.stringify([{ job_type: "gpt_image_2_5", name: "GPT Image 2.5" }]));
      if (args.includes("--video")) return ok(JSON.stringify([{ job_type: "seedance_2_5", name: "Seedance 2.5" }]));
    }
    throw new Error(`No fake handler for higgs args "${args.join(" ")}"`);
  };
}

function provider(run: CliRun, tapes?: LedgerGenMeta[]): HiggsfieldCliProvider {
  return new HiggsfieldCliProvider({
    binary: () => "higgsfield",
    run,
    recorder: tapes ? { onGeneration: (m) => tapes.push(m) } : undefined,
  });
}

function makeProduction(overrides: Partial<Production> = {}): Production {
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    meta: { id: "prod-1", name: "Test Production", folder: dataDir, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
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
  } as Production;
}

const pngRef = (name: string) => ({
  name,
  dataUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
});

function stubFetch(bytes: Buffer): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---- ids + pure shaping ------------------------------------------------------

describe("workflow ids", () => {
  it("namespace, detect, and strip workflow ids without touching model ids", () => {
    expect(HIGGSFIELD_CLI_WORKFLOW_ID_PREFIX).toBe("higgsfield-cli:workflow:");
    expect(isHiggsfieldWorkflowId("higgsfield-cli:workflow:image_decompose")).toBe(true);
    expect(isHiggsfieldWorkflowId("higgsfield-cli:seedance_2_5")).toBe(false);
    expect(higgsfieldWorkflowName("higgsfield-cli:workflow:image_decompose")).toBe("image_decompose");
    expect(higgsfieldWorkflowName("image_decompose")).toBe("image_decompose");
    expect(higgsfieldWorkflowName("higgsfield-cli:seedance_2_5")).toBe("");
    expect(higgsfieldWorkflowName("openart-cli:x")).toBe("");
  });

  it("shapes workflow list items into namespaced choices", () => {
    const choices = shapeHiggsfieldWorkflowChoices(JSON.parse(WORKFLOW_LIST));
    expect(choices).toEqual([
      { id: "higgsfield-cli:workflow:image_decompose", jobType: "image_decompose", displayName: "Image Decompose", type: "image" },
      { id: "higgsfield-cli:workflow:reframe", jobType: "reframe", displayName: "Reframe", type: "video" },
      { id: "higgsfield-cli:workflow:dubbing", jobType: "dubbing", displayName: "dubbing", type: "video" },
    ]);
    expect(shapeHiggsfieldWorkflowChoices([{ display_name: "No Id" }])).toEqual([]);
  });

  it("parses workflow get replies (params, cost_params, type)", () => {
    const dec = parseWorkflowDetail(decomposeGet());
    expect(dec?.type).toBe("image");
    expect(dec?.costParamNames).toEqual([]);
    const mode = dec?.detail.params.get("mode");
    expect(mode?.values).toEqual(["granular", "standard"]);
    expect(mode?.default).toBe("granular");
    const ref = parseWorkflowDetail(reframeGet());
    expect(ref?.type).toBe("video");
    expect(ref?.costParamNames).toEqual(["duration", "resolution"]);
    expect(parseWorkflowDetail("not json")).toBeNull();
  });

  it("builds stable workflow cost cache keys", () => {
    expect(workflowCostCacheKey("image_decompose")).toBe("workflow|image_decompose");
    expect(workflowCostCacheKey("reframe", { resolution: "1080p", duration: 7 }))
      .toBe(workflowCostCacheKey("reframe", { duration: 7, resolution: "1080p" }));
  });
});

// ---- discovery + options ------------------------------------------------------

describe("HiggsfieldCliProvider workflow discovery", () => {
  it("lists workflows once (cached) and normalizes workflow options", async () => {
    const { run, calls } = fakeRun(baseHandler());
    const p = provider(run);
    const choices = await p.listWorkflowChoices();
    expect(choices.map((c) => c.id)).toEqual([
      "higgsfield-cli:workflow:image_decompose",
      "higgsfield-cli:workflow:reframe",
      "higgsfield-cli:workflow:dubbing",
    ]);
    await p.listWorkflowChoices();
    expect(calls.filter((c) => c.slice(0, 2).join(" ") === "workflow list")).toHaveLength(1);

    const schema = await p.workflowOptions("higgsfield-cli:workflow:image_decompose");
    const mode = schema?.fields.find((f) => f.flag === "mode");
    expect(mode?.values).toEqual(["granular", "standard"]);
    expect(mode?.default).toBe("granular");
    expect(await p.workflowOptions("higgsfield-cli:seedance_2_5")).toBeNull();
    expect(await p.workflowOptions("nope_workflow")).toBeNull();
  });
});

// ---- cost ---------------------------------------------------------------------

describe("HiggsfieldCliProvider.getWorkflowCost", () => {
  it("quotes decompose bare: non-cost params never reach the cost form", async () => {
    const { run, calls } = fakeRun(baseHandler());
    const p = provider(run);
    const cost = await p.getWorkflowCost({
      workflow: "higgsfield-cli:workflow:image_decompose",
      params: { mode: "standard" },
    });
    expect(cost).toBe(2);
    const costCall = calls.find((c) => c.slice(0, 2).join(" ") === "generate cost");
    expect(costCall).toEqual(["generate", "cost", "workflow", "image_decompose", "--json", "--no-color"]);
  });

  it("emits declared cost params only (reframe resolution in, aspect_ratio out)", async () => {
    const { run, calls } = fakeRun(baseHandler());
    const p = provider(run);
    await p.getWorkflowCost({ workflow: "reframe", params: { resolution: "1080p", aspect_ratio: "9:16" } });
    const costCall = calls.find((c) => c.slice(0, 2).join(" ") === "generate cost");
    expect(costCall).toContain("--resolution");
    expect(costCall).toContain("1080p");
    expect(costCall).not.toContain("--aspect_ratio");
    expect(costCall).not.toContain("9:16");
  });

  it("resolves null for foreign or model ids without spawning cost", async () => {
    const { run, calls } = fakeRun(baseHandler());
    const p = provider(run);
    expect(await p.getWorkflowCost({ workflow: "openart-cli:x" })).toBeNull();
    expect(calls.filter((c) => c.slice(0, 2).join(" ") === "generate cost")).toHaveLength(0);
  });
});

// ---- media planning ------------------------------------------------------------

describe("planWorkflowMedia", () => {
  it("routes the refs shorthand onto declared reference params", () => {
    const dec = parseWorkflowDetail(decomposeGet());
    expect(dec).not.toBeNull();
    const plan = planWorkflowMedia("image_decompose", dec!.detail, { refs: [pngRef("Source.png")] });
    expect(plan).toHaveLength(1);
    expect(plan[0].flag).toBe("image_references");
    expect(plan[0].kind).toBe("array");
  });

  it("accepts explicit object-slot media and rejects bad keys before submit", () => {
    const dub = parseWorkflowDetail(dubbingGet());
    const videoRef = { name: "Clip.mp4", dataUrl: "data:video/mp4;base64,AAAA" };
    const plan = planWorkflowMedia("dubbing", dub!.detail, { media: { input_video: videoRef } });
    expect(plan[0].flag).toBe("input_video");
    expect(plan[0].kind).toBe("single");
    expect(() => planWorkflowMedia("dubbing", dub!.detail, { media: { bogus: videoRef } })).toThrow(/no parameter/);
    expect(() => planWorkflowMedia("dubbing", dub!.detail, { media: { target_language: videoRef } })).toThrow(/isn't a media parameter/);
    expect(() => planWorkflowMedia("dubbing", dub!.detail, { media: { input_video: [videoRef, videoRef] } })).toThrow(/takes one file/);
    expect(() => planWorkflowMedia("dubbing", dub!.detail, { refs: [pngRef("x.png")] })).toThrow(/no image input/);
  });
});

// ---- generation -----------------------------------------------------------------

describe("HiggsfieldCliProvider.generateWorkflow", () => {
  it("submits image_decompose, lands every output registered, and bills what was sent", async () => {
    const urls = [
      "https://cdn.example.com/layer-bg.png",
      "https://cdn.example.com/layer-product.png",
      "https://cdn.example.com/layer-text.png",
    ];
    const { run, calls } = fakeRun(
      baseHandler({
        [`generate workflow image_decompose`]: () => ok(JSON.stringify({ job_id: JOB })),
        [`generate wait ${JOB}`]: () =>
          ok(JSON.stringify([{ status: "completed", result_urls: urls }])),
      })
    );
    const tapes: LedgerGenMeta[] = [];
    const p = provider(run, tapes);
    const prod = makeProduction();
    const pending: (PendingWorkflowGen | null)[] = [];
    const restore = stubFetch(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    try {
      const result = await p.generateWorkflow(
        prod,
        {
          workflow: "higgsfield-cli:workflow:image_decompose",
          params: { mode: "granular" },
          refs: [pngRef("Source.png")],
          shotId: "shot-9",
          onPending: (r) => pending.push(r),
        },
        () => {}
      );
      expect(result.jobId).toBe(JOB);
      expect(result.kind).toBe("image");
      expect(result.resultUrls).toEqual(urls);
      expect(result.files.map((f) => f.rel)).toEqual([
        "out/workflows/image_decompose/aaaaaaaa/image_decompose-01.png",
        "out/workflows/image_decompose/aaaaaaaa/image_decompose-02.png",
        "out/workflows/image_decompose/aaaaaaaa/image_decompose-03.png",
      ]);
      for (const f of result.files) {
        expect(fs.existsSync(path.join(dataDir, f.rel))).toBe(true);
        expect(f.ext).toBe("png");
      }
      expect(mediaRegistryOf(prod).map((e) => e.path).sort()).toEqual(result.files.map((f) => f.rel).sort());
    } finally {
      restore();
    }
    const submit = calls.find((c) => c.slice(0, 2).join(" ") === "generate workflow");
    expect(submit?.slice(0, 3)).toEqual(["generate", "workflow", "image_decompose"]);
    const modeAt = submit?.indexOf("--mode") ?? -1;
    expect(submit?.[modeAt + 1]).toBe("granular");
    const refAt = submit?.indexOf("--image_references") ?? -1;
    expect(refAt).toBeGreaterThan(-1);
    expect(submit?.[refAt + 1]).toMatch(/\.png$/);
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({
      historyId: JOB,
      workflow: "higgsfield-cli:workflow:image_decompose",
      kind: "image",
      params: { mode: "granular" },
      shotId: "shot-9",
    });
    expect(pending[1]).toBeNull();
    expect(tapes).toHaveLength(1);
    expect(tapes[0]).toMatchObject({
      kind: "image",
      model: "higgsfield-cli:workflow:image_decompose",
      params: { mode: "granular" },
      credits: 2,
      productionId: "prod-1",
      shotId: "shot-9",
    });
  });

  it("rejects an invalid enum before submitting anything", async () => {
    const { run, calls } = fakeRun(baseHandler());
    const p = provider(run);
    await expect(
      p.generateWorkflow(
        makeProduction(),
        { workflow: "image_decompose", params: { mode: "ultra" }, refs: [pngRef("Source.png")] },
        () => {}
      )
    ).rejects.toThrow(/"mode" value "ultra" isn't valid/);
    expect(calls.filter((c) => c.slice(0, 2).join(" ") === "generate workflow")).toHaveLength(0);
  });

  it("keeps the pending record when the finished output can't be downloaded", async () => {
    const { run } = fakeRun(
      baseHandler({
        [`generate workflow image_decompose`]: () => ok(JSON.stringify({ job_id: JOB })),
        [`generate wait ${JOB}`]: () =>
          ok(JSON.stringify([{ status: "completed", result_urls: ["https://cdn.example.com/layer-1.png"] }])),
      })
    );
    const p = provider(run);
    const pending: (PendingWorkflowGen | null)[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    try {
      await expect(
        p.generateWorkflow(
          makeProduction(),
          { workflow: "image_decompose", refs: [pngRef("Source.png")], onPending: (r) => pending.push(r) },
          () => {}
        )
      ).rejects.toBeInstanceOf(HiggsfieldCliPendingError);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(pending).toHaveLength(1);
    expect(pending[0]?.historyId).toBe(JOB);
  });
});

// ---- recheck + model-path guards -------------------------------------------------

describe("HiggsfieldCliProvider.recheckWorkflow + model-path guards", () => {
  it("fetches finished workflow outputs, null while running, throws when dead", async () => {
    let getReply = "";
    const { run } = fakeRun(
      baseHandler({
        [`generate get ${JOB}`]: () => ok(getReply),
      })
    );
    const p = provider(run);
    const rec: PendingWorkflowGen = {
      historyId: JOB,
      workflow: "higgsfield-cli:workflow:image_decompose",
      kind: "image",
      at: new Date().toISOString(),
    };
    getReply = JSON.stringify([{ status: "in_progress" }]);
    expect(await p.recheckWorkflow(rec)).toBeNull();
    getReply = JSON.stringify([{ status: "failed", error: "bad input" }]);
    await expect(p.recheckWorkflow(rec)).rejects.toThrow(/failed/);
    getReply = JSON.stringify([
      { status: "completed", result_urls: ["https://cdn.example.com/a.png", "https://cdn.example.com/b.png"] },
    ]);
    const restore = stubFetch(Buffer.from([9, 8, 7]));
    try {
      const got = await p.recheckWorkflow(rec);
      expect(got?.jobId).toBe(JOB);
      expect(got?.files).toHaveLength(2);
      expect(got?.files[0].ext).toBe("png");
    } finally {
      restore();
    }
  });

  it("keeps workflow ids out of the model cost/option/submit paths", async () => {
    const { run } = fakeRun(baseHandler());
    const p = provider(run);
    expect(await p.getGenerationCost({ model: "higgsfield-cli:workflow:image_decompose", kind: "image" })).toBeNull();
    expect(await p.modelOptions("higgsfield-cli:workflow:image_decompose")).toBeNull();
    const fn = p.imageGenFn(makeProduction(), "higgsfield-cli:workflow:image_decompose");
    expect(fn).not.toBeNull();
    await expect(fn!("a prompt", [])).rejects.toThrow(/is a workflow, not an image model/);
  });
});

// ---- structured (layered) results ------------------------------------------------

const DECOMPOSE_GET = JSON.stringify({
  id: JOB,
  job_type: "image_decompose",
  status: "completed",
  result_url: null,
  params: {
    folder_id: null,
    mode: "granular",
    medias: [
      {
        data: { id: "in-1", type: "media_input", url: "https://cdn.example.com/inputs/source.png" },
        role: "image",
      },
    ],
  },
  result_json: {
    background_url: "https://cdn.example.com/jobs/bg-plate.png",
    layers: [
      { h: 625, label: "bottle", url: "https://cdn.example.com/jobs/layer_0.png", w: 244, x: 390, y: 227 },
      { h: 207, label: "sun", url: "https://cdn.example.com/jobs/layer_1.png", w: 207, x: 766, y: 46 },
    ],
  },
});

describe("workflowResultAssets", () => {
  it("reads background + labelled, placed layers out of result_json", () => {
    expect(workflowResultAssets(DECOMPOSE_GET)).toEqual([
      { url: "https://cdn.example.com/jobs/bg-plate.png", label: "background" },
      { url: "https://cdn.example.com/jobs/layer_0.png", label: "bottle", x: 390, y: 227, w: 244, h: 625 },
      { url: "https://cdn.example.com/jobs/layer_1.png", label: "sun", x: 766, y: 46, w: 207, h: 207 },
    ]);
    expect(workflowResultAssets(JSON.stringify([{ status: "completed", result_url: "https://cdn.example.com/x.png" }]))).toEqual([]);
    expect(workflowResultAssets("not json")).toEqual([]);
  });

  it("lands the background plate the wait output never listed", async () => {
    const { run } = fakeRun(
      baseHandler({
        [`generate workflow image_decompose`]: () => ok(JSON.stringify({ job_id: JOB })),
        // The wait output lists only the layer URLs (live behavior).
        [`generate wait ${JOB}`]: () =>
          ok(JSON.stringify([{ status: "completed", result_urls: ["https://cdn.example.com/jobs/layer_0.png", "https://cdn.example.com/jobs/layer_1.png"] }])),
        [`generate get ${JOB}`]: () => ok(DECOMPOSE_GET),
      })
    );
    const p = provider(run);
    const prod = makeProduction();
    const restore = stubFetch(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const result = await p.generateWorkflow(
        prod,
        { workflow: "image_decompose", params: { mode: "granular" }, refs: [pngRef("Source.png")] },
        () => {}
      );
      expect(result.files).toHaveLength(3);
      expect(result.files[0]).toMatchObject({ label: "background", url: "https://cdn.example.com/jobs/bg-plate.png" });
      expect(result.files[1]).toMatchObject({ label: "bottle", x: 390, y: 227, w: 244, h: 625 });
      expect(result.files[2]).toMatchObject({ label: "sun" });
      expect(result.resultUrls[0]).toBe("https://cdn.example.com/jobs/bg-plate.png");
      // The submitted input's echo URL is never landed as a result.
      expect(result.resultUrls).not.toContain("https://cdn.example.com/inputs/source.png");
    } finally {
      restore();
    }
  });

  it("rechecks structured results without downloading the input echo", async () => {
    const { run } = fakeRun(baseHandler({ [`generate get ${JOB}`]: () => ok(DECOMPOSE_GET) }));
    const p = provider(run);
    const restore = stubFetch(Buffer.from([1, 2, 3]));
    try {
      const got = await p.recheckWorkflow({
        historyId: JOB,
        workflow: "higgsfield-cli:workflow:image_decompose",
        kind: "image",
        at: new Date().toISOString(),
      });
      expect(got?.files).toHaveLength(3);
      expect(got?.files[0].label).toBe("background");
      expect(got?.resultUrls).not.toContain("https://cdn.example.com/inputs/source.png");
    } finally {
      restore();
    }
  });
});
