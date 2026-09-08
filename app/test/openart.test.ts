/**
 * OpenArtClient tests — the module's interface IS the test surface.
 *
 * The McpManager is injected, so a fake substitutes for the live OpenArt MCP
 * server: canned tool replies drive the parsing, option-assignment, positional
 * citation
 * and async-wait logic exactly as the real server would. Electron is mocked so
 * the pipeline module (nativeImage) loads in a plain node process.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@core";
import type { McpManager } from "../src/main/mcp.js";
import { OpenArtClient, videoRefsAssign } from "../src/main/openart.js";
import { resolvePromptRefs } from "../src/main/providers/refs.js";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-openart-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
    createFromPath: () => ({ isEmpty: () => true }),
  },
  dialog: { showOpenDialog: async () => ({ canceled: true }) },
}));

// pipeline.ts imports scripting.ts for its text-extraction helpers; the OpenArt
// tests never touch them, and scripting's dynamic pdf-parse import doesn't
// resolve under Vitest — so the module is replaced with a factory instead.
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

/** A McpManager whose openart__ tools answer from a canned reply map. */
function fakeMcp(handlers: Record<string, Handler>, tools: string[] = Object.keys(handlers)): McpManager {
  const toolMap: Record<string, AgentTool> = {};
  for (const t of tools) {
    toolMap[`openart__${t}`] = {
      requiresApproval: true,
      definition: { type: "function", function: { name: t, description: "", parameters: {} } },
      run: async () => "",
    } as AgentTool;
  }
  const call = async (tool: string, args: Record<string, unknown>): Promise<string | FakeReply> => {
    const h = handlers[tool];
    if (!h) throw new Error(`No fake handler for openart tool "${tool}"`);
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

// ---- fixture ---------------------------------------------------------------

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

// ---- tests -----------------------------------------------------------------

describe("OpenArtClient.listModelChoices", () => {
  it("parses the model list and classifies image/video input + cost (no synthetic Auto)", async () => {
    const mcp = fakeMcp({
      openart_model_list: () =>
        JSON.stringify([
          { model: "foo-video", displayName: "Foo Video", media: ["image"], modes: ["video"] },
          { model: "bar-img", displayName: "Bar Img", media: ["image"], cost: 4 },
        ]),
    });
    const choices = await new OpenArtClient(mcp).listModelChoices();
    expect(choices).toHaveLength(2);
    expect(choices.some((c) => c.id === "auto")).toBe(false);
    expect(choices[0]).toMatchObject({ id: "foo-video", imageInput: true, videoInput: true });
    expect(choices[1]).toMatchObject({ id: "bar-img", videoInput: false, cost: 4 });
  });

  it("tolerates fenced replies with stray prose", async () => {
    const mcp = fakeMcp({
      openart_model_list: () => '```json\n{ "models": [ { "id": "m1", "name": "M1" } ] }\n``` done',
    });
    const choices = await new OpenArtClient(mcp).listModelChoices();
    expect(choices).toHaveLength(1);
    expect(choices[0].id).toBe("m1");
  });

  it("classifies image-only models as non-video even when the description mentions video", async () => {
    const mcp = fakeMcp({
      openart_model_list: () =>
        JSON.stringify([
          {
            model: "wan-2-7-text-to-image",
            displayName: "Wan 2.7 Image",
            media: ["image"],
            modes: ["text-to-image"],
            description: "Create stunning images and videos from a text prompt.",
          },
          {
            model: "grok-imagine-2-0",
            displayName: "Grok Imagine Image 2.0",
            media: ["image"],
            modes: [],
            description: "Photorealistic images and short video clips.",
          },
          { model: "veo-3-1", displayName: "Veo 3.1", media: ["image"], modes: ["video"], description: "Generates video." },
        ]),
    });
    const choices = await new OpenArtClient(mcp).listModelChoices();
    expect(choices.find((c) => c.id === "wan-2-7-text-to-image")).toMatchObject({ imageInput: true, videoInput: false });
    expect(choices.find((c) => c.id === "grok-imagine-2-0")).toMatchObject({ imageInput: true, videoInput: false });
    expect(choices.find((c) => c.id === "veo-3-1")).toMatchObject({ imageInput: true, videoInput: true });
  });

  it("falls back to the description only when structured fields carry no modality signal", async () => {
    const mcp = fakeMcp({
      openart_model_list: () =>
        JSON.stringify([
          { model: "mystery-img", displayName: "Mystery", description: "A great image model." },
          { model: "mystery-vid", displayName: "Mystery Vid", description: "A great video model." },
        ]),
    });
    const choices = await new OpenArtClient(mcp).listModelChoices();
    expect(choices.find((c) => c.id === "mystery-img")).toMatchObject({ imageInput: true, videoInput: false });
    expect(choices.find((c) => c.id === "mystery-vid")).toMatchObject({ imageInput: false, videoInput: true });
  });
});

describe("OpenArtClient.getCredits", () => {
  it("reads the signed-in account's credit balance", async () => {
    const mcp = fakeMcp({ openart_account_get: () => '{"credits": 42}' });
    expect(await new OpenArtClient(mcp).getCredits()).toBe(42);
  });

  it("returns null when the reply carries no credits", async () => {
    const mcp = fakeMcp({ openart_account_get: () => "no json here" });
    expect(await new OpenArtClient(mcp).getCredits()).toBeNull();
  });
});

describe("OpenArtClient.videoModelOptions", () => {
  it("resolves resolutions/durations from the live form schema and caches the result", async () => {
    let formCalls = 0;
    const mcp = fakeMcp({
      openart_model_form_get: (args) => {
        formCalls++;
        expect(args.mode).toBe("image2video");
        return JSON.stringify({
          jsonSchema: {
            properties: {
              resolution: { type: "string", enum: ["480p", "720p", "1080p"] },
              duration: { type: "string", enum: ["5s", "10s", "30s"] },
            },
          },
        });
      },
    });
    const client = new OpenArtClient(mcp);
    const first = await client.videoModelOptions("vid-model", true);
    expect(first).toEqual({ resolutions: ["480p", "720p", "1080p"], durations: [5, 10, 30] });
    const second = await client.videoModelOptions("vid-model", true);
    expect(second).toEqual(first);
    expect(formCalls).toBe(1); // served from cache
  });

  it("assigns a free-form string duration field as \"Ns\"", async () => {
    const folder = path.join(dataDir, "prod-wan");
    fs.mkdirSync(path.join(folder, "boards"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards", "shot-0100.jpg"), Buffer.from("jpeg-bytes"));
    let seenParams: Record<string, unknown> | undefined;
    const base = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "wan3-0", displayName: "Wan 3.0", media: ["image"], modes: ["video"] }]),
      openart_model_form_get: () =>
        JSON.stringify({
          jsonSchema: {
            properties: {
              prompt: { type: "string" },
              startFrame: { type: "object", properties: { url: {} } },
              endFrame: { type: "object", properties: { url: {} } },
              resolution: { type: "string", enum: ["480p", "720p", "1080p"] },
              duration: { type: "string", description: "Clip length in seconds (e.g. 2s)" },
            },
          },
        }),
      openart_generate_video: () => '{"status":"PENDING","historyId":"h-wan","pollAfterSeconds":0}',
      openart_creation_wait: () => ({ text: '{"status":"SUCCEEDED"}', images: [Buffer.from("fake-mp4")] }),
    });
    const orig = base.callRawFull.bind(base);
    (base as { callRawFull: unknown }).callRawFull = async (s: string, t: string, a: Record<string, unknown>) => {
      if (t === "openart_generate_video") seenParams = (a as { params: Record<string, unknown> }).params;
      return orig(s, t, a);
    };
    const client = new OpenArtClient(base);
    const prod = makeProduction({
      meta: { id: "prod-1", name: "Test Production", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    });
    const shot: ProductionShot = { id: "s1", number: "0100", audio: "", visual: "", artwork: "boards/shot-0100.jpg" };
    // A free-form string duration field must be sent as "2s" — never dropped
    // (a dropped length makes OpenArt fall back to its 5s default).
    await client.generateVideoClip(
      prod, shot, { model: "auto", resolution: "1080p", durationSec: 2, prompt: "animate" }, () => {}
    );
    expect(seenParams?.duration).toBe("2s");
    expect(seenParams?.resolution).toBe("1080p");
  });

  it("never submits a sentinel or coerced length — validation rejects unsupported ones (real Wan shape)", async () => {
    const folder = path.join(dataDir, "prod-wan-sentinel");
    fs.mkdirSync(path.join(folder, "boards"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards", "shot-0100.jpg"), Buffer.from("jpeg-bytes"));
    const formFor = () =>
      JSON.stringify({
        jsonSchema: {
          properties: {
            prompt: { type: "string" },
            resolution: { type: "string", enum: ["480p", "720p", "1080p"] },
            // oneOf consts with a -1 "auto/random" sentinel first — the shape
            // that previously turned a 2s request into an auto-length clip.
            duration: {
              title: "Duration",
              oneOf: [
                { const: -1, title: "Auto" },
                { const: 5, title: "5 seconds" },
                { const: 10, title: "10 seconds" },
                { const: 15, title: "15 seconds" },
                { const: 20, title: "20 seconds" },
              ],
            },
          },
        },
      });
    const base = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "wan3-0", displayName: "Wan 3.0", media: ["image"], modes: ["video"] }]),
      openart_model_form_get: formFor,
      openart_generate_video: () => { throw new Error("should not submit"); },
      openart_creation_wait: () => ({ text: '{"status":"SUCCEEDED"}', images: [Buffer.from("fake-mp4")] }),
    });
    const client = new OpenArtClient(base);
    const prod = makeProduction({
      meta: { id: "prod-1", name: "Test Production", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    });
    const shot: ProductionShot = { id: "s1", number: "0100", audio: "", visual: "", artwork: "boards/shot-0100.jpg" };
    // 2s is not among the real options (5/10/15/20s) — fail loudly, name them,
    // and never burn credits on an auto-length clip.
    await expect(
      client.generateVideoClip(prod, shot, { model: "auto", resolution: "1080p", durationSec: 2, prompt: "animate" }, () => {})
    ).rejects.toThrow(/doesn't support a 2s clip \(supports 5, 10, 15, 20s\)/);
  });

  it("returns null for the auto placeholder", async () => {
    const mcp = fakeMcp({ openart_model_form_get: () => '{"jsonSchema":{"properties":{}}}' });
    expect(await new OpenArtClient(mcp).videoModelOptions("auto", true)).toBeNull();
  });
});

