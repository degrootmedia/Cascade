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
import { OpenArtClient, videoRefsAssign } from "../src/main/providers/openart.js";
import { openArtCreationResultUrls, openArtCreationStatus } from "../src/main/providers/openart-core.js";
import { VIDEO_REF_MAX_HEIGHT, resizeVideoRef } from "../src/main/video-ref.js";
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

  it("parses the media-keyed `modes` object (real shape) and captures video-mode spellings", async () => {
    const mcp = fakeMcp({
      openart_model_list: () =>
        JSON.stringify([
          {
            id: "wan2-7-image",
            displayName: "Wan 2.7 Image",
            // Real entries warn about the video siblings in the description.
            description: "Wan 2.7 Image - strongest on in-image text. Note this is the IMAGE model; the separately-listed Wan 2.7 and Wan 3.0 are video.",
            modes: { image: [{ mode: "text2image" }, { mode: "image2image" }] },
          },
          {
            id: "gemini-omni-flash",
            displayName: "Gemini Omni Flash",
            description: "Text-, image-, and reference/element-to-video.",
            modes: { video: [{ mode: "text2video" }, { mode: "image2video" }, { mode: "element2video" }] },
          },
        ]),
    });
    const choices = await new OpenArtClient(mcp).listModelChoices();
    expect(choices.find((c) => c.id === "wan2-7-image")).toMatchObject({ videoInput: false });
    expect(choices.find((c) => c.id === "gemini-omni-flash")).toMatchObject({
      videoInput: true,
      videoModes: ["text2video", "image2video", "element2video"],
    });
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

describe("OpenArtClient.modelOptions", () => {
  it("builds a schema from the live form and rejects foreign ids", async () => {
    const mcp = fakeMcp({
      openart_model_form_get: () =>
        JSON.stringify({
          jsonSchema: {
            properties: {
              prompt: { type: "string" },
              aspect_ratio: { type: "string", enum: ["16:9", "9:16"] },
              resolution: { type: "string", enum: ["720p", "1080p"] },
              cfg_scale: { type: "number", enum: [1, 2, 3] },
            },
          },
        }),
    });
    const s = await new OpenArtClient(mcp).modelOptions("some-model");
    expect(s).not.toBeNull();
    expect(s!.aspectRatios).toEqual(["16:9", "9:16"]);
    const byFlag = (f: string) => s!.fields.find((x) => x.flag === f);
    expect(byFlag("resolution")!.values).toEqual(["720p", "1080p"]);
    expect(byFlag("cfg_scale")!.group).toBe("control");
    expect(await new OpenArtClient(mcp).modelOptions("higgsfield:seedance_2_5")).toBeNull();
    expect(await new OpenArtClient(mcp).modelOptions("auto")).toBeNull();
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

  it("resolves a dropped video reference only when includeVideo is on", () => {
    const folder = path.join(dataDir, "refs-video");
    fs.mkdirSync(path.join(folder, "references"), { recursive: true });
    fs.writeFileSync(path.join(folder, "references", "clip.mp4"), Buffer.from("mp4-bytes"));
    const p = makeProduction({
      meta: { id: "prod-1", name: "Test Production", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
      references: [{ id: "r1", name: "Clip", media: "video", mediaPath: "references/clip.mp4" }],
    });
    // Video generation opts in: the clip resolves from disk as a video data URL.
    const video = resolvePromptRefs(p, "follow @[Clip]", 0, true);
    expect(video.resolved).toBe("follow @image1");
    expect(video.extras).toEqual([
      { name: "Clip", dataUrl: `data:video/mp4;base64,${Buffer.from("mp4-bytes").toString("base64")}` },
    ]);
    // Image generation leaves it off: the tag is unresolved and nothing uploads.
    const image = resolvePromptRefs(p, "follow @[Clip]", 0);
    expect(image.resolved).toBe("follow @[Clip]");
    expect(image.extras).toEqual([]);
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
    expect(videoRefsAssign(refs, props, { frames: true })).toEqual({
      startFrame: { type: "image", label: "Shot 0100 frame", url: "https://example.invalid/frame.png", id: "vr-1" },
    });
  });

  it("maps conventional url aliases (access_url, src) to the reference url", () => {
    const refs = [{ url: "https://example.invalid/f.png" }];
    const props = { startFrame: { type: "object", properties: { access_url: { type: "string" } } } };
    expect(videoRefsAssign(refs, props, { frames: true })).toEqual({ startFrame: { access_url: "https://example.invalid/f.png" } });
  });

  it("falls back to the whole reference when no sub-field maps", () => {
    const refs = [{ type: "image", label: "Frame", url: "https://example.invalid/f.png" }];
    const props = { startFrame: { type: "object", properties: { raw: { type: "string" } } } };
    expect(videoRefsAssign(refs, props, { frames: true })).toEqual({ startFrame: refs[0] });
  });

  it("uses array-style visualReferences for array fields", () => {
    const refs = [{ url: "https://example.invalid/a.png" }];
    const props = { visualReferences: { type: "array", items: { type: "object" } } };
    expect(videoRefsAssign(refs, props)).toEqual({ visualReferences: refs });
  });

  it("finds non-visualReferences array field spellings", () => {
    const refs = [{ url: "https://example.invalid/a.png" }];
    expect(videoRefsAssign(refs, { referenceImages: { type: "array", items: {} } })).toEqual({ referenceImages: refs });
    expect(videoRefsAssign(refs, { refImages: { type: "array", items: {} } })).toEqual({ refImages: refs });
    expect(videoRefsAssign(refs, { media: { type: "array", items: {} } })).toEqual({ media: refs });
    expect(videoRefsAssign(refs, { inputImages: { type: "array", items: {} } })).toEqual({ inputImages: refs });
  });

  it("does not mistake the singular start-frame object for the reference array", () => {
    const refs = [{ type: "image", url: "https://example.invalid/f.png" }];
    const props = { referenceImage: { type: "object", properties: { url: { type: "string" } } } };
    expect(videoRefsAssign(refs, props)).toEqual({ referenceImage: { url: "https://example.invalid/f.png" } });
  });

  it("normal flows fill the required start frame but never an end frame, and bind all refs as references", () => {
    // image2video forms mark startFrame required, so normal generation must
    // fill it with the source frame — but it must NOT drop the second reference
    // into endFrame (that shape is reserved for the in-betweener). Every ref
    // rides visualReferences so video clips upload and positions stay aligned.
    const refs = [
      { type: "image", label: "Shot 0100 frame", url: "https://example.invalid/frame.png", id: "vr-1" },
      { type: "video", label: "Clip", url: "https://example.invalid/clip.mp4", id: "vr-2" },
    ];
    const props = {
      startFrame: { type: "object", properties: { type: {}, url: {}, id: {} } },
      endFrame: { type: "object", properties: { type: {}, url: {}, id: {} } },
      visualReferences: { type: "array", items: { type: "object" } },
    };
    expect(videoRefsAssign(refs, props)).toEqual({
      startFrame: { type: "image", url: "https://example.invalid/frame.png", id: "vr-1" },
      visualReferences: refs,
    });
  });
});

describe("video-ref 720p ceiling", () => {
  it("caps every video reference at 720p regardless of model", () => {
    expect(VIDEO_REF_MAX_HEIGHT).toBe(720);
  });

  it("resizeVideoRef is the single-arg 720p wrapper", async () => {
    // Non-video input passes through untouched.
    await expect(resizeVideoRef("data:image/png;base64,eA==")).resolves.toBe("data:image/png;base64,eA==");
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

  it("fails loudly on a stale image pick instead of generating on another model", async () => {
    let submitted = false;
    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "m", media: ["image"], modes: [] }]),
      openart_model_form_get: () => JSON.stringify({ jsonSchema: { properties: {} } }),
      openart_generate_image: () => { submitted = true; return '{"status":"PENDING","historyId":"h-x","pollAfterSeconds":0}'; },
    });
    const gen = new OpenArtClient(mcp).imageGenFn(makeProduction(), "stale-openart-id")!;
    await expect(gen("any", [])).rejects.toThrow(/isn't an OpenArt model/);
    expect(submitted).toBe(false);
  });

  it("emits a submit notice naming the resolved model + mode", async () => {
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
      openart_generate_image: () => '{"status":"PENDING","historyId":"h-notice","pollAfterSeconds":0}',
      openart_creation_wait: () => ({ text: '{"status":"SUCCEEDED"}', images: [Buffer.from("notice-jpeg")] }),
    });
    const notices: string[] = [];
    const gen = new OpenArtClient(mcp).imageGenFn(makeProduction(), undefined, undefined, (m) => { notices.push(m); })!;
    await gen("Draw a castle", []);
    expect(notices.some((m) => /Submitting image job via kling-v2/.test(m))).toBe(true);
    expect(notices.some((m) => /mode=text2image/.test(m))).toBe(true);
  });

  it("imageModelOptions returns null (quality rides the resolution tier)", async () => {
    const client = new OpenArtClient(fakeMcp({}));
    await expect(client.imageModelOptions("kling-v2")).resolves.toBeNull();
    await expect(client.imageModelOptions("higgsfield:seedance_2_5")).resolves.toBeNull();
  });

  it("never downloads an echoed reference URL while the job is still rendering", async () => {
    // The creation reply carries the uploaded reference in its params. A slow
    // job (the camera grid) used to have that reference URL downloaded as the
    // finished sheet on the first RUNNING poll.
    let polls = 0;
    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "m", media: ["image"], modes: [] }]),
      openart_model_form_get: () => JSON.stringify({ jsonSchema: { properties: { visualReferences: { type: "array" } } } }),
      openart_upload_sign: () =>
        JSON.stringify({ signURL: "https://example.invalid/sign", visualReference: { id: "vr-1", url: "https://example.invalid/source.png" } }),
      openart_generate_image: () => '{"status":"PENDING","historyId":"h-cg","pollAfterSeconds":0}',
      openart_creation_wait: () => {
        polls++;
        return polls === 1
          ? { text: '{"status":"STILL_RUNNING","pollAfterSeconds":0,"params":{"visualReferences":[{"url":"https://example.invalid/source.png"}]}}', images: [], uris: [] }
          : { text: '{"status":"SUCCEEDED","urls":["https://example.invalid/out.png"]}', images: [], uris: [] };
      },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string) => ({
      ok: true,
      arrayBuffer: async () => Buffer.from(String(url).includes("out.png") ? "OUTPUT" : "SOURCE"),
    })) as unknown as typeof fetch;
    try {
      const gen = new OpenArtClient(mcp).imageGenFn(makeProduction())!;
      const out = await gen("16 angles of the same scene", [
        { name: "Source", dataUrl: "data:image/png;base64,U09VUkNF" },
      ]);
      expect(out.toString()).toBe("OUTPUT");
      expect(polls).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("prefers the result URL over an echoed reference URL on completion", async () => {
    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "m", media: ["image"], modes: [] }]),
      openart_model_form_get: () => JSON.stringify({ jsonSchema: { properties: { visualReferences: { type: "array" } } } }),
      openart_upload_sign: () =>
        JSON.stringify({ signURL: "https://example.invalid/sign", visualReference: { id: "vr-1", url: "https://example.invalid/source.png" } }),
      openart_generate_image: () => '{"status":"PENDING","historyId":"h-done","pollAfterSeconds":0}',
      openart_creation_wait: () => ({
        text: '{"status":"SUCCEEDED","params":{"visualReferences":[{"url":"https://example.invalid/source.png"}]},"results":[{"url":"https://example.invalid/out.png"}]}',
        images: [],
        uris: [],
      }),
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string) => ({
      ok: true,
      arrayBuffer: async () => Buffer.from(String(url).includes("out.png") ? "OUTPUT" : "SOURCE"),
    })) as unknown as typeof fetch;
    try {
      const gen = new OpenArtClient(mcp).imageGenFn(makeProduction())!;
      const out = await gen("16 angles of the same scene", [
        { name: "Source", dataUrl: "data:image/png;base64,U09VUkNF" },
      ]);
      expect(out.toString()).toBe("OUTPUT");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("excludes an echoed input image attachment and returns the generated image", async () => {
    const source = Buffer.from("SOURCE-INPUT-BYTES");
    const output = Buffer.from("GENERATED-OUTPUT");
    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "nano-banana-2", displayName: "Nano Banana 2", media: ["image"], modes: [] }]),
      openart_model_form_get: () => JSON.stringify({ jsonSchema: { properties: { visualReferences: { type: "array" } } } }),
      openart_upload_sign: () =>
        JSON.stringify({ signURL: "https://example.invalid/sign", visualReference: { id: "vr-1", url: "https://example.invalid/source.png" } }),
      openart_generate_image: () => '{"status":"PENDING","historyId":"h-echo","pollAfterSeconds":0}',
      // The completion reply echoes the uploaded input FIRST, then the result.
      openart_creation_wait: () => ({ text: '{"status":"SUCCEEDED"}', images: [source, output], uris: [] }),
    });
    const gen = new OpenArtClient(mcp).imageGenFn(makeProduction())!;
    const out = await gen("edit it", [{ name: "Source", dataUrl: `data:image/png;base64,${source.toString("base64")}` }]);
    expect(out.toString()).toBe("GENERATED-OUTPUT");
  });

  it("reads an extension-less result URL before an echoed input image", async () => {
    const source = Buffer.from("SOURCE-INPUT-BYTES");
    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "nano-banana-2", displayName: "Nano Banana 2", media: ["image"], modes: [] }]),
      openart_model_form_get: () => JSON.stringify({ jsonSchema: { properties: { visualReferences: { type: "array" } } } }),
      openart_upload_sign: () =>
        JSON.stringify({ signURL: "https://example.invalid/sign", visualReference: { id: "vr-1", url: "https://example.invalid/source.png" } }),
      openart_generate_image: () => '{"status":"PENDING","historyId":"h-noext","pollAfterSeconds":0}',
      openart_creation_wait: () => ({
        text: '{"status":"SUCCEEDED","results":[{"url":"https://cdn.example.invalid/job/abc123"}]}',
        images: [source],
        uris: [],
      }),
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string) => ({
      ok: true,
      arrayBuffer: async () => Buffer.from(String(url).includes("cdn.example.invalid") ? "GENERATED-OUTPUT" : "SOURCE-INPUT-BYTES"),
    })) as unknown as typeof fetch;
    try {
      const gen = new OpenArtClient(mcp).imageGenFn(makeProduction())!;
      const out = await gen("edit it", [{ name: "Source", dataUrl: `data:image/png;base64,${source.toString("base64")}` }]);
      expect(out.toString()).toBe("GENERATED-OUTPUT");
    } finally {
      globalThis.fetch = realFetch;
    }
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

  it("fails loudly on a stale video pick instead of billing another model", async () => {
    const folder = path.join(dataDir, "prod-stale-video");
    fs.mkdirSync(path.join(folder, "boards"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards", "shot-0100.jpg"), Buffer.from("jpeg-bytes"));
    let submitted = false;
    const mcp = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "veo-3", displayName: "Veo 3", media: ["image"], modes: ["video"] }]),
      openart_generate_video: () => { submitted = true; return '{"status":"PENDING","historyId":"h-x","pollAfterSeconds":0}'; },
    });
    const client = new OpenArtClient(mcp);
    const prod = makeProduction({
      meta: { id: "prod-1", name: "Test Production", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    });
    const shot: ProductionShot = { id: "s1", number: "0100", audio: "", visual: "", artwork: "boards/shot-0100.jpg" };
    await expect(
      client.generateVideoClip(prod, shot, { model: "higgsfield:seedance_2_5", resolution: "1080p", durationSec: 5, prompt: "animate" }, () => {})
    ).rejects.toThrow(/isn't an OpenArt model/);
    expect(submitted).toBe(false);
  });

  it("uploads video references in normal generation without setting an end frame", async () => {
    const folder = path.join(dataDir, "prod-videorefs");
    fs.mkdirSync(path.join(folder, "boards"), { recursive: true });
    fs.mkdirSync(path.join(folder, "references"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards", "shot-0100.jpg"), Buffer.from("jpeg-bytes"));
    fs.writeFileSync(path.join(folder, "references", "clip.mp4"), Buffer.from("mp4-bytes"));
    let seenParams: Record<string, unknown> | undefined;
    const signCalls: Record<string, unknown>[] = [];
    const resizeCalls: { dataUrl: string }[] = [];
    const base = fakeMcp({
      openart_model_list: () => JSON.stringify([{ model: "veo-3", displayName: "Veo 3", media: ["image"], modes: ["video"] }]),
      openart_model_form_get: () =>
        JSON.stringify({
          jsonSchema: {
            properties: {
              startFrame: { type: "object", properties: { type: {}, url: {}, id: {} } },
              endFrame: { type: "object", properties: { type: {}, url: {}, id: {} } },
              visualReferences: { type: "array", items: { type: "object" } },
              duration: { type: "string", enum: ["5s", "10s"] },
            },
          },
        }),
      openart_upload_sign: (args) => {
        signCalls.push(args);
        return JSON.stringify({ signURL: "https://example.invalid/sign", visualReference: { id: `vr-${signCalls.length}`, url: "https://example.invalid/vr" } });
      },
      openart_generate_video: () => '{"status":"PENDING","historyId":"h-vid","pollAfterSeconds":0}',
      openart_creation_wait: () => ({ text: '{"status":"SUCCEEDED"}', images: [Buffer.from("fake-mp4")] }),
    });
    const orig = base.callRawFull.bind(base);
    (base as { callRawFull: unknown }).callRawFull = async (s: string, t: string, a: Record<string, unknown>) => {
      if (t === "openart_generate_video") seenParams = (a as { params: Record<string, unknown> }).params;
      return orig(s, t, a);
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    try {
      const client = new OpenArtClient(base, undefined, async (dataUrl) => {
        resizeCalls.push({ dataUrl });
        return dataUrl;
      });
      const prod = makeProduction({
        meta: { id: "prod-1", name: "Test Production", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
        references: [{ id: "r1", name: "Clip", media: "video", mediaPath: "references/clip.mp4" }],
      });
      const shot: ProductionShot = { id: "s1", number: "0100", audio: "", visual: "", artwork: "boards/shot-0100.jpg" };
      await client.generateVideoClip(
        prod, shot, { model: "auto", resolution: "1080p", durationSec: 5, prompt: "animate @[Clip]" }, () => {}
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    // The start frame is filled (image2video requires it), the cited video clip
    // rides visualReferences, and no end frame is set outside the in-betweener.
    expect(seenParams?.startFrame).toMatchObject({ type: "image" });
    expect(seenParams?.endFrame).toBeUndefined();
    expect(seenParams?.visualReferences).toHaveLength(2);
    // The video reference was offered to the resizer (universal 720p ceiling).
    expect(resizeCalls).toHaveLength(1);
    // The video clip is signed as a video, not mislabeled as a `.png` image.
    const videoSign = signCalls.find((c) => c.contentType === "video/mp4");
    expect(videoSign?.mediaType).toBe("video");
    expect(videoSign?.purpose).toBe("create-video");
    expect(String(videoSign?.filename)).toMatch(/\.mp4$/);
  });

  it("submits in the advertised element2video mode when refs are present", async () => {
    const folder = path.join(dataDir, "prod-omni");
    fs.mkdirSync(path.join(folder, "boards"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards", "shot-0100.jpg"), Buffer.from("jpeg-bytes"));
    let seenArgs: Record<string, unknown> | undefined;
    const base = fakeMcp({
      // Real model-list shape: `modes` is an object keyed by output media.
      openart_model_list: () => JSON.stringify([{
        model: "gemini-omni-flash",
        displayName: "Gemini Omni Flash",
        description: "Text-, image-, and reference/element-to-video.",
        modes: {
          video: [
            { mode: "text2video" },
            { mode: "image2video" },
            { mode: "element2video" },
          ],
        },
      }]),
      openart_model_form_get: (args) => {
        // image2video parses but declares no reference array; element2video is
        // the reference mode where the refs actually belong.
        if (args.mode === "image2video") {
          return JSON.stringify({ jsonSchema: { properties: { startFrame: { type: "object", properties: { url: {} } }, duration: { type: "string", enum: ["4s"] } } } });
        }
        if (args.mode === "element2video") {
          return JSON.stringify({ jsonSchema: { properties: { elements: { type: "array", items: {} }, elementTypes: { type: "array" }, duration: { type: "string", enum: ["4s"] } } } });
        }
        return JSON.stringify({ jsonSchema: { properties: {} } });
      },
      openart_upload_sign: () =>
        JSON.stringify({ signURL: "https://example.invalid/sign", visualReference: { id: "vr-x", url: "https://example.invalid/vr", type: "image" } }),
      openart_generate_video: () => '{"status":"PENDING","historyId":"h-omni","pollAfterSeconds":0}',
      openart_creation_wait: () => ({ text: '{"status":"SUCCEEDED"}', images: [Buffer.from("fake-mp4")] }),
    });
    const orig = base.callRawFull.bind(base);
    (base as { callRawFull: unknown }).callRawFull = async (s: string, t: string, a: Record<string, unknown>) => {
      if (t === "openart_generate_video") seenArgs = a;
      return orig(s, t, a);
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    try {
      const prod = makeProduction({
        meta: { id: "prod-1", name: "Test Production", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
        characters: [{ id: "c1", name: "Hero", key: "", artwork: "data:image/png;base64,SGVyby1hcnQ=" }],
      });
      const shot: ProductionShot = { id: "s1", number: "0100", audio: "", visual: "", artwork: "boards/shot-0100.jpg" };
      await new OpenArtClient(base).generateVideoClip(
        prod, shot, { model: "auto", resolution: "1080p", durationSec: 4, prompt: "animate @[Hero]" }, () => {}
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seenArgs?.mode).toBe("element2video");
    const params = seenArgs?.params as Record<string, unknown>;
    // The `elements` array carries the refs; `elementTypes` (a metadata array)
    // must not be mistaken for the reference field.
    expect(params.elements).toHaveLength(2);
    expect(params.elementTypes).toBeUndefined();
    expect(params.startFrame).toBeUndefined();
  });

  it("prefers a frame-slot mode for an in-betweener even when a refy mode parses first", async () => {
    const folder = path.join(dataDir, "prod-tween-mode");
    fs.mkdirSync(path.join(folder, "boards"), { recursive: true });
    fs.writeFileSync(path.join(folder, "boards", "shot-0100.jpg"), Buffer.from("jpeg-bytes"));
    let seenArgs: Record<string, unknown> | undefined;
    const base = fakeMcp({
      openart_model_list: () => JSON.stringify([{
        model: "tween-pro",
        displayName: "Tween Pro",
        modes: { video: [{ mode: "element2video" }, { mode: "image2video" }] },
      }]),
      openart_model_form_get: (args) => {
        // element2video: ref-array-only form — an in-between submitted here
        // would ride the array as plain references (the reported bug).
        if (args.mode === "element2video") {
          return JSON.stringify({ jsonSchema: { properties: { elements: { type: "array", items: {} }, duration: { type: "string", enum: ["4s"] } } } });
        }
        // image2video: dedicated start/end object slots, no reference array.
        return JSON.stringify({ jsonSchema: { properties: { startFrame: { type: "object", properties: { type: {}, url: {} } }, endFrame: { type: "object", properties: { type: {}, url: {} } }, duration: { type: "string", enum: ["4s"] } } } });
      },
      openart_upload_sign: () =>
        JSON.stringify({ signURL: "https://example.invalid/sign", visualReference: { id: "vr-x", url: "https://example.invalid/vr", type: "image" } }),
      openart_generate_video: () => '{"status":"PENDING","historyId":"h-tw","pollAfterSeconds":0}',
      openart_creation_wait: () => ({ text: '{"status":"SUCCEEDED"}', images: [Buffer.from("fake-mp4")] }),
    });
    const orig = base.callRawFull.bind(base);
    (base as { callRawFull: unknown }).callRawFull = async (s: string, t: string, a: Record<string, unknown>) => {
      if (t === "openart_generate_video") seenArgs = a;
      return orig(s, t, a);
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    try {
      const prod = makeProduction({
        meta: { id: "prod-1", name: "Test Production", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
      });
      const shot: ProductionShot = { id: "s1", number: "0100", audio: "", visual: "", artwork: "boards/shot-0100.jpg" };
      await new OpenArtClient(base).generateVideoClip(
        prod, shot, { model: "auto", resolution: "1080p", durationSec: 4, prompt: "turn around" }, () => {},
        undefined, [],
        { start: { name: "Start", dataUrl: "data:image/png;base64,c3RhcnQ=" }, end: { name: "End", dataUrl: "data:image/png;base64,ZW5k" } }
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seenArgs?.mode).toBe("image2video");
    const params = seenArgs?.params as Record<string, unknown>;
    expect(params.startFrame).toMatchObject({ type: "image" });
    expect(params.endFrame).toMatchObject({ type: "image" });
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

describe("openart-core creation grammar", () => {
  it("reads a nested creation status", () => {
    expect(openArtCreationStatus('{"data":{"status":"SUCCEEDED"}}')).toEqual({ status: "SUCCEEDED", failed: false });
    expect(openArtCreationStatus('{"status":"FAILED"}').failed).toBe(true);
    expect(openArtCreationStatus("no json here")).toEqual({ status: "", failed: false });
  });

  it("collects result URLs and never the echoed input/reference URLs", () => {
    const reply = JSON.stringify({
      status: "SUCCEEDED",
      params: { visualReferences: [{ url: "https://example.invalid/source.png" }] },
      results: [{ url: "https://example.invalid/out.png" }],
    });
    expect(openArtCreationResultUrls(reply, false)).toEqual(["https://example.invalid/out.png"]);
  });

  it("skips start/end frame inputs and falls back to a bare URL for non-JSON", () => {
    const reply = JSON.stringify({
      status: "SUCCEEDED",
      startFrame: { url: "https://example.invalid/start.png" },
      output: "https://example.invalid/done.png",
    });
    expect(openArtCreationResultUrls(reply, false)).toEqual(["https://example.invalid/done.png"]);
    expect(openArtCreationResultUrls("done: https://example.invalid/x.png", false)).toEqual(["https://example.invalid/x.png"]);
  });

  it("accepts an extension-less URL under an authoritative result key", () => {
    const reply = JSON.stringify({
      status: "SUCCEEDED",
      results: [{ url: "https://cdn.example.invalid/job/abc123" }],
    });
    expect(openArtCreationResultUrls(reply, false)).toEqual(["https://cdn.example.invalid/job/abc123"]);
  });

  it("still requires a media extension under an ambiguous key", () => {
    const reply = JSON.stringify({
      status: "SUCCEEDED",
      image: "https://cdn.example.invalid/job/abc123",
    });
    expect(openArtCreationResultUrls(reply, false)).toEqual([]);
  });
});