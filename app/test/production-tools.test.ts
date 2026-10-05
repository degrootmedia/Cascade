/**
 * Production agent tools — the module's host seam IS the test surface.
 *
 * A fake `ProductionToolHost` records the operations the tools dispatch and
 * serves canned productions, so the tool layer is exercised without Electron,
 * IPC, or any generation.
 */
import { describe, it, expect, vi } from "vitest";
import { makeProductionAgentTools, productionDigest, type ProductionToolHost } from "../src/main/production-tools.js";
import type { Production, ProductionMeta } from "../src/shared/ipc.js";

function prod(over: Partial<Production> = {}): Production {
  return {
    meta: {
      id: "p1",
      name: "Test Film",
      folder: "C:/films/test-film",
      createdAt: "",
      updatedAt: "",
      stepDone: 1,
      shotCount: 2,
    } as ProductionMeta,
    currentStep: 1,
    visualStyle: "",
    styles: [],
    scenes: [],
    characters: [],
    products: [],
    references: [],
    status: {},
    ...over,
  } as Production;
}

function makeHost(over: Partial<ProductionToolHost> = {}): {
  host: ProductionToolHost;
  run: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn(async () => prod());
  const host: ProductionToolHost = {
    run: run as unknown as ProductionToolHost["run"],
    list: () => [],
    load: () => null,
    activeId: () => null,
    defaultParentFolder: () => "C:/Users/me/Documents",
    assemblyReport: () => ({ totalSec: 0, stills: [], blanks: [], suspiciousStills: [] }),
    ...over,
  };
  return { host, run };
}

const call = (tool: ReturnType<typeof makeProductionAgentTools>[string], args: Record<string, unknown>) =>
  tool.run(args, "");

describe("makeProductionAgentTools", () => {
  it("exposes the cascade_* tool surface", () => {
    const { host } = makeHost();
    const tools = makeProductionAgentTools(host);
    expect(Object.keys(tools).sort()).toEqual(
      [
        "cascade_assemble",
        "cascade_create_production",
        "cascade_generate_character_sheet",
        "cascade_generate_magic_prompts",
        "cascade_generate_storyboard",
        "cascade_generate_style_frame",
        "cascade_generate_video",
        "cascade_import_production",
        "cascade_ingest_script",
        "cascade_list_models",
        "cascade_list_productions",
        "cascade_model_options",
        "cascade_plan_animatic",
        "cascade_recheck_video",
        "cascade_set_shot_prompt",
        "cascade_set_style",
      ].sort()
    );
    // Reads are ungated; every mutating tool goes through approval.
    expect(tools.cascade_list_productions.requiresApproval).toBe(false);
    expect(tools.cascade_create_production.requiresApproval).toBe(true);
    expect(tools.cascade_generate_video.requiresApproval).toBe(true);
  });

  it("lists productions with the active flag", async () => {
    const { host } = makeHost({
      list: () => [prod().meta],
      activeId: () => "p1",
    });
    const out = await call(makeProductionAgentTools(host).cascade_list_productions, {});
    const parsed = JSON.parse(String(out));
    expect(parsed.activeProductionId).toBe("p1");
    expect(parsed.productions[0]).toMatchObject({ id: "p1", active: true });
  });

  it("returns a production digest when an id is given", async () => {
    const p = prod({
      styles: [{ id: "s1", index: 1, name: "Noir", prompt: "x", imagePath: "styles/s1.png" }],
      scenes: [{ number: 1, title: "Open", shots: [] }],
    });
    const { host } = makeHost({ load: () => p });
    const out = await call(makeProductionAgentTools(host).cascade_list_productions, { productionId: "p1" });
    const parsed = JSON.parse(String(out));
    expect(parsed.name).toBe("Test Film");
    expect(parsed.style).toMatchObject({ id: "s1", hasFrame: true });
    expect(parsed.scenes[0]).toMatchObject({ number: 1, shotCount: 0 });
  });
});

