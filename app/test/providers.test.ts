/**
 * providers.ts tests — the API provider registry and /models normalization.
 * normalizeModelList is the seam that keeps the models:list IPC handler
 * provider-agnostic: gab advertises capabilities, OpenAI-compatible providers
 * (e.g. Cheaper Inference) usually don't, and must not be filtered out.
 */
import { describe, it, expect, vi } from "vitest";
import { API_PROVIDERS, extractModelList, getProvider, normalizeModelList } from "../src/shared/providers.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

describe("API_PROVIDERS", () => {
  it("registers gab, cheaperinference, and openai", () => {
    expect(API_PROVIDERS.map((p) => p.id)).toEqual(expect.arrayContaining(["gab", "cheaperinference", "openai"]));
    expect(API_PROVIDERS.every((p) => p.baseUrl.endsWith("/v1"))).toBe(true);
  });

  it("looks providers up by id", () => {
    expect(getProvider("gab")?.baseUrl).toBe("https://gab.ai/v1");
    expect(getProvider("cheaperinference")?.baseUrl).toBe("https://api.cheaperinference.com/v1");
    expect(getProvider("openai")?.baseUrl).toBe("https://api.openai.com/v1");
    expect(getProvider("nope")).toBeUndefined();
  });

  it("declares each provider's balance endpoint", () => {
    // gab reports credits, Cheaper Inference its wallet USD balance; a
    // provider without an entry never gets a doomed balance request.
    expect(getProvider("gab")?.balance).toEqual({ path: "/credits", field: "total_available", unit: "credits" });
    expect(getProvider("cheaperinference")?.balance).toEqual({
      path: "/account/balance",
      field: "available_usd",
      unit: "usd",
      errorHint: "the API key needs the account:read scope",
    });
    expect(getProvider("openai")?.balance).toBeUndefined();
  });
});