describe("resolvePromptRefs (providers/refs, ex-OpenArtClient method)", () => {
  it("maps @[name] tags to portable tokens and dedupes the uploaded extras", () => {
    const p = makeProduction({
      characters: [{ id: "c1", name: "Gandalf", key: "", artwork: "data:image/png;base64,QUFBQQ==" }],
    });
    const { resolved, extras } = resolvePromptRefs(p, "Show @[Gandalf] and @[gandalf] together", 2);
    expect(resolved).toBe("Show @image3 and @image3 together");
    expect(extras).toEqual([{ name: "Gandalf", dataUrl: "data:image/png;base64,QUFBQQ==" }]);
  });

  it("skips references that have no artwork", () => {
    const p = makeProduction({
      characters: [{ id: "c1", name: "Gandalf", key: "", artwork: "data:image/png;base64,QUFBQQ==" }],
      products: [{ id: "p1", name: "Empty" }],
    });
    const { resolved, extras } = resolvePromptRefs(p, "Show @[Empty] and @[Gandalf]", 0);
    expect(resolved).toBe("Show @[Empty] and @image1");
    expect(extras).toEqual([{ name: "Gandalf", dataUrl: "data:image/png;base64,QUFBQQ==" }]);
  });
});

describe("videoRefsAssign", () => {
  it("fills every startFrame sub-field from the reference (Grok-style schema)", () => {
    // Regression: the schema requires type + label; mapping only url/id used
    // to drop them and the server rejected the frame with
    // "startFrame.type: expected \"image\"; startFrame.label: expected string".
    const refs = [{ type: "image", label: "Shot 0100 frame", url: "https://example.invalid/frame.png", id: "vr-1" }];
    const props = {
      startFrame: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["image"] },
          label: { type: "string" },
          url: { type: "string" },
          id: { type: "string" },
        },
      },
    };
    expect(videoRefsAssign(refs, props)).toEqual({
      startFrame: { type: "image", label: "Shot 0100 frame", url: "https://example.invalid/frame.png", id: "vr-1" },
    });
  });

  it("maps conventional url aliases (access_url, src) to the reference url", () => {
    const refs = [{ url: "https://example.invalid/f.png" }];
    const props = { startFrame: { type: "object", properties: { access_url: { type: "string" } } } };
    expect(videoRefsAssign(refs, props)).toEqual({ startFrame: { access_url: "https://example.invalid/f.png" } });
  });

  it("falls back to the whole reference when no sub-field maps", () => {
    const refs = [{ type: "image", label: "Frame", url: "https://example.invalid/f.png" }];
    const props = { startFrame: { type: "object", properties: { raw: { type: "string" } } } };
    expect(videoRefsAssign(refs, props)).toEqual({ startFrame: refs[0] });
  });

  it("uses array-style visualReferences for array fields", () => {
    const refs = [{ url: "https://example.invalid/a.png" }];
    const props = { visualReferences: { type: "array", items: { type: "object" } } };
    expect(videoRefsAssign(refs, props)).toEqual({ visualReferences: refs });
  });
});

