/**
 * HiggsfieldProvider tests — the module's interface IS the test surface.
 *
 * The McpManager is injected, so a fake substitutes for the live Higgsfield
 * MCP server: canned replies use the exact shapes captured by the Phase-0
 * live probe (app/scripts/probe-higgsfield.mjs), including trailing prose
 * after the JSON payloads. fetch is stubbed (PUT uploads + result downloads).
 * scripting.js is mocked so pipeline.ts loads in a plain node process.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@core";
import type { McpManager } from "../src/main/mcp.js";
import { HiggsfieldProvider, higgsfieldRawId, HIGGSFIELD_ID_PREFIX } from "../src/main/providers/higgsfield.js";
import type { HiggsModel } from "../src/main/providers/higgsfield.js";
import { resolvePromptRefs } from "../src/main/providers/refs.js";
import { resolveProviderId, PROVIDER_META, createProviders } from "../src/main/providers/registry.js";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-higgsfield-${process.pid}-${Date.now()}` };
});

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

// ---- fake McpManager -------------------------------------------------------

interface FakeReply {
  text?: string;
  images?: Buffer[];
  uris?: string[];
}

type Handler = (args: Record<string, unknown>) => string | FakeReply | Promise<string | FakeReply>;

/** A McpManager whose higgsfield__ tools answer from a canned reply map. */
function fakeMcp(handlers: Record<string, Handler>, tools?: string[]): McpManager {
  const names = tools ?? Object.keys(handlers);
  const toolMap: Record<string, AgentTool> = {};
  for (const t of names) {
    toolMap[`higgsfield__${t}`] = {
      requiresApproval: true,
      definition: { type: "function", function: { name: t, description: "", parameters: {} } },
      run: async () => "",
    } as AgentTool;
  }
  const call = async (tool: string, args: Record<string, unknown>): Promise<string | FakeReply> => {
    const h = handlers[tool];
    if (!h) throw new Error(`No fake handler for higgsfield tool "${tool}"`);
    return h(args);
  };
  const m = {
    getTools: () => toolMap,
    callRaw: async (_s: string, tool: string, args: Record<string, unknown>) => {
      const out = await call(tool, args);
      return typeof out === "string" ? out : out.text ?? "";
    },
    callRawFull: async (_s: string, tool: string, args: Record<string, unknown>) => {
      const out = await call(tool, args);
      return typeof out === "string" ? { text: out, images: [] } : { text: out.text ?? "", images: out.images ?? [] };
    },
    callRawContent: async (_s: string, tool: string, args: Record<string, unknown>) => {
      const out = await call(tool, args);
      return typeof out === "string"
        ? { text: out, images: [], uris: [] }
        : { text: out.text ?? "", images: out.images ?? [], uris: out.uris ?? [] };
    },
  };
  return m as unknown as McpManager;
}

// ---- fixtures ---------------------------------------------------------------

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const IMG_MODEL = {
  id: "cinematic_studio_2_5",
  name: "Cinema Studio Image 2.5",
  provider_name: "Higgsfield",
  description: "Cinematic stills, up to 4K resolution",
  output_type: "image",
  parameters: [{ name: "resolution", required: "optional", type: "string", description: "Output resolution", default: "1k", options: ["1k", "2k", "4k"] }],
  medias: [{ name: "medias", type: "image", roles: ["image"] }],
  aspect_ratios: ["1:1", "16:9", "9:16"],
};

const IMG_MODEL_MAX1 = {
  ...IMG_MODEL,
  id: "soul_2",
  name: "Higgsfield Soul 2.0",
  medias: [{ name: "medias", type: "image", max: 1, roles: ["image"] }],
};

