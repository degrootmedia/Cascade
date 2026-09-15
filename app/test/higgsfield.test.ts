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

const OMNI_VID_MODEL = {
  ...VID_MODEL,
  id: "omni_vid",
  name: "Omni Vid",
  medias: [
    { name: "medias", type: "video", roles: ["video"] },
    { name: "medias", type: "image", roles: ["image_references"] },
  ],
};

/** Live Seedance 2.5 shape (2026-09-11): image roles plus a dedicated video
 *  references role — the submission that 422'd with "mode 't2v' does not
 *  accept reference media" rode [image_references, video_references]. */
const SEEDANCE25_MODEL = {
  ...VID_MODEL,
  medias: [
    { name: "medias", type: "image", roles: ["start_image", "end_image", "image_references"] },
    { name: "medias", type: "video", roles: ["video_references"] },
  ],
};

/** models_explore handler serving the live Seedance 2.5 shape. */
function exploreSeedance25() {
  return (args: Record<string, unknown>) => {
    if (args.action === "list") {
      const items = args.type === "video" ? [SEEDANCE25_MODEL] : [IMG_MODEL];
      return JSON.stringify({ items });
    }
    if (args.action === "get") {
      const all = [IMG_MODEL, SEEDANCE25_MODEL];
      const found = all.find((m) => m.id === args.model_id);
      return found ? JSON.stringify(found) : "no such model";
    }
    throw new Error(`unexpected explore action ${String(args.action)}`);
  };
}