describe("OpenArtClient.videoModelOptions (mode alignment)", () => {
  it("serves the FIRST-parsing mode's options — no cross-mode 1080p leak", async () => {
    // The image2video form (which generation actually submits) has no
    // resolution options; a later mode's form advertises 1080p. The dropdown
    // must reflect the submitted mode, never the later one.
    const mcp = fakeMcp({
      openart_model_form_get: (args) => {
        if (args.mode === "image2video") {
          return JSON.stringify({ jsonSchema: { properties: { startFrame: { type: "object", properties: {} } } } });
        }
        if (args.mode === "image_to_video") {
          return JSON.stringify({ jsonSchema: { properties: { resolution: { type: "string", enum: ["480p", "720p", "1080p"] } } } });
        }
        return JSON.stringify({ jsonSchema: { properties: {} } });
      },
    });
    const client = new OpenArtClient(mcp);
    const o = await client.videoModelOptions("grok-imagine-1-5", true);
    expect(o?.resolutions ?? []).toEqual([]); // empty — NOT the later mode's 1080p
    expect(o?.durations ?? []).toEqual([]);
  });
});

describe("OpenArtClient.imageGenFn", () => {
  it("generates a frame through the PENDING → creation_wait loop with 16:9/resolution/count assigned", async () => {
    const generated: Record<string, unknown>[] = [];
    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "kling-v2", displayName: "Kling V2", media: ["image"], modes: [] }]),
      openart_model_form_get: () =>
        JSON.stringify({
          jsonSchema: {
            properties: {
              aspectRatio: { type: "string", enum: ["16:9", "1:1", "9:16"] },
              resolution: { type: "string", enum: ["1k", "2k", "4k"] },
              imageCount: { type: "integer" },
            },
          },
        }),
      openart_generate_image: (args) => {
        generated.push(args);
        return '{"status":"PENDING","historyId":"h-abc123","pollAfterSeconds":0}';
      },
      openart_creation_wait: () => ({ text: '{"status":"SUCCEEDED"}', images: [Buffer.from("fake-jpeg-bytes")] }),
    });
    const client = new OpenArtClient(mcp);
    const gen = client.imageGenFn(makeProduction());
    expect(gen).not.toBeNull();

    const out = await gen!("Draw a castle on a hill", []);
    expect(out.toString()).toBe("fake-jpeg-bytes");
    expect(generated).toHaveLength(1);

    const args = generated[0] as Record<string, unknown>;
    expect(args.model).toBe("kling-v2");
    expect(args.mode).toBe("text2image");
    const params = args.params as Record<string, unknown>;
    expect(params.prompt).toBe("Draw a castle on a hill");
    expect(params.aspectRatio).toBe("16:9");
    expect(params.resolution).toBe("1k");
    expect(params.imageCount).toBe(1);
  });

  it("uploads references, cites them positionally, and runs in image2image mode", async () => {
    const generated: Record<string, unknown>[] = [];
    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "kling-v2", displayName: "Kling V2", media: ["image"], modes: [] }]),
      openart_model_form_get: () =>
        JSON.stringify({
          jsonSchema: {
            properties: {
              aspectRatio: { type: "string", enum: ["16:9", "1:1"] },
              visualReferences: { type: "array" },
            },
          },
        }),
      openart_upload_sign: () =>
        JSON.stringify({ signURL: "https://example.invalid/sign", visualReference: { id: "vr-1", url: "https://example.invalid/vr" } }),
      openart_generate_image: (args) => {
        generated.push(args);
        return '{"status":"PENDING","historyId":"h-img2img","pollAfterSeconds":0}';
      },
      openart_creation_wait: () => ({ text: '{"status":"SUCCEEDED"}', images: [Buffer.from("ref-jpeg")] }),
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    try {
      const gen = new OpenArtClient(mcp).imageGenFn(makeProduction())!;
      const out = await gen("Make it look like @image1", [
        { name: "Hero", dataUrl: "data:image/png;base64,VkVSWS1MT05HREFUQVVSTC1JTkdBR0U=" },
      ]);
      expect(out.toString()).toBe("ref-jpeg");

      const args = generated[0] as Record<string, unknown>;
      expect(args.mode).toBe("image2image");
      const params = args.params as Record<string, unknown>;
      expect(params.prompt).toBe("Make it look like Hero (reference image 1)");
      expect(params.visualReferences).toEqual([{ id: "vr-1", url: "https://example.invalid/vr" }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("honors a requested aspect ratio (4:3 / 1:1) instead of the 16:9 default", async () => {
    const generated: Record<string, unknown>[] = [];
    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "grok-imagine-1-5", displayName: "Grok Imagine", media: ["image"], modes: [] }]),
      openart_model_form_get: () =>
        JSON.stringify({
          jsonSchema: {
            properties: {
              aspectRatio: { type: "string", enum: ["1:1", "4:3", "16:9"] },
              resolution: { type: "string", enum: ["1k", "2k", "4k"] },
            },
          },
        }),
      openart_generate_image: (args) => {
        generated.push(args);
        return '{"status":"PENDING","historyId":"h-ratio","pollAfterSeconds":0}';
      },
      openart_creation_wait: () => ({ text: '{"status":"SUCCEEDED"}', images: [Buffer.from("ratio-jpeg")] }),
    });
    const client = new OpenArtClient(mcp);

    for (const ratio of ["1:1", "4:3", "16:9"] as const) {
      generated.length = 0;
      const gen = client.imageGenFn(makeProduction(), undefined, undefined, undefined, ratio)!;
      const out = await gen("A reference image", []);
      expect(out.toString()).toBe("ratio-jpeg");
      const params = (generated[0] as Record<string, unknown>).params as Record<string, unknown>;
      expect(params.aspectRatio).toBe(ratio);
    }
  });

  it("returns null when no image-generation tool is connected", () => {
    const client = new OpenArtClient(fakeMcp({ openart_model_list: () => "[]" }));
    expect(client.imageGenFn(makeProduction())).toBeNull();
  });

  it("surfaces a FAILED completion as an error", async () => {
    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "m", media: ["image"], modes: [] }]),
      openart_model_form_get: () => JSON.stringify({ jsonSchema: { properties: {} } }),
      openart_generate_image: () => '{"status":"PENDING","historyId":"h-fail","pollAfterSeconds":0}',
      openart_creation_wait: () => ({ text: '{"status":"FAILED"}', images: [], uris: [] }),
    });
    const gen = new OpenArtClient(mcp).imageGenFn(makeProduction())!;
    await expect(gen("any", [])).rejects.toThrow(/failed/i);
  });
});