const VID_MODEL = {
  id: "seedance_2_5",
  name: "Seedance 2.5",
  provider_name: "Bytedance",
  description: "Text-to-video and omni-reference generation",
  output_type: "video",
  parameters: [
    { name: "duration", required: "optional", type: "number", description: "Duration in seconds (4-30).", min: 4, max: 30, default: 5 },
    { name: "resolution", required: "optional", type: "string", description: "Output resolution.", options: ["480p", "720p", "1080p"], default: "720p" },
  ],
  medias: [{ name: "medias", type: "image", roles: ["start_image", "end_image", "image_references"] }],
  aspect_ratios: ["16:9", "9:16"],
};

const PLAIN_VID_MODEL = {
  ...VID_MODEL,
  id: "plain_vid",
  name: "Plain Vid",
  medias: [{ name: "medias", type: "image", roles: ["start_image", "image_references"] }],
};

/** models_explore handler serving list (per type) + get (per id) with trailing prose. */
function exploreHandler(extraImageModels: HiggsModel[] = []) {
  const imageModels = [IMG_MODEL, ...extraImageModels];
  return (args: Record<string, unknown>) => {
    if (args.action === "list") {
      const items = args.type === "video" ? [VID_MODEL, PLAIN_VID_MODEL] : imageModels;
      return JSON.stringify({ items }) + "\nFree-trial unlim: not spendable right now.";
    }
    if (args.action === "get") {
      const all = [...imageModels, VID_MODEL, PLAIN_VID_MODEL];
      const found = all.find((m) => m.id === args.model_id);
      return found ? JSON.stringify(found) + "\nUnlim configs: none sent." : "no such model";
    }
    throw new Error(`unexpected explore action ${String(args.action)}`);
  };
}

const UPLOAD_ID = "10db24bb-815e-4e66-844c-8633b75ed60a";
const uploadReply = () =>
  `Generated 1 upload URL. Run the curl command, then call media_confirm with the media_id.\n` +
  `- ${UPLOAD_ID}: Upload the file using: curl -X PUT --data-binary @probe.jpg 'https://uploads.example/put'. ` +
  `After upload, call the media_confirm tool with type "image" and media_id "${UPLOAD_ID}".`;

/** fetch stub: PUT uploads succeed; GET downloads return canned bytes. */
function stubFetch(downloadBytes: Buffer) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { method?: string }) => {
      if (String(init?.method ?? "GET").toUpperCase() === "PUT") return { ok: true, status: 200 };
      expect(String(url)).toMatch(/^https:\/\//);
      return { ok: true, status: 200, arrayBuffer: async () => downloadBytes };
    })
  );
}