describe("productionDigest", () => {
  it("summarizes shots with frame/video presence", () => {
    const p = prod({
      scenes: [
        {
          number: 1,
          title: "A",
          shots: [
            { id: "sh1", number: "0100", audio: "", visual: "wide", artwork: "boards/0100/a.png" },
            { id: "sh2", number: "0200", audio: "", visual: "close", videoPath: "boards/0200/video/v.mp4" },
          ],
        },
      ],
    });
    const d = productionDigest(p) as { shots: Array<Record<string, unknown>> };
    expect(d.shots).toHaveLength(2);
    expect(d.shots[0]).toMatchObject({ id: "sh1", hasFrame: true, hasVideo: false });
    expect(d.shots[1]).toMatchObject({ id: "sh2", hasFrame: false, hasVideo: true });
  });
});

describe("create / import", () => {
  it("creates under the default parent when no folder is given", async () => {
    const { host, run } = makeHost();
    run.mockResolvedValueOnce(prod());
    await call(makeProductionAgentTools(host).cascade_create_production, { name: "My Film" });
    expect(run).toHaveBeenCalledWith("create", "My Film", "C:/Users/me/Documents");
  });

  it("creates under an explicit folder", async () => {
    const { host, run } = makeHost();
    run.mockResolvedValueOnce(prod());
    await call(makeProductionAgentTools(host).cascade_create_production, { name: "My Film", folder: "D:/Films" });
    expect(run).toHaveBeenCalledWith("create", "My Film", "D:/Films");
  });

  it("requires a name", async () => {
    const { host } = makeHost();
    await expect(call(makeProductionAgentTools(host).cascade_create_production, {})).rejects.toThrow(/name/);
  });

  it("imports an existing folder", async () => {
    const { host, run } = makeHost();
    run.mockResolvedValueOnce(prod());
    await call(makeProductionAgentTools(host).cascade_import_production, { folder: "D:/old" });
    expect(run).toHaveBeenCalledWith("import", "D:/old");
  });
});

describe("resolve target id", () => {
  it("defaults to the active production", async () => {
    const { host, run } = makeHost({ activeId: () => "active-1" });
    run.mockResolvedValueOnce(prod());
    await call(makeProductionAgentTools(host).cascade_ingest_script, { source: "D:/s.md" });
    expect(run).toHaveBeenCalledWith("ingest", "active-1", "D:/s.md");
  });

  it("throws when no production can be resolved", async () => {
    const { host } = makeHost();
    await expect(
      call(makeProductionAgentTools(host).cascade_ingest_script, { source: "D:/s.md" })
    ).rejects.toThrow(/No production selected/);
  });
});

describe("style", () => {
  it("sets the master style", async () => {
    const { host, run } = makeHost({ activeId: () => "p1" });
    run.mockResolvedValueOnce(prod());
    await call(makeProductionAgentTools(host).cascade_set_style, { name: "Noir", prompt: "high contrast" });
    expect(run).toHaveBeenCalledWith("setStyle", "p1", { name: "Noir", prompt: "high contrast", styleId: undefined });
  });

  it("resolves the master style id for the frame when none is given", async () => {
    const p = prod({ styles: [{ id: "s1", index: 1, name: "Noir", prompt: "x" }] });
    const { host, run } = makeHost({ activeId: () => "p1", load: () => p });
    run.mockResolvedValueOnce(p);
    await call(makeProductionAgentTools(host).cascade_generate_style_frame, {});
    expect(run).toHaveBeenCalledWith("generateStyleFrame", "p1", "s1", undefined, undefined, undefined);
  });

  it("errors when the production has no style", async () => {
    const { host } = makeHost({ activeId: () => "p1", load: () => prod() });
    await expect(call(makeProductionAgentTools(host).cascade_generate_style_frame, {})).rejects.toThrow(/no style/);
  });
});

describe("character sheet", () => {
  it("fills generator defaults", async () => {
    const { host, run } = makeHost({ activeId: () => "p1" });
    run.mockResolvedValueOnce(prod());
    await call(makeProductionAgentTools(host).cascade_generate_character_sheet, {
      name: "Ada",
      description: "a pilot",
    });
    expect(run).toHaveBeenCalledWith("generateCharacterSheet", "p1", {
      model: "auto",
      resolution: "1k",
      name: "Ada",
      description: "a pilot",
      view: "front",
    });
  });
});