describe("OpenArtClient pending-image contingency", () => {
  const shot = (): ProductionShot => ({ id: "s1", number: "0100", audio: "", visual: "" });

  it("records the shot as pending when the image wait times out, then a recheck reclaims the frame", async () => {
    let completed = false;
    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "m", media: ["image"], modes: [] }]),
      openart_model_form_get: () => JSON.stringify({ jsonSchema: { properties: {} } }),
      openart_generate_image: () => '{"status":"PENDING","historyId":"h-slow","pollAfterSeconds":0}',
      openart_creation_wait: () =>
        completed
          ? { text: '{"status":"SUCCEEDED"}', images: [Buffer.from("late-jpeg")], uris: [] }
          : { text: '{"status":"STILL_RUNNING","pollAfterSeconds":0}', images: [], uris: [] },
    });
    const client = new OpenArtClient(mcp);
    const gen = client.imageGenFn(makeProduction())!;
    const s = shot();

    vi.useFakeTimers();
    try {
      // The original wait runs its ~2.5 min cap with the job never completing.
      const first = gen("Draw a castle", [], s);
      const assertion = expect(first).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(151_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    // The job wasn't lost — it's recorded on the shot for a later recheck.
    expect(s.pendingImageGen).toMatchObject({ historyId: "h-slow", prompt: "Draw a castle", model: "m" });

    // While it's still rendering, a recheck probes and reports pending.
    vi.useFakeTimers();
    try {
      const pendingProbe = client.recheckPendingImage(s.pendingImageGen!);
      const probeAssertion = expect(pendingProbe).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(61_000);
      await probeAssertion;
    } finally {
      vi.useRealTimers();
    }

    // Once the job finishes server-side, a recheck downloads the frame.
    completed = true;
    await expect(client.recheckPendingImage(s.pendingImageGen!)).resolves.toEqual(Buffer.from("late-jpeg"));
  });

  it("records the result URL as pending when the finished image can't be downloaded, then a recheck retries it", async () => {
    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "m", media: ["image"], modes: [] }]),
      openart_model_form_get: () => JSON.stringify({ jsonSchema: { properties: {} } }),
      openart_generate_image: () => "Done! Your image is at https://example.invalid/out.png",
    });
    const client = new OpenArtClient(mcp);
    const gen = client.imageGenFn(makeProduction())!;
    const s = shot();
    const realFetch = globalThis.fetch;

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    try {
      await expect(gen("Draw a castle", [], s)).rejects.toThrow(/Couldn't download/i);
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(s.pendingImageGen).toMatchObject({ url: "https://example.invalid/out.png", prompt: "Draw a castle", model: "m" });

    // A recheck retries the URL once the download works again.
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      await expect(client.recheckPendingImage(s.pendingImageGen!)).resolves.toEqual(Buffer.from(bytes));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("reports a FAILED recheck as an error and does not fake a pending record", async () => {
    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "m", media: ["image"], modes: [] }]),
      openart_model_form_get: () => JSON.stringify({ jsonSchema: { properties: {} } }),
      openart_generate_image: () => '{"status":"PENDING","historyId":"h-fail2","pollAfterSeconds":0}',
      openart_creation_wait: () => ({ text: '{"status":"FAILED"}', images: [], uris: [] }),
    });
    const client = new OpenArtClient(mcp);
    const gen = client.imageGenFn(makeProduction())!;
    const s = shot();

    // FAILED/CANCELLED is a hard error — not a pending job to reclaim.
    await expect(gen("any", [], s)).rejects.toThrow(/failed/i);
    expect(s.pendingImageGen).toBeUndefined();

    // Rechecking a dead job throws too.
    await expect(client.recheckPendingImage({ historyId: "h-fail2", prompt: "any", model: "m", at: "" })).rejects.toThrow(/failed/i);
  });
});