function makeProduction(overrides: Partial<Production> = {}): Production {
  return {
    meta: { id: "prod-1", name: "Test Production", folder: path.join(dataDir, "prod"), createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
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

function makeShot(overrides: Partial<ProductionShot> = {}): ProductionShot {
  return { id: "s1", number: "0100", audio: "", visual: "", ...overrides };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---- tests -------------------------------------------------------------------

describe("HiggsfieldProvider availability + identity", () => {
  it("reports available only when generate_image is connected", () => {
    expect(new HiggsfieldProvider(fakeMcp({ generate_image: () => "" })).isAvailable()).toBe(true);
    expect(new HiggsfieldProvider(fakeMcp({}, [])).isAvailable()).toBe(false);
    expect(new HiggsfieldProvider(fakeMcp({ balance: () => "" })).isAvailable()).toBe(false);
  });

  it("carries the higgsfield id and strips its own prefix", () => {
    expect(new HiggsfieldProvider(fakeMcp({}, [])).id).toBe("higgsfield");
    expect(higgsfieldRawId(`${HIGGSFIELD_ID_PREFIX}seedance_2_5`)).toBe("seedance_2_5");
    expect(higgsfieldRawId("seedance_2_5")).toBe("seedance_2_5");
  });
});

describe("HiggsfieldProvider.listModelChoices", () => {
  it("shapes the catalog with namespaced ids and input flags (no synthetic Auto)", async () => {
    const mcp = fakeMcp({ models_explore: exploreHandler() });
    const choices = await new HiggsfieldProvider(mcp).listModelChoices();
    expect(choices.some((c) => c.id === "auto")).toBe(false);
    expect(choices).toContainEqual(
      expect.objectContaining({ id: "higgsfield:cinematic_studio_2_5", imageInput: true, videoInput: false, cost: null })
    );
    expect(choices).toContainEqual(
      expect.objectContaining({ id: "higgsfield:seedance_2_5", videoInput: true })
    );
    expect(choices.find((c) => c.id === "higgsfield:seedance_2_5")?.description).toMatch(/Bytedance/);
  });

  it("caches the catalog within the TTL window", async () => {
    let calls = 0;
    const mcp = fakeMcp({
      models_explore: (...a: [Record<string, unknown>]) => {
        calls++;
        return exploreHandler()(a[0]);
      },
    });
    const provider = new HiggsfieldProvider(mcp);
    await provider.listModelChoices();
    await provider.listModelChoices();
    expect(calls).toBe(2); // one list per type on the first pass, none on the second
  });
});

describe("HiggsfieldProvider.getCredits", () => {
  it("parses the prose balance reply", async () => {
    const mcp = fakeMcp({ balance: () => "Credits: 1388.74 | Plan: ultimate" });
    expect(await new HiggsfieldProvider(mcp).getCredits()).toBe(1388.74);
  });

  it("returns null when the balance can't be read", async () => {
    expect(await new HiggsfieldProvider(fakeMcp({ balance: () => "nope" })).getCredits()).toBeNull();
    expect(await new HiggsfieldProvider(fakeMcp({}, [])).getCredits()).toBeNull();
  });
});

describe("HiggsfieldProvider.imageGenFn", () => {
  const JOB = "97c832be-9228-4ed6-95ee-36281116092b";
  const RESULT_URL = "https://cdn.example/hf_job.png";

  // Wire generate_image arg capture through a subclass-free wrapper: the
  // provider under test is constructed over this mcp in each test.
  function captureImageMcp() {
    return captureImageMcpWithExplore(exploreHandler());
  }

  function captureImageMcpWithExplore(explore: (args: Record<string, unknown>) => string) {
    const seen: { params?: Record<string, unknown> } = {};
    const base = fakeMcp({
      generate_image: () => `Submitted 1 job.\n- ${JOB} "a probe"`,
      job_status: () => ({ text: `Job ${JOB} — completed\n${RESULT_URL}\n[resource_link]`, uris: [RESULT_URL] }),
      models_explore: explore,
      media_upload: () => uploadReply(),
      media_confirm: () => `Confirmed 1 upload.\n- ${UPLOAD_ID} (uploaded)`,
    });
    const orig = base.callRaw.bind(base);
    (base as { callRaw: unknown }).callRaw = async (s: string, t: string, a: Record<string, unknown>) => {
      if (t === "generate_image") seen.params = a.params as Record<string, unknown>;
      return orig(s, t, a);
    };
    return { mcp: base, seen };
  }

  it("submits model + aspect + resolution + uploaded medias, records the ledger row, returns bytes", async () => {
    stubFetch(Buffer.from("fake-png-bytes"));
    const { mcp, seen } = captureImageMcp();
    const onGeneration = vi.fn();
    const gen = new HiggsfieldProvider(mcp, { onGeneration }).imageGenFn(makeProduction())!;
    const buf = await gen("a misty lake @image1", [{ name: "Lake ref", dataUrl: PIXEL }]);
    expect(buf).toEqual(Buffer.from("fake-png-bytes"));
    expect(seen.params).toMatchObject({
      model: "cinematic_studio_2_5",
      // @image1 anchors to the ref's submitted position: "<name> (reference image N)".
      prompt: "a misty lake Lake ref (reference image 1)",
      count: 1,
      aspect_ratio: "16:9",
      resolution: "1k",
    });
    expect(seen.params?.medias).toEqual([{ value: UPLOAD_ID, role: "image" }]);
    expect(onGeneration).toHaveBeenCalledTimes(1);
    expect(onGeneration).toHaveBeenCalledWith({
      kind: "image",
      model: "higgsfield:cinematic_studio_2_5",
      resolution: "1k",
      aspectRatio: "16:9",
      at: expect.any(Number),
      productionId: "prod-1",
      shotId: undefined,
    });
  });

  it("falls back to the house default for foreign or unknown model ids", async () => {
    stubFetch(Buffer.from("x"));
    for (const model of ["higgsfield:unknown_xyz", "some-openart-id", "auto"]) {
      const { mcp, seen } = captureImageMcp();
      const gen = new HiggsfieldProvider(mcp).imageGenFn(makeProduction({ openArt: { model, resolution: "2k" } }))!;
      await gen("prompt", []);
      expect((seen.params as Record<string, unknown>).model).toBe("cinematic_studio_2_5");
      expect((seen.params as Record<string, unknown>).resolution).toBe("2k");
    }
  });

  it("anchors multi-ref tokens to their submitted positions and renumbers around failures", async () => {
    stubFetch(Buffer.from("x"));
    // Two uploads succeed, the middle one fails: positions are 1 and 2 in the
    // SUBMITTED medias array, and the failed ref keeps just its name.
    let uploadCount = 0;
    const seen: { params?: Record<string, unknown> } = {};
    const mcp = fakeMcp({
      generate_image: () => `Submitted 1 job.\n- ${JOB} "p"`,
      job_status: () => ({ text: `Job ${JOB} — completed\n${RESULT_URL}`, uris: [RESULT_URL] }),
      models_explore: exploreHandler(),
      media_upload: () => {
        uploadCount++;
        if (uploadCount === 2) throw new Error("boom");
        return uploadReply();
      },
      media_confirm: () => `Confirmed 1 upload.\n- ${UPLOAD_ID} (uploaded)`,
    });
    const orig = mcp.callRaw.bind(mcp);
    (mcp as { callRaw: unknown }).callRaw = async (s: string, t: string, a: Record<string, unknown>) => {
      if (t === "generate_image") seen.params = a.params as Record<string, unknown>;
      return orig(s, t, a);
    };
    const gen = new HiggsfieldProvider(mcp).imageGenFn(makeProduction())!;
    await gen("blend @image1 with @image2 and @image3", [
      { name: "Ada", dataUrl: PIXEL },
      { name: "Broken", dataUrl: PIXEL },
      { name: "Mug", dataUrl: PIXEL },
    ]);
    expect(seen.params?.prompt).toBe(
      "blend Ada (reference image 1) with Broken and Mug (reference image 2)"
    );
    expect(seen.params?.medias).toEqual([
      { value: UPLOAD_ID, role: "image" },
      { value: UPLOAD_ID, role: "image" },
    ]);
  });

  it("caps uploads at the model's declared role max", async () => {
    stubFetch(Buffer.from("x"));
    const { mcp, seen } = captureImageMcpWithExplore(exploreHandler([IMG_MODEL_MAX1]));
    const gen = new HiggsfieldProvider(mcp).imageGenFn(makeProduction(), "higgsfield:soul_2")!;
    await gen("cast @image1 @image2 @image3", [
      { name: "A", dataUrl: PIXEL },
      { name: "B", dataUrl: PIXEL },
      { name: "C", dataUrl: PIXEL },
    ]);
    // soul_2 declares `image x1` — only the first ref is submitted; the rest
    // keep their names in the prompt with no positional anchor.
    expect(seen.params?.medias).toEqual([{ value: UPLOAD_ID, role: "image" }]);
    expect(seen.params?.prompt).toBe("cast A (reference image 1) B C");
  });

  it("omits aspect_ratio the model doesn't declare and continues text-only when uploads fail", async () => {
    stubFetch(Buffer.from("x"));
    // Break uploads: media_upload throws → ref skipped, generation proceeds.
    const seen: { params?: Record<string, unknown> } = {};
    const broken = fakeMcp({
      generate_image: () => `Submitted 1 job.\n- ${JOB} "p"`,
      job_status: () => ({ text: `Job ${JOB} — completed\n${RESULT_URL}`, uris: [RESULT_URL] }),
      models_explore: exploreHandler(),
      media_upload: () => {
        throw new Error("boom");
      },
    });
    const orig = broken.callRaw.bind(broken);
    (broken as { callRaw: unknown }).callRaw = async (s: string, t: string, a: Record<string, unknown>) => {
      if (t === "generate_image") seen.params = a.params as Record<string, unknown>;
      return orig(s, t, a);
    };
    const gen = new HiggsfieldProvider(broken).imageGenFn(makeProduction(), "higgsfield:cinematic_studio_2_5", undefined, undefined, "4:3")!;
    const buf = await gen("prompt @image1", [{ name: "R", dataUrl: PIXEL }]);
    expect(buf).toEqual(Buffer.from("x"));
    // 4:3 is not in the model's aspect_ratios and the upload failed → neither sent.
    expect(seen.params).not.toHaveProperty("aspect_ratio");
    expect(seen.params).not.toHaveProperty("medias");
  });

  it("records the pending job when the wait times out, and nothing on failure", async () => {
    // Always-queued: the 200-iteration cap trips quickly, then a timeout error.
    const queued = fakeMcp({
      generate_image: () => `Submitted 1 job.\n- ${JOB} "p"`,
      job_status: () => `Job ${JOB} — queued`,
      models_explore: exploreHandler(),
    });
    const onGeneration = vi.fn();
    const shot = makeShot();
    const gen = new HiggsfieldProvider(queued, { onGeneration }).imageGenFn(makeProduction())!;
    await expect(gen("prompt", [], shot)).rejects.toThrow(/timed out/);
    expect(shot.pendingImageGen).toMatchObject({ historyId: JOB, model: "higgsfield:cinematic_studio_2_5" });
    expect(onGeneration).not.toHaveBeenCalled();

    const failed = fakeMcp({
      generate_image: () => `Submitted 1 job.\n- ${JOB} "p"`,
      job_status: () => `Job ${JOB} — failed`,
      models_explore: exploreHandler(),
    });
    const gen2 = new HiggsfieldProvider(failed, { onGeneration }).imageGenFn(makeProduction())!;
    await expect(gen2("prompt", [], makeShot())).rejects.toThrow(/failed/);
    expect(onGeneration).not.toHaveBeenCalled();
  });

  it("keeps polling through in_progress statuses to completion (live regression)", async () => {
    // Live 2026-09-07: a sync:true poll returned `Job … — in_progress` with no
    // URL — the old terminal-word list stopped there and reported "no image".
    stubFetch(Buffer.from("late-bytes"));
    let polls = 0;
    const mcp = fakeMcp({
      generate_image: () => `Submitted 1 job.\n- ${JOB} "p"`,
      job_status: () => {
        polls++;
        return polls < 3
          ? `Job ${JOB} — in_progress`
          : { text: `Job ${JOB} — completed\n${RESULT_URL}\n[resource_link]`, uris: [RESULT_URL] };
      },
      models_explore: exploreHandler(),
    });
    const onGeneration = vi.fn();
    const gen = new HiggsfieldProvider(mcp, { onGeneration }).imageGenFn(makeProduction())!;
    await expect(gen("prompt", [])).resolves.toEqual(Buffer.from("late-bytes"));
    expect(polls).toBe(3);
    expect(onGeneration).toHaveBeenCalledTimes(1);
  });
});

describe("HiggsfieldProvider.generateVideoClip", () => {
  const JOB = "aaaaaaaa-1111-2222-3333-444444444444";
  const RESULT_URL = "https://cdn.example/hf_job.mp4";

  it("uploads start/end frames to their roles, writes the clip + ledger row", async () => {
    stubFetch(Buffer.from("fake-mp4-bytes"));
    const seen: { params?: Record<string, unknown> } = {};
    const base = fakeMcp({
      generate_video: () => `Submitted 1 job.\n- ${JOB} "clip"`,
      job_status: () => ({ text: `Job ${JOB} — completed\n${RESULT_URL}`, uris: [RESULT_URL] }),
      models_explore: exploreHandler(),
      media_upload: () => uploadReply(),
      media_confirm: () => `Confirmed 1 upload.\n- ${UPLOAD_ID} (uploaded)`,
    });
    const orig = base.callRaw.bind(base);
    (base as { callRaw: unknown }).callRaw = async (s: string, t: string, a: Record<string, unknown>) => {
      if (t === "generate_video") seen.params = a.params as Record<string, unknown>;
      return orig(s, t, a);
    };
    const onGeneration = vi.fn();
    const prod = makeProduction();
    const shot = makeShot();
    const { rel } = await new HiggsfieldProvider(base, { onGeneration }).generateVideoClip(
      prod,
      shot,
      { model: "auto", resolution: "1080p", durationSec: 5, prompt: "drift" },
      () => {},
      undefined,
      [],
      { start: { name: "A", dataUrl: PIXEL }, end: { name: "B", dataUrl: PIXEL } }
    );
    expect(rel).toMatch(/^videos\/shot-0100-.+\.mp4$/);
    expect(fs.existsSync(path.join(prod.meta.folder, rel))).toBe(true);
    // Auto + end keyframe prefers the end_image model; 5s sits inside its 4–30s range.
    expect(seen.params).toMatchObject({ model: "seedance_2_5", duration: 5, resolution: "1080p" });
    expect(seen.params?.medias).toEqual([
      { value: UPLOAD_ID, role: "start_image" },
      { value: UPLOAD_ID, role: "end_image" },
    ]);
    expect(onGeneration).toHaveBeenCalledWith({
      kind: "video",
      model: "higgsfield:seedance_2_5",
      resolution: "1080p",
      durationSec: 5,
      at: expect.any(Number),
      productionId: "prod-1",
      shotId: "s1",
    });
  });

  it("fails loudly instead of clamping when the model can't do the requested length", async () => {
    stubFetch(Buffer.from("fake-mp4-bytes"));
    let submitted = false;
    const base = fakeMcp({
      generate_video: () => { submitted = true; return `Submitted 1 job.\n- ${JOB} "clip"`; },
      job_status: () => ({ text: `Job ${JOB} — completed\n${RESULT_URL}`, uris: [RESULT_URL] }),
      models_explore: exploreHandler(),
      media_upload: () => uploadReply(),
      media_confirm: () => `Confirmed 1 upload.\n- ${UPLOAD_ID} (uploaded)`,
    });
    const onGeneration = vi.fn();
    // seedance_2_5 declares duration 4–30s: a 2s tween block must error with
    // the supported range, never silently submit a longer clip.
    await expect(
      new HiggsfieldProvider(base, { onGeneration }).generateVideoClip(
        makeProduction(),
        makeShot(),
        { model: "auto", resolution: "1080p", durationSec: 2, prompt: "drift" },
        () => {},
        undefined,
        [],
        { start: { name: "A", dataUrl: PIXEL }, end: { name: "B", dataUrl: PIXEL } }
      )
    ).rejects.toThrow(/doesn't support a 2s clip.*4–30s/);
    expect(submitted).toBe(false);
    expect(onGeneration).not.toHaveBeenCalled();
  });

  it("throws a readable error when no source frame exists", async () => {
    const provider = new HiggsfieldProvider(fakeMcp({ generate_video: () => "" }));
    await expect(
      provider.generateVideoClip(makeProduction(), makeShot(), { model: "auto", resolution: "720p", durationSec: 5, prompt: "x" }, () => {})
    ).rejects.toThrow(/No source frame/);
  });
});

describe("HiggsfieldProvider options + recheck + project", () => {
  it("reads resolutions and ranged durations; null for foreign ids", async () => {
    const provider = new HiggsfieldProvider(fakeMcp({ models_explore: exploreHandler() }));
    expect(await provider.videoModelOptions("higgsfield:seedance_2_5", true)).toEqual({
      resolutions: ["480p", "720p", "1080p"],
      durations: Array.from({ length: 27 }, (_, i) => i + 4),
    });
    expect(await provider.videoModelOptions("openart:whatever", true)).toBeNull();
    expect(await provider.videoModelOptions("higgsfield:nope", true)).toBeNull();
  });

  it("lists only end-frame-capable video models, namespaced", async () => {
    const provider = new HiggsfieldProvider(fakeMcp({ models_explore: exploreHandler() }));
    expect(await provider.videoEndFrameModels()).toEqual(["higgsfield:seedance_2_5"]);
  });

  it("rechecks a pending job: bytes when done, null while queued, throw when dead", async () => {
    stubFetch(Buffer.from("img-bytes"));
    const URL = "https://cdn.example/done.png";
    const doneMcp = fakeMcp({ job_status: () => ({ text: `Job j — completed\n${URL}`, uris: [URL] }) });
    const provider = new HiggsfieldProvider(doneMcp);
    await expect(provider.recheckPendingImage({ historyId: "j", prompt: "p", model: "m", at: "" })).resolves.toEqual(
      Buffer.from("img-bytes")
    );

    const queuedMcp = fakeMcp({ job_status: () => "Job j — queued" });
    await expect(
      new HiggsfieldProvider(queuedMcp).recheckPendingImage({ historyId: "j", prompt: "p", model: "m", at: "" })
    ).resolves.toBeNull();

    const deadMcp = fakeMcp({ job_status: () => "Job j — cancelled" });
    await expect(
      new HiggsfieldProvider(deadMcp).recheckPendingImage({ historyId: "j", prompt: "p", model: "m", at: "" })
    ).rejects.toThrow(/cancelled/);
  });

  it("has no project concept", async () => {
    await expect(new HiggsfieldProvider(fakeMcp({}, [])).resolveProject(makeProduction())).resolves.toBeNull();
  });
});

describe("providers/refs + registry", () => {
  it("resolvePromptRefs maps @[name] tags to portable tokens + extras", () => {
    const prod = makeProduction({
      characters: [{ id: "c1", name: "Ada", key: "Ada", artwork: PIXEL } as never],
    });
    expect(resolvePromptRefs(prod, "hello @[Ada]", 0)).toEqual({
      resolved: "hello @image1",
      extras: [{ name: "Ada", dataUrl: PIXEL }],
    });
    // Unknown names and artwork-less references pass through untouched.
    const bare = makeProduction();
    expect(resolvePromptRefs(bare, "hello @[Nobody]", 0)).toEqual({ resolved: "hello @[Nobody]", extras: [] });
  });

  it("resolveProviderId coerces unknown values to openart", () => {
    expect(resolveProviderId("higgsfield")).toBe("higgsfield");
    expect(resolveProviderId("openart")).toBe("openart");
    expect(resolveProviderId("bogus")).toBe("openart");
    expect(resolveProviderId(undefined)).toBe("openart");
    expect(PROVIDER_META.higgsfield.displayName).toBe("Higgsfield");
  });

  it("createProviders builds both vendors over the same seam", () => {
    const mcp = fakeMcp({}, []);
    const providers = createProviders(mcp);
    expect(providers.openart.id).toBe("openart");
    expect(providers.higgsfield.id).toBe("higgsfield");
  });
});
