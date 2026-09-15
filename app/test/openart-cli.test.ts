/**
 * OpenArtCliProvider tests — the module's interface IS the test surface.
 *
 * The subprocess is injected, so a fake `run` substitutes for the live
 * `openart` binary. Fixtures use the MCP backend's documented vocabulary
 * (the CLI fronts the same API: model items with media/modes, form replies
 * with `jsonSchema.properties`) plus the CLI's own contract proven by
 * `--dry-run` (`--image` repeatable → visualReferences; video takes one
 * start frame; `--async` prints the creation id). fetch is stubbed for
 * result downloads; scripting.js is mocked so pipeline.ts loads.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  OpenArtCliProvider,
  openArtCliRawId,
  OPENART_CLI_ID_PREFIX,
} from "../src/main/providers/openart-cli.js";
import type { CliRun } from "../src/main/providers/cli-run.js";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

type FakeRun = CliRun;

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-openart-cli-${process.pid}-${Date.now()}` };
});

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

// ---- fake runner ------------------------------------------------------------

type Handler = (args: string[]) => { code: number | null; stdout: string; stderr: string } | Promise<{ code: number | null; stdout: string; stderr: string }>;

function fakeRun(handler: Handler): { run: FakeRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: FakeRun = async (args) => {
    calls.push(args);
    return handler(args);
  };
  return { run, calls };
}

const ok = (stdout: string) => ({ code: 0 as const, stdout, stderr: "" });
const fail = (stderr: string) => ({ code: 1 as const, stdout: "", stderr });

const MODEL_LIST = JSON.stringify([
  { model: "nano-banana-2", displayName: "Nano Banana 2", media: ["image"], modes: { image: [{ mode: "text2image" }, { mode: "image2image" }] } },
  { model: "kling-3-omni", displayName: "Kling 3 Omni", media: ["image"], modes: { video: [{ mode: "text2video" }, { mode: "image2video" }] } },
  { model: "gpt-image-2", displayName: "GPT Image 2", media: ["image"], modes: { image: [{ mode: "text2image" }] } },
]);

const imageForm = () =>
  JSON.stringify({
    jsonSchema: {
      properties: {
        prompt: { type: "string" },
        aspectRatio: { type: "string", enum: ["16:9", "1:1"] },
        visualReferences: { type: "array", items: { type: "object" } },
      },
    },
  });

const videoForm = () =>
  JSON.stringify({
    jsonSchema: {
      properties: {
        prompt: { type: "string" },
        startFrame: { type: "object", properties: { type: {}, url: {} } },
        resolution: { type: "string", enum: ["720p", "1080p"] },
        duration: { type: "string", enum: ["5s", "10s"] },
      },
    },
  });

/** Default fake: model list/forms/costs/account/projects. Generate and
 *  creation commands match on the verb (their args carry prompts/ids). */
function baseHandler(extra: Record<string, Handler> = {}): Handler {
  return (args) => {
    const verb = args.slice(0, 2).join(" ");
    if (extra[verb]) return extra[verb](args);
    const key = `${verb} ${args[2] ?? ""}`.trim();
    if (extra[key]) return extra[key](args);
    if (verb === "model list") return ok(MODEL_LIST);
    if (verb === "model form") {
      if (args[2] === "kling-3-omni") return ok(videoForm());
      return ok(imageForm());
    }
    if (verb === "model cost") {
      return ok(JSON.stringify([
        { model: "nano-banana-2", mode: "text2image", totalCredits: 3 },
        { model: "kling-3-omni", mode: "image2video", totalCredits: 120 },
      ]));
    }
    if (verb === "account --json" || (args[0] === "account" && args.length === 2)) {
      void verb;
      return ok(JSON.stringify({ credits: 250 }));
    }
    if (args[0] === "account") return ok(JSON.stringify({ credits: 250 }));
    if (verb === "project list") return ok(JSON.stringify([{ id: "proj-1", name: "Test Production" }]));
    if (verb === "project create") return ok(JSON.stringify({ id: "proj-9", name: "Test Production" }));
    throw new Error(`No fake handler for openart args "${args.join(" ")}"`);
  };
}