/** models_explore handler serving list (per type) + get (per id) with trailing prose. */
function exploreHandler(extraImageModels: HiggsModel[] = []) {
  const imageModels = [IMG_MODEL, ...extraImageModels];
  return (args: Record<string, unknown>) => {
    if (args.action === "list") {
      const items = args.type === "video" ? [VID_MODEL, PLAIN_VID_MODEL, OMNI_VID_MODEL] : imageModels;
      return JSON.stringify({ items }) + "\nFree-trial unlim: not spendable right now.";
    }
    if (args.action === "get") {
      const all = [...imageModels, VID_MODEL, PLAIN_VID_MODEL, OMNI_VID_MODEL];
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

  it("falls back to the house default for auto, and fails loudly on a stale pick", async () => {
    stubFetch(Buffer.from("x"));
    // "auto" still resolves to the house default.
    {
      const { mcp, seen } = captureImageMcp();
      const gen = new HiggsfieldProvider(mcp).imageGenFn(makeProduction({ openArt: { model: "auto", resolution: "2k" } }))!;
      await gen("prompt", []);
      expect((seen.params as Record<string, unknown>).model).toBe("cinematic_studio_2_5");
      expect((seen.params as Record<string, unknown>).resolution).toBe("2k");
    }
    // An explicit pick that isn't in the vendor's catalog must never silently
    // bill another model (live 2026-09-11: a stale OpenArt id submitted to
    // seedance_2_5 and 500'd while the dropdown showed something else).
    for (const model of ["higgsfield:unknown_xyz", "some-openart-id"]) {
      const { mcp } = captureImageMcp();
      const gen = new HiggsfieldProvider(mcp).imageGenFn(makeProduction({ openArt: { model, resolution: "2k" } }))!;
      await expect(gen("prompt", [])).rejects.toThrow(/isn't a Higgsfield image model/);
    }
  });

  it("declines a preset-matcher notice and generates the image literally", async () => {
    stubFetch(Buffer.from("fake-png-bytes"));
    const PRESET = "24bae836-2c4a-48e0-89b6-49fcc0b21612";
    const notice =
      `Notice: This prompt looks like the Higgsfield preset "IN THE DARK". Ask the user whether to use that preset or generate literally.\n\n` +
      `Preset id: ${PRESET}\n` +
      `To generate literally, retry with declined_preset_id: "${PRESET}".`;
    const submits: Record<string, unknown>[] = [];
    const notices: string[] = [];
    const base = fakeMcp({
      generate_image: (a: Record<string, unknown>) => {
        submits.push(a.params as Record<string, unknown>);
        return submits.length === 1 ? notice : `Submitted 1 job.\n- ${JOB} "a probe"`;
      },
      job_status: () => ({ text: `Job ${JOB} — completed\n${RESULT_URL}\n[resource_link]`, uris: [RESULT_URL] }),
      models_explore: exploreHandler(),
      media_upload: () => uploadReply(),
      media_confirm: () => `Confirmed 1 upload.\n- ${UPLOAD_ID} (uploaded)`,
    });
    const gen = new HiggsfieldProvider(base).imageGenFn(makeProduction(), undefined, undefined, (m) => { notices.push(m); })!;
    await expect(gen("moody airship", [])).resolves.toEqual(Buffer.from("fake-png-bytes"));
    expect(submits).toHaveLength(2);
    expect(submits[1]).toMatchObject({ declined_preset_id: PRESET });
    expect(notices.some((m) => /IN THE DARK/.test(m))).toBe(true);
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
    expect(rel).toMatch(/^boards\/0100\/video\/shot-0100-.+\.mp4$/);
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

  it("uploads a @[tag]-cited video reference from its media file", async () => {
    // Live 2026-09-11: video refs cited in the video prompt never uploaded —
    // resolvePromptRefs ran without includeVideo, so a mediaPath-only
    // reference had no artwork candidate and the tag never resolved.
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
    const prod = makeProduction({
      references: [{ id: "r1", name: "Clip", media: "video", mediaPath: "references/clip.mp4" }],
    });
    fs.mkdirSync(path.join(prod.meta.folder, "videos"), { recursive: true });
    fs.mkdirSync(path.join(prod.meta.folder, "references"), { recursive: true });
    fs.writeFileSync(path.join(prod.meta.folder, "videos", "src.jpg"), Buffer.from("fake-jpeg"));
    fs.writeFileSync(path.join(prod.meta.folder, "references", "clip.mp4"), Buffer.from("fake-mp4-bytes"));
    await new HiggsfieldProvider(base).generateVideoClip(
      prod,
      makeShot(),
      { model: "higgsfield:omni_vid", resolution: "1080p", durationSec: 5, prompt: "animate @[Clip]" },
      () => {},
      "videos/src.jpg"
    );
    expect(seen.params?.medias).toEqual([
      { value: UPLOAD_ID, role: "image_references" },
      { value: UPLOAD_ID, role: "video" },
    ]);
    expect(seen.params?.prompt).toContain("Clip (reference image 2)");
  });

  it("names the reason when a reference upload fails", async () => {
    stubFetch(Buffer.from("fake-mp4-bytes"));
    const emits: string[] = [];
    const base = fakeMcp({
      generate_video: () => `Submitted 1 job.\n- ${JOB} "clip"`,
      job_status: () => ({ text: `Job ${JOB} — completed\n${RESULT_URL}`, uris: [RESULT_URL] }),
      models_explore: exploreHandler(),
      media_upload: () => { throw new Error("boom"); },
      media_confirm: () => `Confirmed 1 upload.\n- ${UPLOAD_ID} (uploaded)`,
    });
    const prod = makeProduction();
    fs.mkdirSync(path.join(prod.meta.folder, "videos"), { recursive: true });
    fs.writeFileSync(path.join(prod.meta.folder, "videos", "src.jpg"), Buffer.from("fake-jpeg"));
    const { rel } = await new HiggsfieldProvider(base).generateVideoClip(
      prod,
      makeShot(),
      { model: "higgsfield:seedance_2_5", resolution: "720p", durationSec: 5, prompt: "drift" },
      (m) => { emits.push(m); },
      "videos/src.jpg"
    );
    expect(rel).toMatch(/^boards\/0100\/video\/shot-0100-.+\.mp4$/);
    expect(emits.some((m) => /couldn't be uploaded \(boom\)/.test(m))).toBe(true);
  });

  it("reports a moderation-blocked job readably instead of 'no video'", async () => {
    stubFetch(Buffer.from("fake-mp4-bytes"));
    let submitted = false;
    const base = fakeMcp({
      generate_video: () => { submitted = true; return `Submitted 1 job.\n- ${JOB} "clip"`; },
      job_status: () => `Job ${JOB} — nsfw`,
      models_explore: exploreHandler(),
      media_upload: () => uploadReply(),
      media_confirm: () => `Confirmed 1 upload.\n- ${UPLOAD_ID} (uploaded)`,
    });
    const prod = makeProduction();
    fs.mkdirSync(path.join(prod.meta.folder, "videos"), { recursive: true });
    fs.writeFileSync(path.join(prod.meta.folder, "videos", "src.jpg"), Buffer.from("fake-jpeg"));
    await expect(
      new HiggsfieldProvider(base).generateVideoClip(
        prod,
        makeShot(),
        { model: "higgsfield:seedance_2_5", resolution: "720p", durationSec: 5, prompt: "drift" },
        () => {},
        "videos/src.jpg"
      )
    ).rejects.toThrow(/generation nsfw/);
    expect(submitted).toBe(true);
  });

  it("declines a preset-matcher notice and generates the prompt literally", async () => {
    // Live 2026-09-11: the airship prompt matched the "IN THE DARK" preset, so
    // generate_video returned a notice (no job). The loose UUID match took the
    // preset id for a job id and job_status 500'd ("Something went wrong").
    stubFetch(Buffer.from("fake-mp4-bytes"));
    const PRESET = "24bae836-2c4a-48e0-89b6-49fcc0b21612";
    const notice =
      `Notice: This prompt looks like the Higgsfield preset "IN THE DARK". Ask the user whether to use that preset or generate literally.\n\n` +
      `Preset id: ${PRESET}\n` +
      `To use the preset, retry with model: "higgsfield_preset" and preset_id: "${PRESET}".\n` +
      `To generate literally, retry with declined_preset_id: "${PRESET}".`;
    const submits: Record<string, unknown>[] = [];
    const emits: string[] = [];
    const base = fakeMcp({
      generate_video: (a: Record<string, unknown>) => {
        submits.push(a.params as Record<string, unknown>);
        return submits.length === 1 ? notice : `Submitted 1 job.\n- ${JOB} "clip"`;
      },
      job_status: () => ({ text: `Job ${JOB} — completed\n${RESULT_URL}`, uris: [RESULT_URL] }),
      models_explore: exploreHandler(),
      media_upload: () => uploadReply(),
      media_confirm: () => `Confirmed 1 upload.\n- ${UPLOAD_ID} (uploaded)`,
    });
    const onGeneration = vi.fn();
    const prod = makeProduction();
    fs.mkdirSync(path.join(prod.meta.folder, "videos"), { recursive: true });
    fs.writeFileSync(path.join(prod.meta.folder, "videos", "src.jpg"), Buffer.from("fake-jpeg"));
    const { rel } = await new HiggsfieldProvider(base, { onGeneration }).generateVideoClip(
      prod,
      makeShot(),
      { model: "higgsfield:seedance_2_5", resolution: "1080p", durationSec: 5, prompt: "airship holds still" },
      (m) => { emits.push(m); },
      "videos/src.jpg"
    );
    expect(rel).toMatch(/^boards\/0100\/video\/shot-0100-.+\.mp4$/);
    // First submit carried no bypass; the retry declined the preset.
    expect(submits).toHaveLength(2);
    expect(submits[0]).not.toHaveProperty("declined_preset_id");
    expect(submits[1]).toMatchObject({ model: "seedance_2_5", declined_preset_id: PRESET });
    expect(emits.some((m) => /IN THE DARK/.test(m))).toBe(true);
    expect(onGeneration).toHaveBeenCalledTimes(1);
  });

  it("fails loudly on a stale video pick instead of billing another model", async () => {
    // Live 2026-09-11: a stale OpenArt id ("byte-plus-seedance-2_0") submitted
    // while Higgsfield was active silently fell back to seedance_2_5.
    stubFetch(Buffer.from("fake-mp4-bytes"));
    let submitted = false;
    const base = fakeMcp({
      generate_video: () => { submitted = true; return `Submitted 1 job.\n- ${JOB} "clip"`; },
      job_status: () => ({ text: `Job ${JOB} — completed\n${RESULT_URL}`, uris: [RESULT_URL] }),
      models_explore: exploreHandler(),
      media_upload: () => uploadReply(),
      media_confirm: () => `Confirmed 1 upload.\n- ${UPLOAD_ID} (uploaded)`,
    });
    await expect(
      new HiggsfieldProvider(base).generateVideoClip(
        makeProduction(),
        makeShot(),
        { model: "byte-plus-seedance-2_0", resolution: "1080p", durationSec: 5, prompt: "drift" },
        () => {},
        undefined,
        [],
        { start: { name: "A", dataUrl: PIXEL } }
      )
    ).rejects.toThrow(/isn't a Higgsfield video model/);
    expect(submitted).toBe(false);
  });

  it("submits the node-graph video node's refs as references, not keyframes", async () => {
    // Live 2026-09-11: the video node's source frame rode the start_image slot
    // and got rejected by Seedance 2.0. Ordinary (non-tween) submissions ride
    // the reference path: the frame in the image-reference role, dropped video
    // clips in the model's video element role.
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
    const prod = makeProduction();
    fs.mkdirSync(path.join(prod.meta.folder, "videos"), { recursive: true });
    fs.writeFileSync(path.join(prod.meta.folder, "videos", "src.jpg"), Buffer.from("fake-jpeg"));
    const videoRefDataUrl = `data:video/mp4;base64,${Buffer.from("fake-video-bytes").toString("base64")}`;
    const { rel } = await new HiggsfieldProvider(base).generateVideoClip(
      prod,
      makeShot(),
      { model: "higgsfield:omni_vid", resolution: "1080p", durationSec: 5, prompt: "drift" },
      () => {},
      "videos/src.jpg",
      [
        { name: "clip ref", dataUrl: videoRefDataUrl },
        { name: "still ref", dataUrl: PIXEL },
      ]
    );
    expect(rel).toMatch(/^boards\/0100\/video\/shot-0100-.+\.mp4$/);
    expect(seen.params?.medias).toEqual([
      { value: UPLOAD_ID, role: "image_references" }, // source frame — a reference, never a start keyframe
      { value: UPLOAD_ID, role: "video" }, // video ref → the model's video element role
      { value: UPLOAD_ID, role: "image_references" }, // extra image ref → the reference role
    ]);
  });

  it("retries once with the source frame as start_image when the backend rejects t2v+references", async () => {
    // Live 2026-09-11: Seedance 2.5 inferred mode 't2v' for an
    // [image_references, video_references] submission and 422'd ("mode 't2v'
    // does not accept reference media"). The adapter retries once with the
    // source frame rebound to start_image, reusing the uploaded media ids.
    stubFetch(Buffer.from("fake-mp4-bytes"));
    const submits: Record<string, unknown>[] = [];
    const emits: string[] = [];
    const base = fakeMcp({
      generate_video: (a: Record<string, unknown>) => {
        // Snapshot: the adapter mutates the same params object on retry.
        submits.push(JSON.parse(JSON.stringify(a.params)) as Record<string, unknown>);
        if (submits.length === 1) {
          throw new Error(
            `MCP error: Error starting generation: seedance_2_5 backend request failed (422): ` +
            `params failed validation [{"type":"value_error","loc":[],"msg":"Value error, mode 't2v' does not accept reference media","input":{}}]`
          );
        }
        return `Submitted 1 job.\n- ${JOB} "clip"`;
      },
      job_status: () => ({ text: `Job ${JOB} — completed\n${RESULT_URL}`, uris: [RESULT_URL] }),
      models_explore: exploreSeedance25(),
      media_upload: () => uploadReply(),
      media_confirm: () => `Confirmed 1 upload.\n- ${UPLOAD_ID} (uploaded)`,
    });
    const prod = makeProduction();
    fs.mkdirSync(path.join(prod.meta.folder, "videos"), { recursive: true });
    fs.writeFileSync(path.join(prod.meta.folder, "videos", "src.jpg"), Buffer.from("fake-jpeg"));
    const videoRefDataUrl = `data:video/mp4;base64,${Buffer.from("fake-video-bytes").toString("base64")}`;
    const onGeneration = vi.fn();
    const { rel } = await new HiggsfieldProvider(base, { onGeneration }).generateVideoClip(
      prod,
      makeShot(),
      { model: "higgsfield:seedance_2_5", resolution: "1080p", durationSec: 5, prompt: "follow the camera move" },
      (m) => { emits.push(m); },
      "videos/src.jpg",
      [{ name: "Playblast", dataUrl: videoRefDataUrl }]
    );
    expect(rel).toMatch(/^boards\/0100\/video\/shot-0100-.+\.mp4$/);
    expect(submits).toHaveLength(2);
    // First attempt rode the reference path (the shape the backend 422'd).
    expect(submits[0].medias).toEqual([
      { value: UPLOAD_ID, role: "image_references" },
      { value: UPLOAD_ID, role: "video_references" },
    ]);
    // Retry keeps the prompt + uploaded ids, reanchoring the source frame.
    expect(submits[1].medias).toEqual([
      { value: UPLOAD_ID, role: "start_image" },
      { value: UPLOAD_ID, role: "video_references" },
    ]);
    expect(submits[1].prompt).toBe(submits[0].prompt);
    expect(emits.some((m) => /rejected references in text-to-video mode — retrying/.test(m))).toBe(true);
    expect(onGeneration).toHaveBeenCalledTimes(1);
  });

  it("surfaces the 422 as-is when the model declares no start_image to reanchor to", async () => {
    stubFetch(Buffer.from("fake-mp4-bytes"));
    let submitted = 0;
    const base = fakeMcp({
      generate_video: () => {
        submitted++;
        throw new Error(`backend request failed (422): mode 't2v' does not accept reference media`);
      },
      job_status: () => ({ text: `Job ${JOB} — completed\n${RESULT_URL}`, uris: [RESULT_URL] }),
      models_explore: exploreHandler(),
      media_upload: () => uploadReply(),
      media_confirm: () => `Confirmed 1 upload.\n- ${UPLOAD_ID} (uploaded)`,
    });
    const prod = makeProduction();
    fs.mkdirSync(path.join(prod.meta.folder, "videos"), { recursive: true });
    fs.writeFileSync(path.join(prod.meta.folder, "videos", "src.jpg"), Buffer.from("fake-jpeg"));
    // omni_vid declares no start_image — there is nothing to reanchor to.
    await expect(
      new HiggsfieldProvider(base).generateVideoClip(
        prod,
        makeShot(),
        { model: "higgsfield:omni_vid", resolution: "1080p", durationSec: 5, prompt: "drift" },
        () => {},
        "videos/src.jpg"
      )
    ).rejects.toThrow(/does not accept reference media — submitted:/);
    expect(submitted).toBe(1);
  });

  it("does not reanchor tween submissions (keyframes already bind start/end slots)", async () => {
    stubFetch(Buffer.from("fake-mp4-bytes"));
    let submitted = 0;
    const base = fakeMcp({
      generate_video: () => {
        submitted++;
        throw new Error(`backend request failed (422): mode 't2v' does not accept reference media`);
      },
      job_status: () => ({ text: `Job ${JOB} — completed\n${RESULT_URL}`, uris: [RESULT_URL] }),
      models_explore: exploreSeedance25(),
      media_upload: () => uploadReply(),
      media_confirm: () => `Confirmed 1 upload.\n- ${UPLOAD_ID} (uploaded)`,
    });
    await expect(
      new HiggsfieldProvider(base).generateVideoClip(
        makeProduction(),
        makeShot(),
        { model: "higgsfield:seedance_2_5", resolution: "1080p", durationSec: 5, prompt: "drift" },
        () => {},
        undefined,
        [],
        { start: { name: "A", dataUrl: PIXEL }, end: { name: "B", dataUrl: PIXEL } }
      )
    ).rejects.toThrow(/does not accept reference media — submitted:/);
    expect(submitted).toBe(1);
  });

  it("reports both attempts when the reanchored retry also fails", async () => {
    stubFetch(Buffer.from("fake-mp4-bytes"));
    const seen: string[] = [];
    const base = fakeMcp({
      generate_video: () => {
        seen.push("submit");
        throw new Error(`backend request failed (422): mode 't2v' does not accept reference media`);
      },
      job_status: () => ({ text: `Job ${JOB} — completed\n${RESULT_URL}`, uris: [RESULT_URL] }),
      models_explore: exploreSeedance25(),
      media_upload: () => uploadReply(),
      media_confirm: () => `Confirmed 1 upload.\n- ${UPLOAD_ID} (uploaded)`,
    });
    const prod = makeProduction();
    fs.mkdirSync(path.join(prod.meta.folder, "videos"), { recursive: true });
    fs.writeFileSync(path.join(prod.meta.folder, "videos", "src.jpg"), Buffer.from("fake-jpeg"));
    const videoRefDataUrl = `data:video/mp4;base64,${Buffer.from("fake-video-bytes").toString("base64")}`;
    await expect(
      new HiggsfieldProvider(base).generateVideoClip(
        prod,
        makeShot(),
        { model: "higgsfield:seedance_2_5", resolution: "1080p", durationSec: 5, prompt: "drift" },
        () => {},
        "videos/src.jpg",
        [{ name: "Playblast", dataUrl: videoRefDataUrl }]
      )
    ).rejects.toThrow(/first attempt:/);
    expect(seen).toHaveLength(2);
  });
});

describe("HiggsfieldProvider image quality + submit notice", () => {
  const JOB = "97c832be-9228-4ed6-95ee-36281116092b";
  const RESULT_URL = "https://cdn.example/hf_job.png";

  const QUALITY_IMG = {
    ...IMG_MODEL,
    id: "seedream_4_5",
    name: "Seedream 4.5",
    parameters: [
      { name: "resolution", required: "optional", type: "string", description: "Output resolution", default: "1k", options: ["1k", "2k", "4k"] },
      { name: "quality", required: "optional", type: "string", description: "Quality tier", default: "basic", options: ["basic", "high"] },
    ],
  };

  function qualityMcp(seen: { params?: Record<string, unknown> }, notices: string[]) {
    const base = fakeMcp({
      generate_image: () => `Submitted 1 job.\n- ${JOB} "p"`,
      job_status: () => ({ text: `Job ${JOB} — completed\n${RESULT_URL}`, uris: [RESULT_URL] }),
      models_explore: exploreHandler([QUALITY_IMG]),
    });
    const orig = base.callRaw.bind(base);
    (base as { callRaw: unknown }).callRaw = async (s: string, t: string, a: Record<string, unknown>) => {
      if (t === "generate_image") seen.params = a.params as Record<string, unknown>;
      return orig(s, t, a);
    };
    return base;
  }

  it("reads quality tiers + default from the catalog detail; null when undeclared", async () => {
    const provider = new HiggsfieldProvider(fakeMcp({ models_explore: exploreHandler([QUALITY_IMG]) }));
    expect(await provider.imageModelOptions("higgsfield:seedream_4_5")).toEqual({
      qualities: ["basic", "high"],
      defaultQuality: "basic",
    });
    // The house default declares no quality param — no dropdown, vendor default applies.
    expect(await provider.imageModelOptions("higgsfield:cinematic_studio_2_5")).toBeNull();
    expect(await provider.imageModelOptions("auto")).toBeNull();
    expect(await provider.imageModelOptions("openart:whatever")).toBeNull();
    expect(await provider.imageModelOptions("higgsfield:nope")).toBeNull();
  });

  it("modelOptions builds the normalized schema from catalog parameters + medias", async () => {
    const provider = new HiggsfieldProvider(fakeMcp({ models_explore: exploreHandler() }));
    const s = await provider.modelOptions("higgsfield:seedance_2_5");
    expect(s).not.toBeNull();
    const byFlag = (f: string) => s!.fields.find((x) => x.flag === f);
    expect(byFlag("resolution")!.values).toEqual(["480p", "720p", "1080p"]);
    expect(byFlag("duration")!.kind).toBe("number");
    expect(s!.aspectRatios).toEqual(["16:9", "9:16"]);
    // Media slots ride the reference group, never the options form.
    expect(s!.fields.some((x) => x.mediaRole)).toBe(true);
    expect(await provider.modelOptions("auto")).toBeNull();
    expect(await provider.modelOptions("higgsfield:nope")).toBeNull();
  });

  it("submits params.quality only for a declared tier (case-insensitive), else omits it", async () => {
    stubFetch(Buffer.from("x"));
    // Declared tier, any case → the catalog's own spelling is submitted.
    {
      const seen: { params?: Record<string, unknown> } = {};
      const gen = new HiggsfieldProvider(qualityMcp(seen, [])).imageGenFn(
        makeProduction({ openArt: { model: "higgsfield:seedream_4_5", resolution: "2k", quality: "HIGH" } })
      )!;
      await gen("prompt", []);
      expect(seen.params).toMatchObject({ model: "seedream_4_5", quality: "high" });
    }
    // Undeclared tier → omitted (vendor default applies), never guessed.
    {
      const seen: { params?: Record<string, unknown> } = {};
      const gen = new HiggsfieldProvider(qualityMcp(seen, [])).imageGenFn(
        makeProduction({ openArt: { model: "higgsfield:seedream_4_5", resolution: "2k", quality: "ultra" } })
      )!;
      await gen("prompt", []);
      expect(seen.params).not.toHaveProperty("quality");
    }
    // Model without a quality param → omitted even when configured.
    {
      const seen: { params?: Record<string, unknown> } = {};
      const gen = new HiggsfieldProvider(qualityMcp(seen, [])).imageGenFn(
        makeProduction({ openArt: { model: "auto", resolution: "1k", quality: "high" } })
      )!;
      await gen("prompt", []);
      expect((seen.params as Record<string, unknown>).model).toBe("cinematic_studio_2_5");
      expect(seen.params).not.toHaveProperty("quality");
    }
  });

  it("emits a submit notice naming the exact model + params", async () => {
    stubFetch(Buffer.from("x"));
    const seen: { params?: Record<string, unknown> } = {};
    const notices: string[] = [];
    const gen = new HiggsfieldProvider(qualityMcp(seen, notices)).imageGenFn(
      makeProduction({ openArt: { model: "higgsfield:seedream_4_5", resolution: "2k", quality: "high" } }),
      undefined,
      undefined,
      (m) => { notices.push(m); }
    )!;
    await gen("prompt", []);
    expect(notices.some((m) => /Submitting image job via seedream_4_5/.test(m))).toBe(true);
    expect(notices.some((m) => /quality="high"/.test(m))).toBe(true);
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
    expect(resolveProviderId("higgsfield-cli")).toBe("higgsfield-cli");
    expect(resolveProviderId("openart-cli")).toBe("openart-cli");
    expect(resolveProviderId("openart")).toBe("openart");
    expect(resolveProviderId("bogus")).toBe("openart");
    expect(resolveProviderId(undefined)).toBe("openart");
    expect(PROVIDER_META.higgsfield.displayName).toBe("Higgsfield");
    expect(PROVIDER_META["higgsfield-cli"].displayName).toBe("Higgsfield CLI");
    expect(PROVIDER_META["openart-cli"].displayName).toBe("OpenArt CLI");
  });

  it("createProviders builds all vendors over the same seam", () => {
    const mcp = fakeMcp({}, []);
    const providers = createProviders(mcp);
    expect(providers.openart.id).toBe("openart");
    expect(providers.higgsfield.id).toBe("higgsfield");
    expect(providers["higgsfield-cli"].id).toBe("higgsfield-cli");
    expect(providers["openart-cli"].id).toBe("openart-cli");
  });
});