describe("storyboard", () => {
  it("regenerates specific shots when ids are given", async () => {
    const { host, run } = makeHost({ activeId: () => "p1" });
    run.mockResolvedValueOnce(prod());
    await call(makeProductionAgentTools(host).cascade_generate_storyboard, { shotIds: ["sh1", "sh2"] });
    expect(run).toHaveBeenCalledWith("regenerateBoards", "p1", ["sh1", "sh2"]);
  });

  it("batch-generates with options when no ids are given", async () => {
    const { host, run } = makeHost({ activeId: () => "p1" });
    run.mockResolvedValueOnce(prod());
    await call(makeProductionAgentTools(host).cascade_generate_storyboard, { maxShots: 4, regenerateAll: true });
    expect(run).toHaveBeenCalledWith("generateBoards", "p1", { maxShots: 4, regenerateAll: true });
  });
});

describe("video", () => {
  it("builds VideoGenOptions with defaults", async () => {
    const { host, run } = makeHost({ activeId: () => "p1" });
    run.mockResolvedValueOnce(prod());
    await call(makeProductionAgentTools(host).cascade_generate_video, {
      shotId: "sh1",
      prompt: "dolly in",
    });
    expect(run).toHaveBeenCalledWith("generateVideo", "p1", "sh1", {
      model: "auto",
      resolution: "1080p",
      durationSec: 5,
      prompt: "dolly in",
    });
  });

  it("appends cited references as @[Name] tags", async () => {
    const { host, run } = makeHost({ activeId: () => "p1" });
    run.mockResolvedValueOnce(prod());
    await call(makeProductionAgentTools(host).cascade_generate_video, {
      shotId: "sh1",
      prompt: "camera pushes in",
      references: ["Ada", "Gondola"],
    });
    const opts = run.mock.calls[0][3] as { prompt: string };
    expect(opts.prompt).toContain("camera pushes in");
    expect(opts.prompt).toContain("@[Ada]");
    expect(opts.prompt).toContain("@[Gondola]");
  });
});

describe("reference wiring", () => {
  it("runs the magic-prompt pass", async () => {
    const { host, run } = makeHost({ activeId: () => "p1" });
    run.mockResolvedValueOnce(prod());
    await call(makeProductionAgentTools(host).cascade_generate_magic_prompts, {});
    expect(run).toHaveBeenCalledWith("generateMagicPrompts", "p1");
  });

  it("sets one shot's prompt", async () => {
    const { host, run } = makeHost({ activeId: () => "p1" });
    run.mockResolvedValueOnce(prod());
    await call(makeProductionAgentTools(host).cascade_set_shot_prompt, {
      shotId: "sh1",
      prompt: "Ada at the @[Gondola]",
    });
    expect(run).toHaveBeenCalledWith("setShotPrompt", "p1", "sh1", "Ada at the @[Gondola]");
  });
});