describe("OpenArtClient generation recorder", () => {
  it("records a successful image generation with its resolved metadata", async () => {
    const onGeneration = vi.fn();
    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "kling-v2", displayName: "Kling V2", media: ["image"], modes: [] }]),
      openart_model_form_get: () =>
        JSON.stringify({
          jsonSchema: {
            properties: {
              aspectRatio: { type: "string", enum: ["16:9", "1:1"] },
              resolution: { type: "string", enum: ["1k", "2k", "4k"] },
            },
          },
        }),
      openart_generate_image: () => '{"status":"PENDING","historyId":"h-rec","pollAfterSeconds":0}',
      openart_creation_wait: () => ({ text: '{"status":"SUCCEEDED"}', images: [Buffer.from("rec-jpeg")] }),
    });
    const client = new OpenArtClient(mcp, { onGeneration });
    const gen = client.imageGenFn(makeProduction())!;
    const s: ProductionShot = { id: "s1", number: "0100", audio: "", visual: "" };

    const out = await gen("Draw a castle", [], s);
    expect(out.toString()).toBe("rec-jpeg");
    expect(onGeneration).toHaveBeenCalledTimes(1);
    expect(onGeneration).toHaveBeenCalledWith({
      kind: "image",
      model: "kling-v2",
      resolution: "1k",
      aspectRatio: "16:9",
      at: expect.any(Number),
      productionId: "prod-1",
      shotId: "s1",
    });
  });

  it("does not record a failed image submission", async () => {
    const onGeneration = vi.fn();
    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "m", media: ["image"], modes: [] }]),
      openart_model_form_get: () => JSON.stringify({ jsonSchema: { properties: {} } }),
      openart_generate_image: () => '{"status":"PENDING","historyId":"h-fail","pollAfterSeconds":0}',
      openart_creation_wait: () => ({ text: '{"status":"FAILED"}', images: [], uris: [] }),
    });
    const client = new OpenArtClient(mcp, { onGeneration });
    const gen = client.imageGenFn(makeProduction())!;

    await expect(gen("any", [])).rejects.toThrow(/failed/i);
    expect(onGeneration).not.toHaveBeenCalled();
  });

  it("records a successful video generation with its resolution and length", async () => {
    const onGeneration = vi.fn();
    const folder = path.join(dataDir, "prod");
    fs.mkdirSync(path.join(folder, "boards"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards", "shot-0100.jpg"), Buffer.from("jpeg-bytes"));

    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "veo-3", displayName: "Veo 3", media: ["image"], modes: ["video"] }]),
      openart_model_form_get: () =>
        JSON.stringify({
          jsonSchema: {
            properties: {
              resolution: { type: "string", enum: ["720p", "1080p"] },
              duration: { type: "string", enum: ["5s", "10s"] },
            },
          },
        }),
      openart_generate_video: () => '{"status":"PENDING","historyId":"h-vid","pollAfterSeconds":0}',
      openart_creation_wait: () => ({ text: '{"status":"SUCCEEDED"}', images: [Buffer.from("fake-mp4")] }),
    });
    const client = new OpenArtClient(mcp, { onGeneration });
    const prod = makeProduction({
      meta: { id: "prod-1", name: "Test Production", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    });
    const shot: ProductionShot = { id: "s1", number: "0100", audio: "", visual: "", artwork: "boards/shot-0100.jpg" };

    const { rel } = await client.generateVideoClip(
      prod,
      shot,
      { model: "auto", resolution: "1080p", durationSec: 5, prompt: "animate" },
      () => {}
    );
    expect(rel).toContain("shot-0100-");
    expect(onGeneration).toHaveBeenCalledTimes(1);
    expect(onGeneration).toHaveBeenCalledWith({
      kind: "video",
      model: "veo-3",
      resolution: "1080p",
      durationSec: 5,
      at: expect.any(Number),
      productionId: "prod-1",
      shotId: "s1",
    });
  });

  it("fails loudly instead of coercing when the model can't do the requested length", async () => {
    const folder = path.join(dataDir, "prod-short");
    fs.mkdirSync(path.join(folder, "boards"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards", "shot-0100.jpg"), Buffer.from("jpeg-bytes"));
    let submitted = false;
    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "veo-3", displayName: "Veo 3", media: ["image"], modes: ["video"] }]),
      openart_model_form_get: () =>
        JSON.stringify({
          jsonSchema: {
            properties: {
              resolution: { type: "string", enum: ["720p", "1080p"] },
              duration: { type: "string", enum: ["5s", "10s"] },
            },
          },
        }),
      openart_generate_video: () => { submitted = true; return '{"status":"PENDING","historyId":"h-vid","pollAfterSeconds":0}'; },
      openart_creation_wait: () => ({ text: '{"status":"SUCCEEDED"}', images: [Buffer.from("fake-mp4")] }),
    });
    const client = new OpenArtClient(mcp, { onGeneration: vi.fn() });
    const prod = makeProduction({
      meta: { id: "prod-1", name: "Test Production", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    });
    const shot: ProductionShot = { id: "s1", number: "0100", audio: "", visual: "", artwork: "boards/shot-0100.jpg" };
    // The form proves 5s/10s only: a 2s tween block must error naming the
    // supported lengths, never submit the nearest pick (a 5s clip).
    await expect(
      client.generateVideoClip(prod, shot, { model: "auto", resolution: "1080p", durationSec: 2, prompt: "animate" }, () => {})
    ).rejects.toThrow(/doesn't support a 2s clip.*5, 10s/);
    expect(submitted).toBe(false);
  });
});

