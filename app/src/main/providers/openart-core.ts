/**
 * openart-core — the vendor-neutral OpenArt schema grammar: model-list
 * shaping, form-schema parsing, and video option extraction.
 *
 * The OpenArt MCP server and the OpenArt CLI binary front the SAME backend,
 * so their `model list` items and `model form` JSON Schemas share a
 * vocabulary. Both transports (`OpenArtClient`, `OpenArtCliProvider`) shape
 * dropdown choices and read resolutions/lengths through these pure
 * functions — the parsing lives in exactly one place, and the transports
 * differ only in how they fetch the raw replies.
 */
import {
  parseJsonLooseArray,
  parseJsonLooseObject,
} from "../../shared/prompt-grammar.js";
import type { OpenArtModelChoice, VideoModelOptions } from "../../shared/ipc.js";

/** Extract the first signed number from a duration label ("5s"→5, "5 sec"→5,
 *  "-1"→-1, "auto"→NaN). Preserves the sign so OpenArt's -1 "auto/random"
 *  sentinel is never misread as a positive 1s length. */
export const openArtDurationNumber = (v: unknown): number => {
  const m = String(v).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
};

/** Parse an OpenArt model-list reply into dropdown choices. */
export function parseOpenArtModels(raw: string): Array<Record<string, unknown>> {
  const arr = parseJsonLooseArray(raw);
  if (arr) {
    return arr.filter((m) => m && typeof m === "object") as Array<Record<string, unknown>>;
  }
  const obj = parseJsonLooseObject(raw);
  if (obj) {
    // OpenAI-style / list envelopes: { data: [...] }, { items: [...] },
    // { models: [...] }, { list: [...] }, { results: [...] }.
    for (const key of ["data", "items", "models", "list", "results"]) {
      const v = obj[key];
      if (Array.isArray(v)) return v.filter((m) => m && typeof m === "object") as Array<Record<string, unknown>>;
    }
    // Some servers return a plain map { modelId: {…}, … }. Only trust it when
    // EVERY value is an object (so an { error: "…" } envelope isn't misread).
    const vals = Object.values(obj);
    if (vals.length && vals.every((v) => v && typeof v === "object")) {
      return vals as Array<Record<string, unknown>>;
    }
  }
  return [];
}