describe("assemble", () => {
  it("only builds when render is not requested", async () => {
    const { host, run } = makeHost({ activeId: () => "p1" });
    run.mockResolvedValueOnce(prod());
    await call(makeProductionAgentTools(host).cascade_assemble, { fps: 30 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("assemble", "p1", { fps: 30 });
  });

  it("builds then renders when render is true", async () => {
    const { host, run } = makeHost({ activeId: () => "p1" });
    run.mockResolvedValue(prod());
    await call(makeProductionAgentTools(host).cascade_assemble, { render: true });
    const ops = run.mock.calls.map((c) => c[0]);
    expect(ops).toEqual(["assemble", "render"]);
  });

  it("flags suspicious stills from the timeline report", async () => {
    const { host, run } = makeHost({
      activeId: () => "p1",
      assemblyReport: () => ({ totalSec: 15, stills: ["0200", "0300"], blanks: [], suspiciousStills: ["0200", "0300"] }),
    });
    run.mockResolvedValue(prod());
    const out = String(await call(makeProductionAgentTools(host).cascade_assemble, {}));
    expect(out).toMatch(/WARNING/);
    expect(out).toMatch(/0200, 0300/);
  });
});

describe("models / animatic / recheck", () => {
  it("lists models filtered by kind", async () => {
    const { host, run } = makeHost();
    run.mockResolvedValueOnce([
      { id: "byte-plus-seedance-2", displayName: "Seedance 2.0", videoInput: true, imageInput: false, cost: 5 },
      { id: "flux", displayName: "Flux", videoInput: false, imageInput: true, cost: 1 },
    ]);
    const out = String(await call(makeProductionAgentTools(host).cascade_list_models, { kind: "video" }));
    const parsed = JSON.parse(out);
    expect(parsed.models).toEqual([
      { id: "byte-plus-seedance-2", name: "Seedance 2.0", kind: "video", cost: 5 },
    ]);
  });

  it("includes durations/resolutions when includeOptions is set", async () => {
    const { host, run } = makeHost();
    run.mockImplementation(async (op: string) => {
      if (op === "listModels") {
        return [
          { id: "higgsfield-cli:seedance_2_5", displayName: "Seedance 2.5", videoInput: true },
          { id: "higgsfield-cli:gpt_image_2_5", displayName: "GPT Image", videoInput: false },
        ];
      }
      if (op === "videoModelOptions") return { durations: [4, 8], resolutions: ["720p", "1080p"] };
      if (op === "imageModelOptions") return { resolutions: ["1k", "2k"], qualities: ["high"] };
      return null;
    });
    const out = String(
      await call(makeProductionAgentTools(host).cascade_list_models, { includeOptions: true })
    );
    const parsed = JSON.parse(out);
    const video = parsed.models.find((m: { kind: string }) => m.kind === "video");
    const image = parsed.models.find((m: { kind: string }) => m.kind === "image");
    expect(video).toMatchObject({ durations: [4, 8], resolutions: ["720p", "1080p"] });
    expect(image).toMatchObject({ resolutions: ["1k", "2k"], qualities: ["high"] });
  });

  it("reads a model's option schema", async () => {
    const { host, run } = makeHost();
    run.mockResolvedValueOnce({
      jobType: "seedance_2_5",
      durations: [4, 8],
      aspectRatios: ["16:9"],
      fields: [
        { name: "resolution", group: "core", kind: "enum", values: ["720p", "1080p"], default: "1080p" },
        { name: "generate_audio", group: "advanced", kind: "boolean", default: false },
      ],
    });
    const out = String(
      await call(makeProductionAgentTools(host).cascade_model_options, { modelId: "higgsfield-cli:seedance_2_5" })
    );
    expect(run).toHaveBeenCalledWith("modelOptions", "higgsfield-cli:seedance_2_5");
    const parsed = JSON.parse(out);
    expect(parsed.durations).toEqual([4, 8]);
    expect(parsed.fields).toContainEqual({ name: "generate_audio", group: "advanced", kind: "boolean", default: false });
  });

  it("plans animatic timing", async () => {
    const { host, run } = makeHost({ activeId: () => "p1" });
    run.mockResolvedValueOnce(prod());
    await call(makeProductionAgentTools(host).cascade_plan_animatic, {});
    expect(run).toHaveBeenCalledWith("planAnimatic", "p1");
  });

  it("rechecks a pending video", async () => {
    const { host, run } = makeHost({ activeId: () => "p1" });
    run.mockResolvedValueOnce(prod());
    await call(makeProductionAgentTools(host).cascade_recheck_video, { shotId: "sh1" });
    expect(run).toHaveBeenCalledWith("recheckVideo", "p1", "sh1");
  });

  it("warns when a generated shot has no registered clip", async () => {
    const { host, run } = makeHost({ activeId: () => "p1" });
    const p = prod({
      scenes: [{ number: 1, title: "A", shots: [{ id: "sh1", number: "0100", audio: "", visual: "x" }] }],
    });
    run.mockResolvedValueOnce(p);
    const out = String(await call(makeProductionAgentTools(host).cascade_generate_video, { shotId: "sh1", prompt: "pan" }));
    expect(out).toMatch(/no registered clip/);
    expect(out).toMatch(/cascade_recheck_video/);
  });
});