describe("extractModelList", () => {
  it("accepts the OpenAI { data: [...] } wrapper", () => {
    const out = extractModelList({ data: [{ id: "a" }, { id: "b" }] });
    expect(out.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("accepts the Cheaper Inference { models: [...] } wrapper", () => {
    const out = extractModelList({ models: [{ id: "claude-fable-5.1" }, { id: "gpt-5.4" }] });
    expect(out.map((m) => m.id)).toEqual(["claude-fable-5.1", "gpt-5.4"]);
  });

  it("accepts a bare top-level array", () => {
    const out = extractModelList([{ id: "x" }, { id: "y" }]);
    expect(out.map((m) => m.id)).toEqual(["x", "y"]);
  });

  it("returns [] for unrecognized shapes", () => {
    expect(extractModelList({ error: { message: "nope" } })).toEqual([]);
    expect(extractModelList({ data: "not-an-array" })).toEqual([]);
    expect(extractModelList(undefined)).toEqual([]);
  });
});

describe("normalizeModelList", () => {
  it("keeps gab models that advertise text + function calling + streaming", () => {
    const out = normalizeModelList([
      { id: "arya", capabilities: { text: true, function_calling: true, streaming: true }, credit_cost: { base_cost: 1 } },
      { id: "vision", capabilities: { text: true, function_calling: true, streaming: true, thinking: true, image_input: true }, credit_cost: { base_cost: 5 } },
      { id: "no-tools", capabilities: { text: true, function_calling: false, streaming: true }, credit_cost: null },
    ]);
    expect(out.map((m) => m.id)).toEqual(["arya", "vision"]);
    expect(out[1]).toMatchObject({ thinking: true, vision: true, baseCost: 5 });
    expect(out[0]).toMatchObject({ thinking: false, vision: false, baseCost: 1, costLabel: "1", costTitle: "1 credits per message" });
    expect(out[1].costLabel).toBe("5");
  });

  it("derives Cheaper Inference costs from per-million pricing (input order preserved; UI sorts)", () => {
    const out = normalizeModelList([
      {
        id: "claude-fable-5.1",
        type: "text",
        pricing: { currency: "USD", input_per_million: "0.700000", output_per_million: "3.500000" },
      },
      { id: "free-model", type: "text", pricing: { currency: "USD", input_per_million: "0.000000", output_per_million: "0.000000" } },
      { id: "no-price", type: "text" },
    ]);
    expect(out.map((m) => m.id)).toEqual(["claude-fable-5.1", "free-model", "no-price"]);
    expect(out[0]).toMatchObject({ baseCost: 3.5, costLabel: "$3.50/1M", costTitle: "in $0.70 / out $3.50 per 1M tokens" });
    expect(out[1].baseCost).toBe(0);
    expect(out[1].costLabel).toBe("$0.00/1M");
    expect(out[2]).toMatchObject({ baseCost: Number.MAX_SAFE_INTEGER, costLabel: "—" });
  });

  it("treats providers without a capabilities object as fully capable", () => {
    const out = normalizeModelList([{ id: "cheap-1" }, { id: "cheap-2", credit_cost: { base_cost: 2 } }]);
    expect(out.map((m) => m.id)).toEqual(["cheap-1", "cheap-2"]);
    expect(out[0]).toMatchObject({ thinking: false, vision: false, baseCost: Number.MAX_SAFE_INTEGER, costLabel: "—" });
    expect(out[1]).toMatchObject({ baseCost: 2, costLabel: "2", costTitle: "2 credits per message" });
  });

  it("maps Cheaper Inference top-level capability flags", () => {
    const out = normalizeModelList([
      {
        id: "claude-fable-5.1",
        model_type: "text",
        supports_vision: true,
        supports_reasoning: true,
        supports_streaming: true,
      },
      { id: "not-chat", model_type: "image", supports_streaming: false },
    ]);
    expect(out.map((m) => m.id)).toEqual(["claude-fable-5.1"]);
    expect(out[0]).toMatchObject({ thinking: true, vision: true });
  });

  it("keeps Cheaper Inference models whose capabilities schema differs from gab's", () => {
    // Confirmed schema: capabilities = { vision, video, reasoning, streaming,
    // image_generation, image_edit } — no text / function_calling keys.
    const out = normalizeModelList([
      {
        id: "claude-fable-5.1",
        type: "text",
        capabilities: { vision: true, video: false, reasoning: true, streaming: true, image_generation: false, image_edit: false },
      },
      {
        id: "not-chat",
        type: "image",
        capabilities: { vision: false, video: false, reasoning: false, streaming: false, image_generation: true, image_edit: false },
      },
    ]);
    expect(out.map((m) => m.id)).toEqual(["claude-fable-5.1"]);
    expect(out[0]).toMatchObject({ thinking: true, vision: true });
  });

  it("handles empty or missing data", () => {
    expect(normalizeModelList([])).toEqual([]);
    expect(normalizeModelList(undefined as unknown as Array<{ id: string }>)).toEqual([]);
  });
});

describe("cost tiers (relative ranking)", () => {
  it("ranks per-token models cheapest/mid/priciest from their own pricing fields", () => {
    const out = normalizeModelList([
      { id: "exp", type: "text", pricing: { input_per_million: "9.000000", output_per_million: "27.000000" } },
      { id: "mid", type: "text", pricing: { input_per_million: "1.000000", output_per_million: "9.000000" } },
      { id: "free", type: "text", pricing: { input_per_million: "0.000000", output_per_million: "0.000000" } },
      { id: "low", type: "text", pricing: { input_per_million: "0.500000", output_per_million: "3.000000" } },
      { id: "high", type: "text", pricing: { input_per_million: "5.000000", output_per_million: "15.000000" } },
      { id: "unpriced", type: "text" },
    ]);
    const tierOf = (id: string) => out.find((m) => m.id === id)?.costTier;
    expect(tierOf("free")).toBe("cheapest");
    expect(tierOf("low")).toBe("cheapest");
    expect(tierOf("mid")).toBe("mid");
    expect(tierOf("exp")).toBe("priciest");
    expect(tierOf("high")).toBe("priciest");
    // Unpriced models can't be ranked — the UI shows "—" for them.
    expect(tierOf("unpriced")).toBeNull();
    // Exact rates survive in the tooltip even when the badge shows the tier.
    expect(out.find((m) => m.id === "free")?.costTitle).toContain("out $0.00 per 1M tokens");
  });

  it("skips tiers when fewer than two distinct costs are known", () => {
    const one = normalizeModelList([{ id: "solo", type: "text", pricing: { output_per_million: "1.000000" } }]);
    expect(one[0].costTier).toBeNull();
    const tied = normalizeModelList([
      { id: "a", type: "text", pricing: { output_per_million: "2.000000" } },
      { id: "b", type: "text", pricing: { output_per_million: "2.000000" } },
    ]);
    expect(tied.map((m) => m.costTier)).toEqual([null, null]);
  });

  it("keeps exact per-message badges (costKind) for credit-priced providers", () => {
    const out = normalizeModelList([
      { id: "arya", capabilities: { text: true, function_calling: true, streaming: true }, credit_cost: { base_cost: 1 } },
      { id: "big", capabilities: { text: true, function_calling: true, streaming: true }, credit_cost: { base_cost: 12 } },
    ]);
    expect(out.map((m) => m.costKind)).toEqual(["per-message", "per-message"]);
    // Exact pricing still works for tiering (UI chooses not to show it here).
    expect(out.map((m) => m.costTier)).toEqual(["cheapest", "priciest"]);
    expect(out[0].costLabel).toBe("1");
  });

  it("marks fully unpriced providers (e.g. OpenAI /models) as unknown", () => {
    const out = normalizeModelList([{ id: "gpt-5.4" }, { id: "gpt-5.4-mini" }]);
    expect(out.map((m) => m.costKind)).toEqual(["unknown", "unknown"]);
    expect(out.map((m) => m.costTier)).toEqual([null, null]);
    expect(out.map((m) => m.costLabel)).toEqual(["—", "—"]);
  });
});

describe("PROVIDER_CAPABILITIES", () => {
  it("declares a conservative matrix (openart-cli: no video refs, no end frame)", async () => {
    const { PROVIDER_CAPABILITIES, PROVIDER_IDS } = await import("../src/main/providers/registry.js");
    expect(PROVIDER_IDS).toEqual(expect.arrayContaining(["openart", "higgsfield-cli", "openart-cli"]));
    expect(PROVIDER_IDS).not.toContain("higgsfield");
    expect(PROVIDER_CAPABILITIES["openart-cli"]).toEqual({ imageRefs: true, videoRefs: false, endFrame: false, tween: false });
    expect(PROVIDER_CAPABILITIES["higgsfield-cli"].videoRefs).toBe(true);
    expect(PROVIDER_CAPABILITIES["higgsfield-cli"].endFrame).toBe(true);
  });
});

describe("applyModelSurfaces", () => {
  it("tags choices with applicable surfaces; explicit assignments restrict", async () => {
    const { applyModelSurfaces } = await import("../src/main/providers/registry.js");
    const img = { id: "img1", displayName: "Img", description: "", imageInput: true, videoInput: false, cost: null };
    const vid = { id: "vid1", displayName: "Vid", description: "", imageInput: false, videoInput: true, cost: null };
    // No assignments → untouched (treated as everywhere).
    const none = applyModelSurfaces([img, vid], {});
    expect(none[0].surfaces).toBeUndefined();
    // An explicit assignment restricts that model only.
    const mapped = applyModelSurfaces([img, vid], { img1: ["image:edit"] });
    expect(mapped[0].surfaces).toEqual(["image:edit"]);
    expect(mapped[1].surfaces).toContain("video:generate");
    // `video:tween` is opt-in — never in an unassigned model's default set.
    expect(mapped[1].surfaces).not.toContain("video:tween");
    // Assigning it declares end-frame capability for that model.
    const declared = applyModelSurfaces([vid], { vid1: ["video:tween"] });
    expect(declared[0].surfaces).toEqual(["video:tween"]);
    // A surface not applicable to the kind is dropped.
    const wrong = applyModelSurfaces([img], { img1: ["video:generate"] });
    expect(wrong[0].surfaces).toEqual([]);
    // `image:upscale` is opt-in like `video:tween`: never in an unassigned
    // image model's default set, and the assignment is the capability
    // declaration (the CLI probe supplies the known upscalers).
    const imgDefaults = applyModelSurfaces([img, vid], { vid1: ["video:generate"] });
    expect(imgDefaults[0].surfaces).toEqual(["image:generate", "image:edit"]);
    expect(imgDefaults[0].surfaces).not.toContain("image:upscale");
    const upscaled = applyModelSurfaces([img], { img1: ["image:upscale"] });
    expect(upscaled[0].surfaces).toEqual(["image:upscale"]);
  });

  it("migrates legacy surface keys to the collapsed pool keys", async () => {
    const { applyModelSurfaces } = await import("../src/main/providers/registry.js");
    const { normalizeModelSurfaces } = await import("../src/shared/ipc.js");
    const img = { id: "img1", displayName: "Img", description: "", imageInput: true, videoInput: false, cost: null };
    // Old per-picker keys collapse onto the shared generate surface.
    expect(normalizeModelSurfaces(["image:master", "image:node", "image:reference", "image:character"])).toEqual(["image:generate"]);
    expect(normalizeModelSurfaces(["image:editnode"])).toEqual(["image:edit"]);
    expect(normalizeModelSurfaces(["video:modal", "video:node", "video:tween"])).toEqual(["video:generate", "video:tween"]);
    // A stale map still resolves through application.
    const migrated = applyModelSurfaces([img], { img1: ["image:reference"] });
    expect(migrated[0].surfaces).toEqual(["image:generate"]);
  });
});

describe("style refs", () => {
  it("auto-attaches style-only refs with a style-only clause; content refs get none", async () => {
    const { resolvePromptRefs, citePrompt, styleRefNames } = await import("../src/main/providers/refs.js");
    const p = {
      characters: [],
      products: [],
      references: [
        { id: "s1", name: "Noir", imagePath: undefined, artwork: "data:image/png;base64,AAAA", styleOnly: true },
        { id: "c1", name: "Hero", imagePath: undefined, artwork: "data:image/png;base64,BBBB" },
      ],
      referenceCategories: [],
    } as unknown as import("../src/shared/ipc.js").Production;
    // No @[Noir] tag — style ref still attaches.
    const { resolved, extras } = resolvePromptRefs(p, "a shot @[Hero]", 1, false);
    expect(extras.map((e) => e.name)).toContain("Noir");
    expect(extras.map((e) => e.name)).toContain("Hero");
    const refs = [{ name: "Hero", dataUrl: "data:image/png;base64,BBBB" }, ...extras.filter((e) => e.name === "Noir").map((e) => ({ name: e.name, dataUrl: e.dataUrl }))];
    const cited = citePrompt("a shot @image1 @image2", refs, refs.map(() => "x"), styleRefNames(p));
    expect(cited).toContain("provided for style only");
    // Content ref gets no clause.
    expect(cited.match(/provided for style only/g)?.length).toBe(1);
    expect(cited).not.toContain("Render consistently with the other shots in this production.");
  });
});