/** Shape an OpenArt model list into dropdown choices. */
export function shapeOpenArtModelChoices(raw: string): OpenArtModelChoice[] {
  const out: OpenArtModelChoice[] = [];
  for (const m of parseOpenArtModels(raw)) {
    const id = String(m.model ?? m.id ?? m.model_id ?? m.name ?? "").trim();
    if (!id) continue;
    const displayName = String(m.displayName ?? m.display_name ?? m.name ?? id);
    const description = String(m.description ?? m.summary ?? m.recommendedFor ?? "");
    // Capability signals. Descriptions are marketing copy that routinely
    // mention both modalities, so they are only a LAST resort: structured
    // fields (media/modes/output-kind) decide whenever they carry any
    // image/video signal, and the description only fills in when they're
    // silent. This keeps image models whose copy mentions "video" out of
    // the video lists without dropping models whose structured fields carry
    // no modality tokens at all.
    const mediaList = Array.isArray(m.media) ? (m.media as unknown[]).map(String) : [];
    const modesList = Array.isArray(m.modes) ? (m.modes as unknown[]).map(String) : [];
    // The modern model list exposes `modes` as an OBJECT keyed by output
    // media: `{ image: [{mode,description}], video: [{mode,…}] }`. Parse the
    // video-mode spellings so generation can submit in the mode that
    // actually carries references (e.g. `element2video`), and so an
    // image-only model whose description merely mentions "video" is never
    // offered in the video dropdowns.
    const modesByMedia: Record<string, string[]> = {};
    if (m.modes && typeof m.modes === "object" && !Array.isArray(m.modes)) {
      for (const [media, list] of Object.entries(m.modes as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        modesByMedia[media.toLowerCase()] = list
          .map((e) => String((e as { mode?: unknown } | null)?.mode ?? e ?? ""))
          .filter(Boolean);
      }
    }
    const videoModes = modesByMedia.video ?? [];
    const imageModes = modesByMedia.image ?? [];
    const kindField = String(m.output_type ?? m.outputType ?? m.type ?? m.category ?? "").toLowerCase();
    const structuredVideo =
      /video/.test(kindField) ||
      modesList.some((s) => /video/i.test(s)) ||
      videoModes.length > 0 ||
      mediaList.some((s) => /video/i.test(s));
    const structuredImage =
      /image/.test(kindField) ||
      modesList.some((s) => /image/i.test(s)) ||
      imageModes.length > 0 ||
      mediaList.some((s) => /image/i.test(s));
    const videoOutput = structuredVideo || (!structuredVideo && !structuredImage && /video/i.test(description));
    const imageOutput = structuredImage || (!structuredVideo && !structuredImage && /image/i.test(description));
    // Credit cost: OpenArt sometimes reports it on the model entry — take the
    // first plausible number; otherwise null (unknown).
    const costRaw = m.cost ?? m.price ?? m.credit_cost ?? m.base_cost;
    let cost: number | null = null;
    if (typeof costRaw === "number" && Number.isFinite(costRaw)) cost = costRaw;
    else if (costRaw && typeof costRaw === "object") {
      const v = (costRaw as Record<string, unknown>).base_cost ?? (costRaw as Record<string, unknown>).amount;
      if (typeof v === "number" && Number.isFinite(v)) cost = v;
    }
    out.push({ id, displayName, description, imageInput: imageOutput, videoInput: videoOutput, cost, videoModes });
  }
  return out;
}

/** Does a form enum label look like a video resolution? Accepts "4K"/"2K"/
 *  "8K" (incl. "4K Ultra HD"), "480p"/"1080p"/"2160p", "1920x1080", bare
 *  numbers like "1080", and "HD"/"FHD"/"QHD"/"UHD"/"Full HD" — plus annotated
 *  labels like "4K Ultra HD (3840x2160)" that contain a resolution token. */
export function openArtLooksLikeResolution(s: string): boolean {
  const t = s.trim();
  if (/\d+(?:\.\d+)?\s*k|\d{3,4}\s*p|\d+\s*[x×]\s*\d+/i.test(t)) return true;
  if (/^\d{3,4}$/.test(t)) return true;
  return /^(?:full\s+hd|fhd|qhd|uhd|hd)$/i.test(t);
}

/** Extract the field map out of an OpenArt model-form reply. */
export function parseOpenArtFormProperties(raw: string): Record<string, unknown> | null {
  const j = parseJsonLooseObject(raw);
  if (!j) return null;
  const schema = j.jsonSchema as Record<string, unknown> | undefined;
  const allOf = Array.isArray(schema?.allOf) ? (schema.allOf as Record<string, unknown>[]) : [];
  // Merge every schema block (the MCP form tool splits a form across
  // allOf entries); a later block can carry the reference array even when
  // the first only has the prompt/duration fields.
  const merged: Record<string, unknown> = {};
  let found = false;
  const absorb = (props: unknown) => {
    if (props && typeof props === "object") {
      Object.assign(merged, props as Record<string, unknown>);
      found = true;
    }
  };
  for (const entry of allOf) absorb(entry?.properties);
  absorb(schema?.properties);
  return found ? merged : null;
}

/** Pull the resolution/duration options out of a model form's props map. */
export function extractOpenArtVideoOptions(props: Record<string, unknown>): VideoModelOptions {
  const out: VideoModelOptions = { resolutions: [], durations: [] };
  for (const key of Object.keys(props)) {
    const p = props[key] as {
      type?: string; enum?: unknown[]; minimum?: unknown; maximum?: unknown; oneOf?: unknown[]; anyOf?: unknown[];
    } | undefined;
    if (!p) continue;
    if (/resolution|quality|definition|size/i.test(key) && Array.isArray(p.enum)) {
      for (const v of p.enum) {
        const s = String(v).trim();
        if (openArtLooksLikeResolution(s)) out.resolutions.push(s);
      }
    }
    if (/duration|length|seconds|clip|frames|time/i.test(key)) {
      const nums = new Set<number>();
      if (Array.isArray(p.enum)) {
        for (const v of p.enum) {
          const n = openArtDurationNumber(v);
          if (Number.isFinite(n) && n > 0 && n <= 120) nums.add(Math.round(n));
        }
      }
      // oneOf/anyOf const choices (e.g. [{const:-1,"Auto"},{const:5},{const:8}])
      // — the sentinel const (-1/0/auto) is filtered out by the n > 0 check.
      for (const c of [...(p.oneOf ?? []), ...(p.anyOf ?? [])]) {
        const cand = (c as { const?: unknown } | null | undefined)?.const;
        if (cand === undefined) continue;
        const n = openArtDurationNumber(cand);
        if (Number.isFinite(n) && n > 0 && n <= 120) nums.add(Math.round(n));
      }
      // Numeric bounds as a range (integer/number, or type-less min/max).
      if ((p.minimum !== undefined || p.maximum !== undefined) &&
          (p.type === undefined || p.type === "integer" || p.type === "number")) {
        const min = Number(p.minimum) > 0 ? Math.ceil(Number(p.minimum)) : 1;
        const max = Number(p.maximum) > 0 ? Math.floor(Number(p.maximum)) : min + 15;
        for (let n = min; n <= max && n <= 120; n++) nums.add(n);
      }
      for (const n of nums) out.durations.push(n);
    }
  }
  out.resolutions = Array.from(new Set(out.resolutions));
  out.durations = Array.from(new Set(out.durations)).sort((a, b) => a - b);
  return out;
}

/** Human-readable summary of accepted clip lengths ("4–15s" for a
 *  contiguous range, "5, 10s" for discrete picks) for validation errors. */
export function describeOpenArtDurations(durations: number[]): string {
  const sorted = [...durations].sort((a, b) => a - b);
  let contiguous = sorted.length > 2;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) { contiguous = false; break; }
  }
  if (contiguous) return `${sorted[0]}–${sorted[sorted.length - 1]}s`;
  return `${sorted.join(", ")}s`;
}
