/**
 * providers.ts tests — the API provider registry and /models normalization.
 * normalizeModelList is the seam that keeps the models:list IPC handler
 * provider-agnostic: gab advertises capabilities, OpenAI-compatible providers
 * (e.g. Cheaper Inference) usually don't, and must not be filtered out.
 */
import { describe, it, expect } from "vitest";
import { API_PROVIDERS, extractModelList, getProvider, normalizeModelList } from "../src/shared/providers.js";

describe("API_PROVIDERS", () => {
  it("registers gab and cheaperinference", () => {
    expect(API_PROVIDERS.map((p) => p.id)).toContain("gab");
    expect(API_PROVIDERS.map((p) => p.id)).toContain("cheaperinference");
    expect(API_PROVIDERS.every((p) => p.baseUrl.endsWith("/v1"))).toBe(true);
  });

  it("looks providers up by id", () => {
    expect(getProvider("gab")?.baseUrl).toBe("https://gab.ai/v1");
    expect(getProvider("cheaperinference")?.baseUrl).toBe("https://api.cheaperinference.com/v1");
    expect(getProvider("nope")).toBeUndefined();
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