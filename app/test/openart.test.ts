/**
 * OpenArtClient tests — the module's interface IS the test surface.
 *
 * The McpManager is injected, so a fake substitutes for the live OpenArt MCP
 * server: canned tool replies drive the parsing, option-assignment, token-swap
 * and async-wait logic exactly as the real server would. Electron is mocked so
 * the pipeline module (nativeImage) loads in a plain node process.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTool } from "@core";
import type { McpManager } from "../src/main/mcp.js";
import { OpenArtClient, videoRefsAssign } from "../src/main/openart.js";
import type { Production } from "../src/shared/ipc.js";

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
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---- tests -----------------------------------------------------------------

describe("OpenArtClient.listModelChoices", () => {
  it("parses the model list, prepends Auto, and classifies image/video input + cost", async () => {
    const mcp = fakeMcp({
      openart_model_list: () =>
        JSON.stringify([
          { model: "foo-video", displayName: "Foo Video", media: ["image"], modes: ["video"] },
          { model: "bar-img", displayName: "Bar Img", media: ["image"], cost: 4 },
        ]),
    });
    const choices = await new OpenArtClient(mcp).listModelChoices();
    expect(choices).toHaveLength(3);
    expect(choices[0]).toMatchObject({ id: "auto", displayName: "Auto" });
    expect(choices[1]).toMatchObject({ id: "foo-video", imageInput: true, videoInput: true });
    expect(choices[2]).toMatchObject({ id: "bar-img", videoInput: false, cost: 4 });
  });

  it("tolerates fenced replies with stray prose", async () => {
    const mcp = fakeMcp({
      openart_model_list: () => '```json\n{ "models": [ { "id": "m1", "name": "M1" } ] }\n``` done',
    });
    const choices = await new OpenArtClient(mcp).listModelChoices();
    expect(choices).toHaveLength(2);
    expect(choices[1].id).toBe("m1");
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

  it("returns null for the auto placeholder", async () => {
    const mcp = fakeMcp({ openart_model_form_get: () => '{"jsonSchema":{"properties":{}}}' });
    expect(await new OpenArtClient(mcp).videoModelOptions("auto", true)).toBeNull();
  });
});

describe("OpenArtClient.resolvePromptRefs", () => {
  it("maps @[name] tags to portable tokens and dedupes the uploaded extras", () => {
    const p = makeProduction({
      characters: [{ id: "c1", name: "Gandalf", key: "", artwork: "data:image/png;base64,QUFBQQ==" }],
    });
    const client = new OpenArtClient(fakeMcp({}));
    const { resolved, extras } = client.resolvePromptRefs(p, "Show @[Gandalf] and @[gandalf] together", 2);
    expect(resolved).toBe("Show @image3 and @image3 together");
    expect(extras).toEqual([{ name: "Gandalf", dataUrl: "data:image/png;base64,QUFBQQ==" }]);
  });

  it("skips references that have no artwork", () => {
    const p = makeProduction({
      characters: [{ id: "c1", name: "Gandalf", key: "", artwork: "data:image/png;base64,QUFBQQ==" }],
      products: [{ id: "p1", name: "Empty" }],
    });
    const client = new OpenArtClient(fakeMcp({}));
    const { resolved, extras } = client.resolvePromptRefs(p, "Show @[Empty] and @[Gandalf]", 0);
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

  it("uploads references, swaps @imageN tokens for their uploaded ids, and runs in image2image mode", async () => {
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
      expect(params.prompt).toBe("Make it look like vr-1");
      expect(params.visualReferences).toEqual([{ id: "vr-1", url: "https://example.invalid/vr" }]);
    } finally {
      globalThis.fetch = realFetch;
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