/**
 * Cascade's shared storyboard-look contract.
 *
 * Cohesion rests on a first-class look asset, not on prose alone: every style
 * may own a style frame (a conditioning image stored on disk), every board
 * prompt carries one verbatim LOOK clause first, and the whole board shares a
 * fixed seed + frozen model/resolution. This module is dependency-free
 * (no Electron, no Buffer, no pipeline imports) so main, renderer, tests, and
 * the out-of-repo OpenArt/Higgsfield CLIs can all import the same words.
 *
 * Adapters do transport only: upload the frame at reference index 0, set the
 * seed when the vendor supports one, forward the assembled prompt. None of
 * them may carry their own copy of the LOOK sentence — import it from here.
 */

import type { Production, ProductionShot, ProductionStyle } from "./ipc.js";
import {
  LOOK_CLAUSE,
  STYLE_FRAME_SETTING,
  STYLE_FRAME_SUBJECT,
  STYLE_FRAME_TEMPLATE,
  renderPromptTemplate,
} from "./prompt-templates.js";

// The built-in look vocabulary lives in shared/prompt-templates.ts (the one
// home for user-editable wording); re-exported here so existing imports and the
// out-of-repo CLIs keep working.
export { LOOK_CLAUSE, STYLE_FRAME_SETTING, STYLE_FRAME_SUBJECT, STYLE_FRAME_TEMPLATE };

/** One style frame as an adapter upload: always reference index 0. */
export interface StyleFrameRef {
  /** Workspace-relative path of the frame image on disk. */
  imagePath: string;
  /** Fixed position — the frame always occupies the first reference slot. */
  position: 0;
}

/** The shared image-generation request every adapter (2 MCPs + 2 CLIs) accepts. */
export interface GenerationRequest {
  /** Fully assembled prompt (LOOK block first, from assembleImagePrompt). */
  prompt: string;
  /** Style frame path, uploaded as @image1 when present. */
  styleFramePath?: string;
  /** Content-reference data URLs/paths, shifted after the frame. */
  references: string[];
  /** Board-wide seed (best-effort — vendors without seed support ignore it). */
  seed?: number;
  /** Board aspect — always 16:9 so the frame conditions framing as well as finish. */
  aspect: "16:9";
  /** Frozen model/resolution for the whole board. */
  model: string;
  resolution: string;
}

/** The fixed look-reference sentence — identical on every shot. `lookClause`
 *  lets a caller substitute the user's overridden LOOK wording. */
export function buildLookClause(lookClause: string = LOOK_CLAUSE): string {
  return lookClause;
}

/** The global brand clause (palette + font). Single home for the wording —
 *  pipeline.brandPrompt and the renderer's brandClause delegate here so every
 *  surface renders byte-identical brand text. */
export function brandClauseText(brand?: { colors?: string[]; font?: string }): string {
  const colors = (brand?.colors ?? [])
    .map((c) => String(c).trim().replace(/^#/, ""))
    .filter((c) => /^[0-9a-fA-F]{3,6}$/.test(c))
    .slice(0, 5)
    .map((c) => `#${c.toLowerCase()}`);
  const font = (brand?.font ?? "").trim();
  const parts: string[] = [];
  if (colors.length) parts.push(`Color palette: ${colors.join(", ")}.`);
  if (font) parts.push(`Font: ${font}.`);
  return parts.join(" ");
}

/** True when the prompt already carries the LOOK clause (idempotency guard). */
export function hasLookClause(prompt: string, lookClause: string = LOOK_CLAUSE): boolean {
  return prompt.includes(lookClause);
}

/** Prepend the LOOK clause ahead of per-shot content (no-op when already present). */
export function withLookClause(prompt: string, lookClause: string = LOOK_CLAUSE): string {
  const base = prompt.trim();
  if (!base) return lookClause;
  if (hasLookClause(base, lookClause)) return base;
  return `${lookClause}\n\n${base}`;
}

/**
 * Assemble the full image prompt in the established order: LOOK block first,
 * then brand identity, then content, then resolved reference tags. Pure string
 * composition — callers resolve @[name] tags before or after as before.
 */
export function assembleImagePrompt(parts: {
  content: string;
  brand?: string;
  styleText?: string;
  look?: boolean;
  /** Override for the LOOK sentence (settings-backed). */
  lookClause?: string;
}): string {
  const paras: string[] = [];
  if (parts.look) paras.push(parts.lookClause?.trim() || LOOK_CLAUSE);
  if (parts.styleText?.trim()) paras.push(`Style: ${parts.styleText.trim()}`);
  if (parts.brand?.trim()) paras.push(`Brand identity: ${parts.brand.trim()}`);
  const content = parts.content.trim() || "Establishing frame for this moment.";
  paras.push(content);
  return paras.join("\n\n").slice(0, 2000);
}

/** Resolve the style entry a shot generates under: per-shot override, else master. */
export function resolveShotStyleEntry(
  p: Production,
  shot: ProductionShot
): ProductionStyle | undefined {
  if (shot.styleNone) return undefined;
  const s = shot.style?.trim();
  if (s) {
    const byId = p.styles?.find((st) => st.id === s);
    if (byId) return byId;
    const byName = p.styles?.find((st) => st.name === s);
    if (byName) return byName;
    return undefined;
  }
  return p.styles?.[0];
}

/** The style frame backing a shot's generation, if its style owns one. */
export function styleFrameForShot(
  p: Production,
  shot: ProductionShot
): ProductionStyle | undefined {
  const entry = resolveShotStyleEntry(p, shot);
  return entry?.imagePath?.trim() ? entry : undefined;
}

/** Board-wide seed: stored once per production, defaulting to styles[0].seed. */
export function ensureLookSeed(p: Production): number {
  if (typeof p.lookSeed === "number" && Number.isFinite(p.lookSeed)) return p.lookSeed;
  const fromStyle = p.styles?.[0]?.seed;
  if (typeof fromStyle === "number" && Number.isFinite(fromStyle)) {
    p.lookSeed = fromStyle;
    return fromStyle;
  }
  const seed = Math.floor(Math.random() * 2 ** 31);
  p.lookSeed = seed;
  return seed;
}

/**
 * Compose the neutral-subject look-plate prompt a style frame is generated
 * from: fixed subject scaffold + setting, only the style tokens and brand
 * vary. Keeps frames comparable across styles and reusable as anchors.
 */
export function styleFramePrompt(
  stylePromptText: string,
  brandClause = "",
  template: string = STYLE_FRAME_TEMPLATE
): string {
  const style = stylePromptText.trim() || "a clean cinematic look";
  const brand = brandClause.trim() ? ` Production palette/typeface: ${brandClause.trim()}` : "";
  return renderPromptTemplate(template, { style, brand }).slice(0, 2000);
}

/**
 * Build the adapter-level request for one shot: assembled prompt + frame at
 * index 0 + frozen model/resolution + board seed. Content refs shift by one
 * when the frame is present — adapters upload styleFramePath first.
 */
export function buildGenerationRequest(
  p: Production,
  shot: ProductionShot,
  prompt: string,
  contentRefs: string[],
  lookClause: string = LOOK_CLAUSE
): GenerationRequest {
  const frame = styleFrameForShot(p, shot);
  return {
    prompt: frame ? withLookClause(prompt, lookClause) : prompt,
    ...(frame ? { styleFramePath: frame.imagePath!.trim() } : {}),
    references: contentRefs,
    seed: ensureLookSeed(p),
    aspect: "16:9",
    model: p.openArt?.model ?? "auto",
    resolution: p.openArt?.resolution ?? "1k",
  };
}
