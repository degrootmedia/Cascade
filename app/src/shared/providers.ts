/**
 * LLM API providers selectable in Settings. Each provider is an
 * OpenAI-compatible endpoint; the selected one drives chat, titles, the model
 * list, and the production pipeline's LLM calls.
 */
export interface ApiProvider {
  id: string;
  label: string;
  baseUrl: string;
  /** Model used when the provider has no per-provider model saved yet. */
  defaultModel: string;
}

export const API_PROVIDERS: ApiProvider[] = [
  { id: "gab", label: "Gab.ai", baseUrl: "https://gab.ai/v1", defaultModel: "arya" },
  { id: "cheaperinference", label: "Cheaper Inference", baseUrl: "https://api.cheaperinference.com/v1", defaultModel: "" },
];

export function getProvider(id: string): ApiProvider | undefined {
  return API_PROVIDERS.find((p) => p.id === id);
}

/** Raw /models entry as returned by an OpenAI-compatible endpoint. */
export interface RawModel {
  id: string;
  /** gab.ai-style capability object (capabilities.text / function_calling / ...). */
  capabilities?: Record<string, boolean> | null;
  /** gab.ai credit cost. */
  credit_cost?: { base_cost?: number } | null;
  /** Cheaper Inference-style top-level flags. */
  model_type?: string;
  type?: string;
  supports_vision?: boolean;
  vision?: boolean;
  supports_reasoning?: boolean;
  reasoning?: boolean;
  supports_streaming?: boolean;
  streaming?: boolean;
  /** Cheaper Inference per-million pricing (strings like "0.700000"). */
  pricing?: {
    currency?: string;
    input_per_million?: string;
    output_per_million?: string;
  } | null;
}

/**
 * Pull the model list out of a /models response. OpenAI-compatible endpoints
 * wrap it as { data: [...] }; Cheaper Inference returns { models: [...] };
 * some return a bare array. Returns [] when the shape is unrecognized.
 */
export function extractModelList(json: unknown): RawModel[] {
  if (Array.isArray(json)) return json as RawModel[];
  const obj = json as Record<string, unknown>;
  const data = obj?.data ?? obj?.models;
  return Array.isArray(data) ? (data as RawModel[]) : [];
}

/** A model is usable by the agent (chat + tool calling) unless a flag
 *  explicitly rules it out. gab.ai advertises capabilities.text /
 *  function_calling / streaming; other providers (e.g. Cheaper Inference)
 *  use different capability keys (vision / video / reasoning / streaming)
 *  and must not be silently dropped. */
function isUsableChatModel(m: RawModel): boolean {
  const caps = m.capabilities;
  // gab.ai-shaped capabilities carry a `text` key — require text + function
  // calling + streaming (the agent needs all three).
  if (caps && "text" in caps) {
    return !!caps.text && !!caps.function_calling && !!caps.streaming;
  }
  // Unknown schema — only exclude on explicit negative signals.
  if (caps?.text === false || caps?.function_calling === false || caps?.streaming === false) return false;
  const type = m.model_type ?? m.type;
  if (type && !["text", "chat", "language", "code"].includes(type)) return false;
  if (m.supports_streaming === false || m.streaming === false) return false;
  return true;
}

function formatUsd(x: number): string {
  return `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Derive the numeric sort key + display strings from a model's cost fields.
 *  gab charges credits (credit_cost.base_cost); Cheaper Inference charges
 *  USD per million tokens (pricing.output_per_million). */
function modelCost(m: RawModel): { baseCost: number; costLabel: string; costTitle: string } {
  if (m.credit_cost && typeof m.credit_cost.base_cost === "number") {
    const c = m.credit_cost.base_cost;
    return { baseCost: c, costLabel: String(c), costTitle: `${c} credits per message` };
  }
  const out = parseFloat(m.pricing?.output_per_million ?? "");
  const input = parseFloat(m.pricing?.input_per_million ?? "");
  if (Number.isFinite(out) && out >= 0) {
    const inUsd = Number.isFinite(input) && input >= 0 ? formatUsd(input) : "?";
    return {
      baseCost: out,
      costLabel: `${formatUsd(out)}/1M`,
      costTitle: `in ${inUsd} / out ${formatUsd(out)} per 1M tokens`,
    };
  }
  // gab.ai: an absent credit cost means the cheapest tier (e.g. arya).
  if (m.capabilities && "text" in m.capabilities) {
    return { baseCost: 1, costLabel: "1", costTitle: "1 credit per message" };
  }
  return { baseCost: Number.MAX_SAFE_INTEGER, costLabel: "—", costTitle: "Price unavailable" };
}

/**
 * Normalize a /models response into ModelInfo. Gab advertises text /
 * function_calling / streaming capabilities; OpenAI-compatible providers
 * (e.g. Cheaper Inference) usually don't send a capabilities object at all —
 * treat those as fully capable rather than silently filtering them all out.
 */
export function normalizeModelList(data: RawModel[]): Array<{
  id: string;
  thinking: boolean;
  vision: boolean;
  baseCost: number;
  costLabel: string;
  costTitle: string;
}> {
  return (data ?? [])
    .filter(isUsableChatModel)
    .map((m) => {
      const { baseCost, costLabel, costTitle } = modelCost(m);
      return {
        id: m.id,
        thinking: !!m.capabilities?.thinking || !!m.capabilities?.reasoning || !!m.supports_reasoning || !!m.reasoning,
        vision: !!m.capabilities?.image_input || !!m.capabilities?.vision || !!m.supports_vision || !!m.vision,
        baseCost,
        costLabel,
        costTitle,
      };
    });
}