function provider(run: FakeRun, binary: string | null = "openart"): OpenArtCliProvider {
  return new OpenArtCliProvider({ binary: () => binary, run });
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

describe("openArtCliRawId / isAvailable", () => {
  it("strips the CLI prefix and reports binary presence", () => {
    expect(openArtCliRawId(`${OPENART_CLI_ID_PREFIX}nano-banana-2`)).toBe("nano-banana-2");
    expect(openArtCliRawId("nano-banana-2")).toBe("nano-banana-2");
    const { run } = fakeRun(baseHandler());
    expect(provider(run, "openart").isAvailable()).toBe(true);
    expect(provider(run, null).isAvailable()).toBe(false);
    expect(provider(run, null).imageGenFn(makeProduction())).toBeNull();
  });
});

describe("OpenArtCliProvider.listModelChoices", () => {
  it("shapes the shared OpenArt vocabulary, namespaced, with cost overlay", async () => {
    const { run } = fakeRun(baseHandler());
    const p = provider(run);
    const choices = await p.listModelChoices();
    expect(choices.map((c) => c.id)).toEqual([
      `${OPENART_CLI_ID_PREFIX}nano-banana-2`,
      `${OPENART_CLI_ID_PREFIX}kling-3-omni`,
      `${OPENART_CLI_ID_PREFIX}gpt-image-2`,
    ]);
    expect(choices[0]).toMatchObject({ imageInput: true, videoInput: false });
    expect(choices[1]).toMatchObject({ imageInput: true, videoInput: true });
    // Costs warm in the background (never blocking the dropdown); a second
    // listing picks them up from the cache.
    await (p as unknown as { warmCosts: () => Promise<void> }).warmCosts();
    const again = await p.listModelChoices();
    expect(again[0].cost).toBe(3);
    expect(again[1].cost).toBe(120);
    expect(again[2].cost).toBeNull();
  });
});

describe("OpenArtCliProvider.getCredits", () => {
  it("reads the signed-in account's credit balance", async () => {
    const { run } = fakeRun(baseHandler());
    expect(await provider(run).getCredits()).toBe(250);
  });

  it("returns null when account fails", async () => {
    const { run } = fakeRun(() => fail("not logged in"));
    expect(await provider(run).getCredits()).toBeNull();
  });
});

describe("OpenArtCliProvider.videoModelOptions", () => {
  it("resolves resolutions/durations from the model form", async () => {
    const { run } = fakeRun(baseHandler());
    const o = await provider(run).videoModelOptions(`${OPENART_CLI_ID_PREFIX}kling-3-omni`, true);
    expect(o).toEqual({ resolutions: ["720p", "1080p"], durations: [5, 10] });
  });

  it("returns null for foreign ids", async () => {
    const { run } = fakeRun(baseHandler());
    expect(await provider(run).videoModelOptions("higgsfield:seedance_2_5", true)).toBeNull();
    expect(await provider(run).videoModelOptions("auto", true)).toBeNull();
  });
});

describe("OpenArtCliProvider.imageModelOptions / videoEndFrameModels", () => {
  it("declares no quality tiers and no end-frame slot (CLI v0.1.1 limits)", async () => {
    const { run } = fakeRun(baseHandler());
    const p = provider(run);
    expect(await p.imageModelOptions(`${OPENART_CLI_ID_PREFIX}nano-banana-2`)).toBeNull();
    expect(await p.videoEndFrameModels()).toEqual([]);
  });
});

describe("OpenArtCliProvider.modelOptions", () => {
  it("builds a schema from the model form (first parsing mode wins)", async () => {
    const { run } = fakeRun(baseHandler());
    const p = provider(run);
    const s = await p.modelOptions(`${OPENART_CLI_ID_PREFIX}nano-banana-2`);
    expect(s).not.toBeNull();
    const byFlag = (f: string) => s!.fields.find((x) => x.flag === f);
    expect(byFlag("aspectRatio")!.values).toEqual(["16:9", "1:1"]);
    expect(s!.aspectRatios).toEqual(["16:9", "1:1"]);
    expect(await p.modelOptions("higgsfield:seedance_2_5")).toBeNull();
    expect(await p.modelOptions("auto")).toBeNull();
  });
});

describe("OpenArtCliProvider.imageGenFn", () => {
  it("submits with refs + project, waits, downloads, and records", async () => {
    const seen: string[][] = [];
    const { run } = fakeRun(
      baseHandler({
        "generate image": (args) => {
          seen.push(args.slice(2));
          return ok(JSON.stringify({ historyId: "h-img-1" }));
        },
        "creation wait": () =>
          ok(JSON.stringify({ historyId: "h-img-1", status: "SUCCEEDED", url: "https://example.invalid/frame.png" })),
      })
    );
    const onGeneration = vi.fn();
    const notices: string[] = [];
    const p = new OpenArtCliProvider({ binary: () => "openart", run, recorder: { onGeneration } });
    const gen = p.imageGenFn(
      makeProduction({ openArt: { model: `${OPENART_CLI_ID_PREFIX}nano-banana-2`, resolution: "2k" } }),
      undefined, undefined, (m) => notices.push(m), "16:9"
    )!;
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([4, 4]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      const out = await gen("A castle", [{ name: "Hero", dataUrl: "data:image/png;base64,SGVsbG8=" }]);
      expect(out).toEqual(Buffer.from([4, 4]));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toHaveLength(1);
    const args = seen[0];
    expect(args.slice(0, 3)).toEqual(["A castle", "--model", "nano-banana-2"]);
    expect(args).toContain("--async");
    expect(args).toContain("--project");
    const imageIdx = args.indexOf("--image");
    expect(imageIdx).toBeGreaterThan(-1);
    expect(args[imageIdx + 1]).toMatch(/\.png$/);
    expect(notices.some((n) => /model's default size/.test(n))).toBe(true);
    expect(onGeneration).toHaveBeenCalledWith({
      kind: "image",
      model: `${OPENART_CLI_ID_PREFIX}nano-banana-2`,
      resolution: "2k",
      aspectRatio: "16:9",
      at: expect.any(Number),
      productionId: "prod-1",
      shotId: undefined,
    });
  });

  it("records a pending job when the wait outlives the cap, then a recheck reclaims it", async () => {
    let finished = false;
    const { run } = fakeRun(
      baseHandler({
        "generate image": () => ok(JSON.stringify({ historyId: "h-slow" })),
        "creation wait": () => ok(JSON.stringify({ historyId: "h-slow", status: "RUNNING" })),
        "creation get": () =>
          finished
            ? ok(JSON.stringify({ historyId: "h-slow", status: "SUCCEEDED", url: "https://example.invalid/late.png" }))
            : ok(JSON.stringify({ historyId: "h-slow", status: "RUNNING" })),
      })
    );
    const p = provider(run);
    const gen = p.imageGenFn(makeProduction())!;
    const shot: ProductionShot = { id: "s1", number: "0100", audio: "", visual: "" };
    await expect(gen("A castle", [], shot)).rejects.toThrow(/timed out/i);
    expect(shot.pendingImageGen).toMatchObject({ historyId: "h-slow", prompt: "A castle" });
    await expect(p.recheckPendingImage(shot.pendingImageGen!)).resolves.toBeNull();
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

  it("rejects foreign and stale explicit picks instead of billing the wrong model", async () => {
    const { run } = fakeRun(baseHandler());
    const p = provider(run);
    await expect(p.imageGenFn(makeProduction({ openArt: { model: "higgsfield:seedance_2_5", resolution: "1k" } }))!("x", []))
      .rejects.toThrow(/Higgsfield pick/);
    await expect(p.imageGenFn(makeProduction({ openArt: { model: "nope-gone", resolution: "1k" } }))!("x", []))
      .rejects.toThrow(/isn't an OpenArt model/);
  });

  it("throws a login hint when the CLI reports signed-out", async () => {
    const { run } = fakeRun(() => fail("error: not logged in — run `openart login`"));
    await expect(provider(run).imageGenFn(makeProduction())!("x", [])).rejects.toThrow(/openart login/);
  });
});

describe("OpenArtCliProvider.generateVideoClip", () => {
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

  it("animates a single start frame with duration/resolution/aspect flags and records", async () => {
    const seen: string[][] = [];
    const { run } = fakeRun(
      baseHandler({
        "generate video": (args) => {
          seen.push(args.slice(2));
          return ok(JSON.stringify({ historyId: "h-vid-1" }));
        },
        "creation wait": () =>
          ok(JSON.stringify({ historyId: "h-vid-1", status: "SUCCEEDED", video_url: "https://example.invalid/clip.mp4" })),
      })
    );
    const onGeneration = vi.fn();
    const p = new OpenArtCliProvider({ binary: () => "openart", run, recorder: { onGeneration } });
    const prod = prodDir("prod-vid");
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([7, 7]).buffer as ArrayBuffer,
    }) as unknown as typeof fetch;
    try {
      const { rel } = await p.generateVideoClip(prod, shot(), {
        model: `${OPENART_CLI_ID_PREFIX}kling-3-omni`, resolution: "1080p", durationSec: 10, prompt: "animate",
      }, () => {});
      expect(rel).toContain("shot-0100-");
      expect(fs.existsSync(path.join(prod.meta.folder, rel))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
    const args = seen[0];
    expect(args.slice(0, 3)).toEqual(["animate", "--model", "kling-3-omni"]);
    expect(args[args.indexOf("--image") + 1]).toMatch(/\.jpg$/);
    expect(args[args.indexOf("--duration") + 1]).toBe("10");
    expect(args[args.indexOf("--resolution") + 1]).toBe("1080p");
    expect(args[args.indexOf("--aspect-ratio") + 1]).toBe("16:9");
    expect(onGeneration).toHaveBeenCalledWith({
      kind: "video",
      model: `${OPENART_CLI_ID_PREFIX}kling-3-omni`,
      resolution: "1080p",
      durationSec: 10,
      at: expect.any(Number),
      productionId: "prod-1",
      shotId: "s1",
    });
  });

  it("fails loudly on unsupported lengths instead of coercing", async () => {
    let submitted = false;
    const { run } = fakeRun(
      baseHandler({
        "generate video": () => {
          submitted = true;
          return ok(JSON.stringify({ historyId: "x" }));
        },
      })
    );
    await expect(
      provider(run).generateVideoClip(prodDir("prod-short"), shot(), {
        model: `${OPENART_CLI_ID_PREFIX}kling-3-omni`, resolution: "1080p", durationSec: 2, prompt: "animate",
      }, () => {})
    ).rejects.toThrow(/doesn't support a 2s clip \(supports 5, 10s\)/);
    expect(submitted).toBe(false);
  });

  it("redirects end frames, extra references, and video references to the MCP transport", async () => {
    const { run } = fakeRun(baseHandler());
    const p = provider(run);
    const prod = prodDir("prod-limits");
    const s = shot();
    await expect(p.generateVideoClip(prod, s, {
      model: `${OPENART_CLI_ID_PREFIX}kling-3-omni`, resolution: "720p", durationSec: 5, prompt: "tween",
    }, () => {}, undefined, undefined, {
      start: { name: "A", dataUrl: "data:image/png;base64,QQ==" },
      end: { name: "B", dataUrl: "data:image/png;base64,Qg==" },
    })).rejects.toThrow(/can't send an end frame.*OpenArt MCP/);
    await expect(p.generateVideoClip(prod, s, {
      model: `${OPENART_CLI_ID_PREFIX}kling-3-omni`, resolution: "720p", durationSec: 5, prompt: "animate @[Clip]",
    }, () => {}, undefined, [{ name: "Clip", dataUrl: "data:image/png;base64,Q2xpcA==" }]))
      .rejects.toThrow(/single start-frame image/);
    await expect(p.generateVideoClip(prod, s, {
      model: `${OPENART_CLI_ID_PREFIX}kling-3-omni`, resolution: "720p", durationSec: 5, prompt: "animate",
    }, () => {}, undefined, [{ name: "V", dataUrl: "data:video/mp4;base64,Vmlk" }]))
      .rejects.toThrow(/can't send video references/);
  });
});