describe("OpenArtClient.videoEndFrameModels", () => {
  const formWith = (extra: Record<string, unknown>) => JSON.stringify({
    jsonSchema: {
      properties: {
        startFrame: { type: "object", properties: { type: {}, url: {} } },
        ...extra,
      },
    },
  });
  const listOf = (...models: Record<string, unknown>[]) => JSON.stringify(models);
  const vid = (model: string) => ({ model, displayName: model, media: ["video"] });

  it("detects the end-frame slot, caches it, and reports null when unreadable", async () => {
    let formCalls = 0;
    const mcp = fakeMcp({
      openart_model_form_get: (args) => {
        formCalls++;
        expect(args.mode).toBe("image2video");
        return formWith(args.model === "tween-pro" ? { endFrame: { type: "object", properties: { type: {}, url: {} } } } : {});
      },
    });
    const client = new OpenArtClient(mcp);
    expect(await client.videoEndFrameSupport("tween-pro")).toBe(true);
    expect(await client.videoEndFrameSupport("plain-vid")).toBe(false);
    expect(await client.videoEndFrameSupport("tween-pro")).toBe(true);
    expect(formCalls).toBe(2); // third call served from cache
    expect(await client.videoEndFrameSupport("auto")).toBeNull();
  });

  it("returns null (unknown) when no form parses", async () => {
    const mcp = fakeMcp({ openart_model_form_get: () => { throw new Error("no form"); } });
    expect(await new OpenArtClient(mcp).videoEndFrameSupport("mystery")).toBeNull();
  });

  it("lists only the proven end-frame video models", async () => {
    const mcp = fakeMcp({
      openart_model_list: () => listOf(vid("tween-pro"), vid("plain-vid"), { model: "picasso", displayName: "Picasso", media: ["image"] }),
      openart_model_form_get: (args) => formWith(args.model === "tween-pro" ? { lastFrame: { type: "object", properties: {} } } : {}),
    });
    const ids = await new OpenArtClient(mcp).videoEndFrameModels();
    expect(ids).toEqual(["tween-pro"]);
  });

  it("returns [] when the model list itself fails", async () => {
    const mcp = fakeMcp({ openart_model_list: () => { throw new Error("down"); } });
    expect(await new OpenArtClient(mcp).videoEndFrameModels()).toEqual([]);
  });
});