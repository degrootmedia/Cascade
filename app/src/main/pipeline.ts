/**
 * Pipeline orchestration — guided, fixed steps (NOT a free-form agent loop).
 * Step 1: script text -> scenes/shots JSON via one bounded LLM call ->
 * normalized two-column markdown + Production state.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { nativeImage } from "electron";
import { GabClient } from "@core";
import type { Production, ProductionScene, ProductionShot } from "../shared/ipc.js";
import * as shotter from "./shotter.js";
import { extractScriptText, isGoogleDocUrl } from "./scripting.js";
import type { CharacterSheet, ProductRef, SuggestedReference } from "../shared/ipc.js";

/** Cap on script text sent to the model (chars). ~20k tokens — safe for all chat models. */
const MAX_SCRIPT_CHARS = 80_000;

export type EmitFn = (message: string, level?: "info" | "error" | "done") => void;

/** Scene/shot JSON the model is asked for (unchecked — normalized after parse). */
interface RawScene {
  title?: unknown;
  shots?: Array<{ audio?: unknown; visual?: unknown }>;
}

interface RawCharacter {
  name?: unknown;
  key?: unknown;
}

function systemMessage(): { role: "system"; content: string } {
  return {
    role: "system",
    content:
      "You are a precise script breakdown assistant for an animation pipeline. " +
      "You reply with JSON only — no prose, no markdown fences.",
  };
}

function breakdownPrompt(scriptText: string): { role: "user"; content: string } {
  return {
    role: "user",
    content:
      "Break this script into an animation shot list.\n\n" +
      "Rules:\n" +
      "- A SCENE is a location/time change or a major beat (use the script's own scene headings when present; otherwise group paragraphs sensibly).\n" +
      "- A SHOT is the smallest Audio/Visual unit: one piece of dialogue, VO, or SFX in \"audio\", and what the viewer sees in \"visual\".\n" +
      "- Keep the author's wording for dialogue; describe the visual concretely (subject, framing, action). If the script gives action description, use it for \"visual\".\n" +
      "- Never invent dialogue or shots that aren't in the script. A shot with no dialogue gets \"\" audio and (SFX: …) only when the script implies sound.\n" +
      "- Do NOT number shots — numbers are assigned by the pipeline.\n" +
      "- List every named CHARACTER that appears (\"key\": a one-line visual descriptor from the script, \"\" if none given).\n" +
      "- List any named PRODUCTS (branded items, packaging, hero objects) that must look consistent.\n\n" +
      'Reply with exactly this JSON shape:\n' +
      '{\n  "scenes": [\n    { "title": "Scene heading or short name", "shots": [ { "audio": "…", "visual": "…" } ] }\n  ],\n' +
      '  "characters": [ { "name": "…", "key": "…" } ],\n' +
      '  "products": [ "Product name" ]\n}\n\n' +
      "SCRIPT:\n" +
      scriptText,
  };
}

/** Parse a JSON object from a model reply, tolerating fences and stray prose. */
export function parseJsonLoose(raw: string): Record<string, unknown> {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("Model reply contained no JSON object");
  return JSON.parse(s.slice(start, end + 1));
}

/** Parse the model's reply as JSON, tolerating fences and stray prose around it. */
export function parseBreakdownJson(raw: string): { scenes: RawScene[]; characters?: RawCharacter[]; products?: unknown[] } {
  const parsed = parseJsonLoose(raw);
  if (!Array.isArray(parsed.scenes)) throw new Error("Model JSON is missing the scenes array");
  return parsed as { scenes: RawScene[]; characters?: RawCharacter[]; products?: unknown[] };
}

/** Coerce unchecked model JSON into typed scenes with fresh ids and global 100-grid numbers. */
export function normalizeScenes(raw: { scenes: RawScene[] }): ProductionScene[] {
  const scenes: ProductionScene[] = [];
  let shotNumber = shotter.FIRST_NUMBER;
  let sceneNum = 1;
  for (const rs of raw.scenes ?? []) {
    const shots: ProductionShot[] = [];
    for (const rshot of rs.shots ?? []) {
      const audio = typeof rshot?.audio === "string" ? rshot.audio.trim() : "";
      const visual = typeof rshot?.visual === "string" ? rshot.visual.trim() : "";
      if (!audio && !visual) continue; // skip empty noise rows
      shots.push(shotter.newShot(shotNumber, audio, visual));
      shotNumber = shotter.nextNumber(shotNumber);
    }
    if (!shots.length) continue; // scene with no shots = parsing noise
    scenes.push({
      number: sceneNum++,
      title: typeof rs.title === "string" && rs.title.trim() ? rs.title.trim() : `Scene ${sceneNum}`,
      shots,
    });
  }
  return scenes;
}

/** Merge freshly extracted character names with any already on the production
 *  (matched case-insensitively by name) so re-ingesting never drops artwork. */
export function mergeCharacters(raw: RawCharacter[] | undefined, existing: CharacterSheet[]): CharacterSheet[] {
  const out: CharacterSheet[] = [];
  for (const rc of raw ?? []) {
    const name = typeof rc?.name === "string" ? rc.name.trim() : "";
    if (!name) continue;
    if (out.some((c) => c.name.toLowerCase() === name.toLowerCase())) continue;
    const prev = existing.find((c) => c.name.toLowerCase() === name.toLowerCase());
    out.push({
      id: prev?.id ?? `char-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: prev?.name ?? name,
      key: typeof rc?.key === "string" && rc.key.trim() ? rc.key.trim() : prev?.key ?? "",
      artwork: prev?.artwork,
    });
  }
  // Keep any existing characters the model didn't mention (user may have added them).
  for (const c of existing) {
    if (!out.some((o) => o.id === c.id)) out.push(c);
  }
  return out;
}

/** Same merge for product names. */
export function mergeProducts(raw: unknown[] | undefined, existing: ProductRef[]): ProductRef[] {
  const out: ProductRef[] = [];
  for (const rp of raw ?? []) {
    const name = typeof rp === "string" ? rp.trim() : typeof (rp as { name?: unknown })?.name === "string" ? ((rp as { name: string }).name).trim() : "";
    if (!name) continue;
    if (out.some((p) => p.name.toLowerCase() === name.toLowerCase())) continue;
    const prev = existing.find((p) => p.name.toLowerCase() === name.toLowerCase());
    out.push({
      id: prev?.id ?? `prod-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: prev?.name ?? name,
      artwork: prev?.artwork,
    });
  }
  for (const p of existing) {
    if (!out.some((o) => o.id === p.id)) out.push(p);
  }
  return out;
}

/** Convert model discoveries into suggestions; they are not active references until approved. */
export function suggestedReferences(rawCharacters: RawCharacter[] | undefined, rawProducts: unknown[] | undefined): SuggestedReference[] {
  const out: SuggestedReference[] = [];
  const add = (name: string, kind: SuggestedReference["kind"], key?: string) => {
    if (!name || out.some((r) => r.name.toLowerCase() === name.toLowerCase())) return;
    out.push({ id: `${kind === "character" ? "suggest-char" : "suggest-prod"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name, kind, key: key || undefined });
  };
  for (const c of rawCharacters ?? []) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    if (name) add(name, "character", typeof c.key === "string" ? c.key.trim() : undefined);
  }
  for (const p of rawProducts ?? []) {
    const name = typeof p === "string" ? p.trim() : typeof (p as { name?: unknown })?.name === "string" ? String((p as { name: string }).name).trim() : "";
    if (name) add(name, "product");
  }
  return out;
}

/** Two-column A/V markdown, one table per scene (the human-readable artifact). */export function scriptMarkdown(name: string, scenes: ProductionScene[]): string {
  const lines: string[] = [`# ${name} — Shot Breakdown`, ""];
  for (const scene of scenes) {
    lines.push(`## Scene ${scene.number} — ${scene.title}`, "");
    lines.push("| Shot | Audio | Visual |", "|------|-------|--------|");
    for (const shot of scene.shots) {
      const a = shot.audio.replace(/\|/g, "\\|").replace(/\n/g, " ");
      const v = shot.visual.replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(`| ${shot.number} | ${a} | ${v} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Absolute path of a production asset that lives inside its folder. */
export function assetPath(p: Production, rel: string): string {
  const abs = path.resolve(p.meta.folder, rel);
  const root = path.resolve(p.meta.folder);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Refusing to touch outside the production folder: ${rel}`);
  }
  return abs;
}

/**
 * Move an audio asset into <dir>/archive instead of deleting it, so replaces
 * and regenerations never destroy the previous take. Handles name collisions
 * in the archive by appending a numeric suffix. No-op when the file is
 * missing. `rel` uses forward slashes (e.g. "voiceover/voiceover.mp3").
 */
export function archiveAsset(p: Production, rel: string): void {
  if (!rel) return;
  const src = assetPath(p, rel);
  if (!fs.existsSync(src)) return;
  const slash = rel.lastIndexOf("/");
  const dir = slash >= 0 ? rel.slice(0, slash) : "";
  const archiveDir = dir ? `${dir}/archive` : "archive";
  fs.mkdirSync(assetPath(p, archiveDir), { recursive: true });
  const base = rel.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const name = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let dest = `${archiveDir}/${base}`;
  let i = 1;
  while (fs.existsSync(assetPath(p, dest))) {
    dest = `${archiveDir}/${name} (${i})${ext}`;
    i++;
  }
  try {
    fs.renameSync(src, assetPath(p, dest));
  } catch {
    // Fall back to copy+unlink if a straight rename isn't possible.
    try {
      fs.copyFileSync(src, assetPath(p, dest));
      fs.unlinkSync(src);
    } catch { /* leave it in place rather than destroy it */ }
  }
}

/**
 * Step 2 helper — one bounded LLM call that rewrites the user's style notes
 * into a tighter master visual-style prompt. Returns the refined text only;
 * the caller decides whether to keep it.
 */
export async function refineStylePrompt(
  style: string,
  scriptExcerpt: string,
  apiKey: string,
  model: string
): Promise<string> {
  const gab = new GabClient(apiKey);
  const { text } = await gab.completeOnce(
    model,
    [
      {
        role: "system",
        content:
          "You polish visual style prompts for an image/animation generation pipeline. " +
          "Reply with the refined prompt only — no quotes, no explanation, no markdown.",
      },
      {
        role: "user",
        content:
          "Refine this rough visual style description into a clear, concrete master style prompt " +
          "suitable for prefixing every image-generation request in an animated production. " +
          "Keep the user's intent and named styles/artists; add useful specifics (medium, palette, " +
          "lighting, line treatment) only where the user was vague. AT MOST 3 SENTENCES.\n\n" +
          "STYLE NOTES:\n" + style +
          (scriptExcerpt ? "\n\nSCRIPT EXCERPT (for tone only — do not describe scenes):\n" + scriptExcerpt : ""),
      },
    ],
    600
  );
  const refined = text.trim().replace(/^["']|["']$/g, "");
  if (!refined) throw new Error("The style refinement came back empty.");
  return refined;
}

/**
 * Step 2 helper — one bounded LLM call that fans the user's rough style notes
 * out into up to 5 distinct named visual styles (a short name + a self-contained
 * generation prompt each). The renderer numbers them 1..N and persists them as
 * the production's `styles` set, which drives the per-shot style picker in Step 3.
 */
export async function generateStyleSet(
  notes: string,
  scriptExcerpt: string,
  apiKey: string,
  model: string,
  maxStyles = 5
): Promise<{ name: string; prompt: string }[]> {
  const gab = new GabClient(apiKey);
  const { text } = await gab.completeOnce(
    model,
    [
      {
        role: "system",
        content:
          "You are a visual style director for an animation pipeline. Reply with JSON only — a single array, no markdown fences, no prose.",
      },
      {
        role: "user",
        content:
          `Turn the rough style notes below into ${maxStyles === 1 ? "1 style" : `up to ${maxStyles} distinct styles`} for one animated production. ` +
          "Each style must be a genuinely different look (different medium, palette, rendering, line treatment) so a director can assign " +
          "different scenes to different looks.\n\n" +
          'For each style return exactly: { "name": a short intuitive label (2–4 words), "prompt": a self-contained generation prompt (AT MOST 3 sentences) }.\n' +
          "Aim for the number of styles that genuinely fit the notes (2–5); never pad to the max with near-identical looks. " +
          "Keep each prompt concrete (medium, palette, lighting, texture) and usable standalone as a style prefix.\n\n" +
          'Reply with JSON only, an array: [ { "name": "...", "prompt": "..." } ]\n\n' +
          "STYLE NOTES:\n" + notes +
          (scriptExcerpt ? "\n\nSCRIPT EXCERPT (for tone only — do not describe scenes):\n" + scriptExcerpt : ""),
      },
    ],
    2000
  );
  // Parse a top-level JSON array (tolerate fences / trailing prose).
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let arr: unknown = null;
  try { arr = JSON.parse(t); } catch {
    const s = t.indexOf("["); const e = t.lastIndexOf("]");
    if (s === -1 || e <= s) throw new Error("Style generation returned no JSON array.");
    try { arr = JSON.parse(t.slice(s, e + 1)); } catch { throw new Error("Style generation returned unreadable JSON."); }
  }
  if (!Array.isArray(arr)) throw new Error("Style generation returned no JSON array.");
  const out: { name: string; prompt: string }[] = [];
  for (const item of arr.slice(0, maxStyles)) {
    const o = (item ?? {}) as Record<string, unknown>;
    const name = String(o.name ?? "").trim();
    const prompt = String(o.prompt ?? "").trim();
    if (!name || !prompt) continue;
    out.push({ name: name.slice(0, 60), prompt: prompt.slice(0, 600) });
  }
  if (!out.length) throw new Error("Style generation came back empty — try clearer notes.");
  return out;
}

/**
 * Step 2 helper — one bounded multimodal LLM call that looks at a reference
 * image and distills its look into a single named style ({ name, prompt }).
 * The caller must verify the active model supports image input first.
 */
export async function stylePromptFromImage(
  imageDataUrl: string,
  scriptExcerpt: string,
  apiKey: string,
  model: string
): Promise<{ name: string; prompt: string }> {
  const gab = new GabClient(apiKey);
  const { text } = await gab.completeOnce(
    model,
    [
      {
        role: "system",
        content:
          "You are a visual style director for an animation pipeline. Reply with JSON only — no markdown fences, no prose.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Analyze the attached image's visual style and turn it into one generation style for an animated production.\n" +
              'Return exactly: { "name": a short intuitive label for the look (2–4 words), "prompt": a self-contained style prompt }.\n' +
              "Describe only the style (medium, palette, lighting, line/texture, rendering treatment) — never the specific subject or scene contents. " +
              "The prompt must be AT MOST 3 sentences and usable standalone as a style prefix for image generation.\n\n" +
              (scriptExcerpt
                ? "SCRIPT EXCERPT (for tone only — do not describe scenes):\n" + scriptExcerpt + "\n\n"
                : "") +
              "IMAGE:",
          },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
    700
  );
  const parsed = parseJsonLoose(text);
  const name = String(parsed.name ?? "").trim();
  const prompt = String(parsed.prompt ?? "").trim();
  if (!prompt) throw new Error("Style generation from image came back empty — try a different image.");
  return {
    name: (name || "From image").slice(0, 60),
    prompt: prompt.slice(0, 600),
  };
}

/**
 * Step 3 helper — build the image-generation prompt for one shot's board:
 * master style first, then consistency keys for any character named in the
 * shot, then user-added per-shot references, then the shot's own visual.
 * The global brand palette + font (Step 2) is appended to every frame.
 */
/** Stable portable token for the Nth reference of a shot (0-based). Used in
 *  prompts both ways: sent to OpenArt it gets swapped for the uploaded
 *  reference's unique id; exported for manual generation it stays literal
 *  ("@image1") next to the listed reference files. */
export function refToken(index: number): string {
  return `@image${index + 1}`;
}

/**
 * Map each artwork-bearing reference of a shot to its portable token, in the
 * SAME order the generator uploads them (shotReferences filtered to artwork).
 * Prompt text can then say "Reference @image2 …" and both paths agree on
 * which image that means.
 */
export function refTokens(p: Production, shot: ProductionShot): Map<string, string> {
  const map = new Map<string, string>();
  shotReferences(p, shot)
    .filter((r) => r.artwork)
    .forEach((r, i) => map.set(r.name, refToken(i)));
  return map;
}

/** Convert human-friendly @[name] tags to stable per-shot transport tokens. */
export function resolveReferenceTags(p: Production, shot: ProductionShot, prompt: string): string {
  let resolved = prompt;
  for (const [name, token] of refTokens(p, shot)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    resolved = resolved.replace(new RegExp(`@\\[${escaped}\\]`, "gi"), token);
  }
  return resolved;
}

/**
 * Resolve a shot's style override to its generation text. The dropdown stores
 * the ProductionStyle id; older productions may still carry raw prompt text,
 * so fall back to matching by id, then name, then treating it as literal text.
 */
export function resolveShotStyle(p: Production, shot: ProductionShot): string {
  const s = shot.style?.trim();
  if (!s) return "";
  const byId = p.styles?.find((st) => st.id === s);
  if (byId) return byId.prompt.trim();
  const byName = p.styles?.find((st) => st.name === s);
  if (byName) return byName.prompt.trim();
  return s;
}

export function boardPrompt(p: Production, shot: ProductionShot): string {
  // Paragraph 1 — STYLE. A per-shot style tag overrides the master style: it
  // lets a production mix render languages (e.g. some shots "3D Motion
  // Graphics", others "Photorealistic") without the two bleeding together.
  // With no override, the Step 2 master style is used for every frame (with a
  // legacy free-text visualStyle fallback for older productions).
  const paras: string[] = [];
  const style = resolveShotStyle(p, shot);
  if (style) paras.push(`Style: ${style}.`);
  else {
    const master = (p.styles?.[0]?.prompt ?? "").trim() || (p.visualStyle ?? "").trim();
    if (master) paras.push(`Style: ${master}.`);
  }
  // Paragraph 2 — CONSISTENCY: global brand look, character keys for any
  // character named in the shot, and per-shot references (custom refs and
  // explicitly attached character/product refs). Artwork-bearing refs are
  // cited by a human-friendly tag (@[name]) so each direction is bound
  // to one specific image — the OpenArt path swaps the token for the uploaded
  // reference's unique id; exports keep the literal token next to a numbered
  // reference list.
  const consistency: string[] = [];
   const brand = shot.includeBrandIdentity !== false ? brandPrompt(p) : "";
  if (brand) consistency.push(`Brand identity: ${brand}`);
  const haystack = `${shot.audio} ${shot.visual}`.toLowerCase();
  const excludedIds = new Set(shot.refExcluded ?? []);
  for (const c of p.characters) {
    if (c.key && c.name && !excludedIds.has(c.id) && haystack.includes(c.name.toLowerCase())) consistency.push(`${c.name}: ${c.key}.`);
  }
  if (consistency.length) paras.push(consistency.join("\n"));
  // Paragraph 3 — ACTION: the shot's own visual description.
  paras.push(shot.visual.trim() || "Establishing frame for this moment.");
  // Keep prompts bounded — very long prompts dilute the style tokens.
  return paras.join("\n\n").slice(0, 2000);
}

/** The global brand clause (palette + font) appended to every board prompt. */
export function brandPrompt(p: Production): string {
  const colors = (p.brand?.colors ?? [])
    .map((c) => String(c).trim().replace(/^#/, ""))
    .filter((c) => /^[0-9a-fA-F]{3,6}$/.test(c))
    .slice(0, 5)
    .map((c) => `#${c.toLowerCase()}`);
  const font = (p.brand?.font ?? "").trim();
  const parts: string[] = [];
  if (colors.length) parts.push(`Color palette: ${colors.join(", ")}.`);
  if (font) parts.push(`Brand typeface: ${font}.`);
  return parts.join(" ");
}

/**
 * The prompt actually used to generate/export a shot's board: a user override
 * set in Step 3 wins; otherwise the auto-derived boardPrompt applies.
 */
export function effectivePrompt(p: Production, shot: ProductionShot): string {
  if (shot.prompt?.trim()) {
    const base = shot.prompt.trim();
    const brand = brandPrompt(p);
    const generatedBrand = /(?:^|\n\n)Brand identity: [^\n]*(?=\n\n|$)/;
    if (shot.includeBrandIdentity === false) return base.replace(generatedBrand, "").trim();
    if (brand && !/\n\nBrand identity: /.test(base)) return `${base}\n\nBrand identity: ${brand}`;
    return base;
  }
  return boardPrompt(p, shot);
}

const REFERENCE_CLAUSE_RE = /(?:\n+|^)Reference images by id[^\n]*(?:\n*)$/;

/** Remove an obsolete alias clause from a stored or edited prompt. */
export function stripReferenceClause(prompt: string): string {
  return prompt.replace(REFERENCE_CLAUSE_RE, "").trim();
}

/**
 * The prompt OpenArt ultimately receives for a shot. Human tags are converted
 * to portable tokens here; the OpenArt adapter converts those tokens to the
 * uploaded visualReference ids before calling MCP.
 */
export function openArtPrompt(p: Production, shot: ProductionShot): string {
  const base = resolveReferenceTags(p, shot, stripReferenceClause(effectivePrompt(p, shot)));
  return base;
}

/** A reference resolved for a specific shot: matched character/product, or a
 *  custom reference associated to that shot. */
export interface ShotRef {
  /** Stable id of the source entry (character/product/custom reference) —
   *  used to look up per-shot prompt overrides. */
  id?: string;
  name: string;
  description?: string;
  artwork?: string;
}

/**
 * Work out which references a shot should use:
 *  - characters/products whose name appears in the shot's text (auto-matched);
 *  - characters/products explicitly attached via the shot's `refIds`;
 *  - custom references whose `shotIds` include this shot.
 * Deduplicated by name (first occurrence wins, so auto-matches keep their
 * position and token numbering stays stable).
 */
export function shotReferences(p: Production, shot: ProductionShot): ShotRef[] {
  const out: ShotRef[] = [];
  const push = (r: ShotRef) => {
    if (r.name && !out.some((o) => o.name.toLowerCase() === r.name.toLowerCase())) out.push(r);
  };
  // Only explicit human-friendly tags assign images to a shot. This prevents
  // script text, legacy shot toggles, or old associations from being uploaded.
  const candidates: ShotRef[] = [
    ...p.characters.map((c) => ({ id: c.id, name: c.name, artwork: c.artwork })),
    ...p.products.map((pr) => ({ id: pr.id, name: pr.name, artwork: pr.artwork })),
    ...(p.references ?? []).map((r) => ({ id: r.id, name: r.name, artwork: r.artwork })),
  ];
  for (const match of (shot.prompt ?? "").matchAll(/@\[([^\]]+)\]/g)) {
    const ref = candidates.find((r) => r.name.toLowerCase() === match[1].toLowerCase());
    if (ref) push(ref);
  }
  return out;
}

/** Reference art actually handed to the image generator (those with artwork). */
export interface GenerationRef {
  name: string;
  dataUrl: string;
}

/** Relative path of the shot's archived original (the PNG the model returned
 *  or the file the user imported). Kept in `boardsDir/originals/` so a
 *  regenerate doesn't overwrite it. Never read by the renderer. */
export function boardOriginalRelPath(p: Production, shot: ProductionShot, ext = "png"): string {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  return `${p.assets.boardsDir}/originals/shot-${shot.number}-${tag}.${ext}`;
}

/** Relative path of the served JPEG. The renderer's boardImage/boardThumbnail
 *  IPCs read this file; it lives directly under `boardsDir/`. */
export function boardJpegRelPath(p: Production, shot: ProductionShot): string {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  return `${p.assets.boardsDir}/shot-${shot.number}-${tag}.jpg`;
}

/** Write both the archived original and the served JPEG for a frame. Returns
 *  the JPEG rel (what `shot.artwork` should point to). The original's
 *  extension is preserved (PNG for model output, original ext for imports). */
export function writeBoardFrame(
  p: Production,
  shot: ProductionShot,
  originalBytes: Buffer,
  originalExt: string
): { jpegRel: string; originalRel: string } {
  fs.mkdirSync(assetPath(p, p.assets.boardsDir), { recursive: true });
  fs.mkdirSync(assetPath(p, `${p.assets.boardsDir}/originals`), { recursive: true });
  const originalRel = boardOriginalRelPath(p, shot, originalExt);
  const jpegRel = boardJpegRelPath(p, shot);
  fs.writeFileSync(assetPath(p, originalRel), originalBytes);
  let jpegBytes: Buffer;
  try {
    const img = nativeImage.createFromBuffer(originalBytes);
    jpegBytes = img && !img.isEmpty() ? img.toJPEG(90) : originalBytes;
  } catch {
    jpegBytes = originalBytes;
  }
  fs.writeFileSync(assetPath(p, jpegRel), jpegBytes);
  return { jpegRel, originalRel };
}

/** One-time migration: if `shot.artwork` is a legacy PNG (extension .png) that
 *  lives directly under `boardsDir/`, convert it to a JPEG in the new layout.
 *  Safe to call on every load; it's a no-op when the artwork is already a JPEG
 *  or doesn't exist. */
export function migrateBoardArtworkToJpeg(p: Production, shot: ProductionShot): boolean {
  const rel = shot.artwork;
  if (!rel) return false;
  if (!rel.toLowerCase().endsWith(".png")) return false;
  // Already in originals/ — means a newer write path already ran; the path
  // itself is malformed (we'd never put a PNG there as the live artwork), so
  // rebuild a JPEG path on the fly below.
  const abs = assetPath(p, rel);
  let bytes: Buffer;
  try { bytes = fs.readFileSync(abs); } catch { return false; }
  // Build a fresh JPEG rel (avoid reusing a tag we can't reconstruct) and
  // archive the source PNG to `originals/`.
  const jpegRel = boardJpegRelPath(p, shot);
  const originalRel = boardOriginalRelPath(p, shot, "png");
  fs.mkdirSync(assetPath(p, `${p.assets.boardsDir}/originals`), { recursive: true });
  let jpegBytes: Buffer;
  try {
    const img = nativeImage.createFromBuffer(bytes);
    jpegBytes = img && !img.isEmpty() ? img.toJPEG(90) : bytes;
  } catch {
    jpegBytes = bytes;
  }
  fs.writeFileSync(assetPath(p, jpegRel), jpegBytes);
  try { fs.renameSync(abs, assetPath(p, originalRel)); } catch { /* leave PNG in place; migration is best-effort */ }
  shot.artwork = jpegRel;
  return true;
}

/** Relative path of the production's single voiceover clip. Stable name so
 *  a replacement overwrites the previous version in the project folder. */
export function voiceoverRelPath(p: Production, ext = "mp3"): string {
  return `${p.assets.voiceoverDir}/voiceover.${ext}`;
}

/** How many previous frames each shot keeps (the active one excluded). */
export const BOARD_HISTORY_CAP = 5;

/**
 * Make `rel` the shot's active frame, pushing the previous one into the
 * history (newest first, capped at BOARD_HISTORY_CAP, deduped).
 */
export function recordBoardArtwork(shot: ProductionShot, rel: string): void {
  if (shot.artwork && shot.artwork !== rel) {
    shot.artworkHistory = [shot.artwork, ...(shot.artworkHistory ?? [])]
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, BOARD_HISTORY_CAP);
  }
  shot.artwork = rel;
}

/** Image generator injected by the caller (OpenArt MCP in production).
 *  `refs` carries the shot's reference artwork (if any) for image-input models. */
export type ImageGenFn = (prompt: string, refs: GenerationRef[]) => Promise<Buffer>;

/**
 * Step 3 — generate storyboard frames. Runs the image submissions in parallel
 * (OpenArt accepts concurrent async submissions; each gets its own historyId
 * and resolves as it finishes), capped by `concurrency` to avoid 429s. Shots
 * that already have artwork are skipped unless `regenerateAll`.
 */
export async function generateBoards(
  p: Production,
  generate: ImageGenFn,
  emit: EmitFn,
  opts: { maxShots?: number; regenerateAll?: boolean; onlyShotId?: string; shotIds?: string[]; concurrency?: number } = {}
): Promise<Production> {
  const max = Math.max(1, Math.min(opts.maxShots ?? 50, 200));
  const all = p.scenes.flatMap((s) => s.shots);
  const targets = all.filter((s) =>
    opts.onlyShotId ? s.id === opts.onlyShotId
    : opts.shotIds?.length ? (opts.shotIds as string[]).includes(s.id)
    : opts.regenerateAll || !s.artwork
  ).slice(0, max);
  if (!targets.length) {
    emit(opts.onlyShotId ? "That shot wasn't found." : "Nothing to generate — every shot already has a board.", "error");
    return p;
  }
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, targets.length));
  emit(`Generating ${targets.length} storyboard frame(s)${concurrency > 1 ? ` (up to ${concurrency} in parallel)` : ""}${all.length > targets.length && !opts.onlyShotId ? ` (${all.length - targets.length} already have boards)` : ""}…`);
  fs.mkdirSync(assetPath(p, p.assets.boardsDir), { recursive: true });

  let done = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const shot = targets[next++];
      emit(`Shot ${shot.number}: ${shot.visual.slice(0, 80) || "frame"}…`);
      try {
        const refs = shotReferences(p, shot)
          .filter((r) => r.artwork)
          .map((r) => ({ name: r.name, dataUrl: r.artwork! }));
        const png = await generate(openArtPrompt(p, shot), refs);
        const { jpegRel } = writeBoardFrame(p, shot, png, "png");
        recordBoardArtwork(shot, jpegRel);
        done++;
      } catch (e) {
        failed++;
        emit(`Shot ${shot.number} failed: ${String(e).replace(/^Error:\s*/, "").slice(0, 160)}`, "error");
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  markBoardsStatus(p);
  emit(
    failed
      ? `Step 3 finished with ${done} board(s) generated, ${failed} failed — retry to fill the gaps.`
      : `Step 3 complete — ${done} storyboard frame(s) in ${p.assets.boardsDir}/.`,
    done ? "done" : "error"
  );
  if (!done && failed) throw new Error(`Every board generation failed (${failed}). Check the OpenArt connection and try again.`);
  return p;
}

/** Step 3 is "done" once every shot has a frame. */
function markBoardsStatus(p: Production): void {
  const all = p.scenes.flatMap((s) => s.shots);
  if (all.length && all.every((s) => s.artwork)) p.status[3] = "done";
}

/**
 * Step 3 fallback — write every shot's generation prompt to
 * <boards>/prompts.md so the user can produce the frames in any external
 * tool (OpenArt web UI, Midjourney, …) and drop the results back in.
 * No model call needed; prompts are deterministic.
 */
export function exportBoardPrompts(p: Production, emit: EmitFn): Production {
  const all = p.scenes.flatMap((s) => s.shots);
  if (!all.length) throw new Error("No shots yet — ingest a script in Step 1 first.");
  const lines: string[] = [
    `# ${p.meta.name} — Storyboard Prompts`,
    "",
    "Generate one image per shot with the prompt below it, then save each result",
    "as **<shot number>.png** (e.g. `0100.png`) — either into this folder's",
    `\`${p.assets.boardsDir}/import/\` directory or anywhere, and use **Import frames…**`,
    "in the app to match them to shots.",
    "",
  ];
  for (const shot of all) {
    lines.push(`## Shot ${shot.number}`, "", effectivePrompt(p, shot), "");
    const refs = shotReferences(p, shot);
    if (refs.length) {
      // Number the references @image1, @image2, … in the same order the
      // in-app generator uploads them, so "@image1" in a prompt always means
      // the same image. Attach each artwork file next to its token.
      let n = 0;
      const listed = refs.map((r) => {
        const art = r.artwork ? refToken(n++) : null;
        return `${art ? `${art} — ` : ""}${r.name}${art ? " (artwork attached)" : ""}`;
      });
      lines.push(
        "",
        "Reference" + (refs.length > 1 ? "s" : "") + ": " + listed.join("; "),
        "",
      );
    }
  }
  const mdPath = assetPath(p, `${p.assets.boardsDir}/prompts.md`);
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, lines.join("\n"), "utf8");
  emit(`Wrote ${all.length} prompt(s) to ${p.assets.boardsDir}/prompts.md — generate the frames anywhere, then use "Import frames…".`, "done");
  return p;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/**
 * Step 3 manual-import workflow. Two modes:
 *  - `shotId` given: assign the first file to that shot (per-frame import).
 *  - otherwise: match each file to a shot by the 4-digit shot number in its
 *    filename (e.g. "0100.png", "shot-0120 final.jpg"); unmatched files are
 *    reported and skipped.
 * Matching files are copied into <boards>/ as shot-NNNN.<ext> and the shot's
 * artwork path is set.
 */
export function importBoards(
  p: Production,
  files: string[],
  emit: EmitFn,
  opts: { shotId?: string } = {}
): Production {
  const all = p.scenes.flatMap((s) => s.shots);
  if (!all.length) throw new Error("No shots yet — ingest a script in Step 1 first.");
  const boardsDir = assetPath(p, p.assets.boardsDir);
  fs.mkdirSync(boardsDir, { recursive: true });

  const assign = (shot: ProductionShot, file: string): boolean => {
    const ext = path.extname(file).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) {
      emit(`Skipped ${path.basename(file)} — not a PNG/JPG/WebP image.`, "error");
      return false;
    }
    try {
      const bytes = fs.readFileSync(file);
      const { jpegRel } = writeBoardFrame(p, shot, bytes, ext.slice(1));
      recordBoardArtwork(shot, jpegRel);
      return true;
    } catch (e) {
      emit(`Couldn't import ${path.basename(file)}: ${String(e).slice(0, 120)}`, "error");
      return false;
    }
  };

  let assigned = 0;
  if (opts.shotId) {
    const shot = all.find((s) => s.id === opts.shotId);
    if (!shot) throw new Error("Shot not found.");
    const file = files[0];
    if (!file) return p;
    if (assign(shot, file)) {
      assigned++;
      emit(`Shot ${shot.number}: imported ${path.basename(file)}.`);
    }
  } else {
    const byNumber = new Map(all.map((s) => [s.number, s]));
    for (const file of files) {
      const num = path.basename(file).match(/(\d{4})/)?.[1];
      const shot = num ? byNumber.get(num) : undefined;
      if (!shot) {
        emit(`Skipped ${path.basename(file)} — filename doesn't contain a shot number (name files like "0100.png").`, "error");
        continue;
      }
      if (assign(shot, file)) {
        assigned++;
        emit(`Shot ${shot.number}: imported ${path.basename(file)}.`);
      }
    }
  }

  markBoardsStatus(p);
  const total = all.filter((s) => s.artwork).length;
  emit(
    assigned
      ? `Imported ${assigned} frame(s) — ${total}/${all.length} shots now have boards.`
      : "Nothing was imported.",
    assigned ? "done" : "error"
  );
  return p;
}

/**
 * Scan <boards>/import/ for images named by shot number and import them.
 * Returns the matched files (so callers can report); the heavy lifting is
 * importBoards'.
 */
export function scanBoardImportFolder(p: Production): string[] {
  let dir: string;
  try {
    dir = assetPath(p, `${p.assets.boardsDir}/import`);
  } catch {
    return [];
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => IMAGE_EXTS.has(path.extname(n).toLowerCase()))
    .map((n) => path.join(dir, n));
}

/** Step 4 prompt: assign durations for the animatic. Transitions are always cuts. */
function animaticPrompt(shots: ProductionShot[]): { role: "user"; content: string } {
  const list = shots
    .map((s) => `${s.number} | audio: ${s.audio.slice(0, 120) || "(none)"} | visual: ${s.visual.slice(0, 120)}`)
    .join("\n");
  return {
    role: "user",
    content:
      "You are timing an animatic (storyboard slideshow) for an animated production.\n" +
      "For each shot below, assign:\n" +
      '- "durationSec": seconds on screen. Dialogue shots ≈ words ÷ 2.5 + 1.5s beat; pure-visual/SFX shots 2–4s. Keep between 1.5 and 12.\n' +
      "All cuts are hard cuts; do not include any transition field.\n\n" +
      'Reply with JSON only: { "timing": [ { "number": "0100", "durationSec": 4.5 } ] }\n\n' +
      "SHOTS:\n" + list,
  };
}

/**
 * Step 4 — one bounded LLM call assigns per-shot duration. Unmatched shots
 * keep a 3s default so the timeline is always complete. Also writes
 * out/animatic.md as the human-readable plan.
 */
export async function planAnimatic(
  p: Production,
  apiKey: string,
  model: string,
  emit: EmitFn
): Promise<Production> {
  const shots = p.scenes.flatMap((s) => s.shots);
  if (!shots.length) throw new Error("No shots yet — run Step 1 first.");
  emit(`Timing ${shots.length} shot(s) (model: ${model})…`);
  const gab = new GabClient(apiKey);
  const { text } = await gab.completeOnce(
    model,
    [
      { role: "system", content: "You are a precise animatic timing assistant. Reply with JSON only — no prose, no markdown fences." },
      animaticPrompt(shots),
    ],
    4000
  );
  let timed = 0;
  try {
    const parsed = parseJsonLoose(text) as { timing?: Array<{ number?: unknown; durationSec?: unknown }> };
    const byNumber = new Map(shots.map((s) => [s.number, s]));
    for (const t of parsed.timing ?? []) {
      const num = typeof t?.number === "string" ? t.number.padStart(4, "0") : typeof t?.number === "number" ? String(t.number).padStart(4, "0") : "";
      const shot = byNumber.get(num);
      if (!shot) continue;
      const dur = Number(t.durationSec);
      shot.durationSec = Number.isFinite(dur) ? Math.max(1.5, Math.min(dur, 12)) : 3;
      timed++;
    }
  } catch {
    emit("Couldn't parse the timing reply — applying defaults.", "error");
  }
  // Guarantee a complete timeline even if the model missed shots.
  for (const s of shots) s.durationSec ??= 3;
  const total = shots.reduce((n, s) => n + (s.durationSec ?? 3), 0);
  emit(`Timed ${timed}/${shots.length} shots via the model; total runtime ≈ ${formatRuntime(total)}.`);

  // Human-readable plan artifact.
  const md = animaticMarkdown(p);
  const mdPath = assetPath(p, `${p.assets.outDir}/animatic.md`);
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, md, "utf8");
  emit(`Wrote ${p.assets.outDir}/animatic.md.`);

  p.status[4] = "done";
  emit(`Step 4 complete — animatic timed at ≈ ${formatRuntime(total)}.`, "done");
  return p;
}

/** mm:ss runtime label. */
export function formatRuntime(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Step 4 artifact: the timing plan as markdown. */
export function animaticMarkdown(p: Production): string {
  const lines: string[] = [`# ${p.meta.name} — Animatic Plan`, ""];
  let total = 0;
  for (const scene of p.scenes) {
    lines.push(`## Scene ${scene.number} — ${scene.title}`, "");
    lines.push("| Shot | Duration | Audio | Visual |", "|------|----------|-------|--------|");
    for (const shot of scene.shots) {
      const d = shot.durationSec ?? 3;
      total += d;
      const a = shot.audio.replace(/\|/g, "\\|").replace(/\n/g, " ");
      const v = shot.visual.replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(`| ${shot.number} | ${d.toFixed(1)}s | ${a} | ${v} |`);
    }
    lines.push("");
  }
  lines.push(`**Total runtime: ${formatRuntime(total)}**`, "");
  return lines.join("\n");
}

/** OpenAI-compatible TTS endpoint exposed by gab.ai. Override here if the
 *  gateway shape changes. The request body is the standard `{model, input,
 *  voice}` shape. Depending on the provider, the response is either raw audio
 *  bytes OR a JSON envelope `{ url, content_type }` pointing at a CDN file —
 *  `resolveAudioResponse` handles both. */
export const VOICEOVER_ENDPOINT = "https://gab.ai/v1/audio/speech";

/**
 * Music generation reuses the same audio/speech endpoint — a music model
 * (e.g. `music-2-0`) treats `input` as a music prompt and ignores `voice`.
 * Kept as its own constant so it's a one-line swap if gab.ai ever exposes a
 * dedicated music route.
 */
export const MUSIC_ENDPOINT = VOICEOVER_ENDPOINT;

/** Resolve an audio-generation HTTP response into the actual audio bytes.
 *  gab.ai returns raw bytes for some providers and a JSON envelope
 *  `{ url, content_type }` for others — normalize either into bytes. */
async function resolveAudioResponse(res: Response): Promise<{ bytes: Buffer; ext: string }> {
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("json")) {
    const json = (await res.json()) as Record<string, unknown>;
    const url = typeof json.url === "string" && json.url ? json.url : null;
    if (!url) {
      throw new Error(`Audio endpoint returned JSON without a url: ${JSON.stringify(json).slice(0, 240)}`);
    }
    const dl = await fetch(url);
    if (!dl.ok) throw new Error(`Couldn't download generated audio (HTTP ${dl.status})`);
    const bytes = Buffer.from(await dl.arrayBuffer());
    const contentType = String(json.content_type ?? dl.headers.get("content-type") ?? "").toLowerCase();
    const ext = contentType.includes("wav") ? "wav"
      : contentType.includes("mp4") || contentType.includes("m4a") || contentType.includes("aac") ? "m4a"
      : "mp3";
    return { bytes, ext };
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new Error("Audio endpoint returned an empty response.");
  return { bytes, ext: "mp3" };
}

/** OpenAI-style voice ids accepted by gab.ai's TTS gateway. */
export const VOICEOVER_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
/** ElevenLabs-style voice ids (sample of their stock library). */
export const ELEVENLABS_VOICES = ["rachel", "domi", "bella", "antoni", "elli", "josh", "arnold", "adam", "sam"] as const;
export type VoiceoverVoice = string;

/** Look up the voice ids a given TTS model accepts. The registry doesn't
 *  expose per-model voice lists yet, so this is a family-based heuristic;
 *  update the matchers here as new model families are onboarded. */
export function voicesForModel(modelId: string): readonly string[] {
  const id = modelId.toLowerCase();
  if (id.includes("elevenlabs") || id.includes("eleven_")) return ELEVENLABS_VOICES;
  if (id.includes("qwen") || id.includes("multitalk")) return ["default", "male", "female"] as const;
  // Default: OpenAI-style TTS (gpt-4o-mini-tts and similar).
  return VOICEOVER_VOICES;
}

/** Workspace-relative path of the production's music file. Stored once. */
export function musicRelPath(p: Production, ext = "mp3"): string {
  return `${p.assets.musicDir}/music.${ext}`;
}

/**
 * Step 4 — generate one voiceover clip for the whole production. The text is
 * every non-empty shot dialogue joined with newlines so the model reads it
 * as a single take. Writes the mp3 into voiceoverDir and records the
 * relative path on the production. Returns the production (mutated).
 */
export async function generateVoiceover(
  p: Production,
  apiKey: string,
  opts: { model: string; voice: string },
  emit: EmitFn
): Promise<Production> {
  const lines = p.scenes
    .flatMap((s) => s.shots)
    .map((s) => s.audio.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error("No dialogue in the script — add some in Step 1 first.");
  const text = lines.join("\n");
  emit(`Synthesizing voiceover (${lines.length} line${lines.length === 1 ? "" : "s"}, ${text.length} chars) with ${opts.model} (voice: ${opts.voice})…`);
  const res = await fetch(VOICEOVER_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: opts.model, input: text, voice: opts.voice }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`TTS request failed (${res.status} ${res.statusText}): ${body.slice(0, 240)}`);
  }
  const { bytes, ext } = await resolveAudioResponse(res);
  fs.mkdirSync(assetPath(p, p.assets.voiceoverDir), { recursive: true });
  const rel = voiceoverRelPath(p, ext);
  // Replace behavior: archive the previous clip instead of destroying it.
  // This also covers regenerating the same stable name (voiceover.<ext>),
  // where the old file would otherwise be overwritten in place.
  if (p.voiceoverPath) {
    archiveAsset(p, p.voiceoverPath);
  }
  // Also archive any stale voiceover.* files with different extensions.
  try {
    const dir = assetPath(p, p.assets.voiceoverDir);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith("voiceover.") && `${p.assets.voiceoverDir}/${f}` !== rel) {
        archiveAsset(p, `${p.assets.voiceoverDir}/${f}`);
      }
    }
  } catch { /* ignore */ }
  fs.writeFileSync(assetPath(p, rel), bytes);
  p.voiceoverPath = rel;
  if (typeof p.voiceoverVolume !== "number") p.voiceoverVolume = 1;
  emit(`Voiceover written to ${rel} (${(bytes.length / 1024).toFixed(1)} KB).`, "done");
  return p;
}

/**
 * Step 4 — generate one background music clip from a text prompt. Uses the
 * same audio/speech endpoint with a music model (music-2-0 / music-2-6), where
 * `input` is the music prompt and `voice` is ignored. Writes the audio into
 * musicDir as a generated track and records the relative path. Returns the
 * production (mutated). Generated clips keep a stable name (imports keep
 * their original filenames — see production:importMusic).
 */
export async function generateMusic(
  p: Production,
  apiKey: string,
  opts: { model: string; prompt: string },
  emit: EmitFn
): Promise<Production> {
  const prompt = opts.prompt.trim();
  if (!prompt) throw new Error("Describe the music first (style, mood, length).");
  emit(`Synthesizing music (${prompt.length} chars) with ${opts.model}…`);
  const res = await fetch(MUSIC_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: opts.model, input: prompt, voice: "" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Music request failed (${res.status} ${res.statusText}): ${body.slice(0, 240)}`);
  }
  const { bytes, ext } = await resolveAudioResponse(res);
  fs.mkdirSync(assetPath(p, p.assets.musicDir), { recursive: true });
  const rel = `${p.assets.musicDir}/music-generated.${ext}`;
  // Replace behavior: archive the previous track instead of destroying it
  // (also covers regenerating the same stable name).
  if (p.musicPath) {
    archiveAsset(p, p.musicPath);
  }
  fs.writeFileSync(assetPath(p, rel), bytes);
  p.musicPath = rel;
  if (typeof p.musicVolume !== "number") p.musicVolume = 0.5;
  emit(`Music written to ${rel} (${(bytes.length / 1024).toFixed(1)} KB).`, "done");
  return p;
}

/**
 * Step 1 — ingest a script into scenes/shots. Mutates and returns the
 * production; the caller persists it.
 */
export async function ingestScript(
  p: Production,
  source: string,
  apiKey: string,
  model: string,
  emit: EmitFn
): Promise<Production> {
  const label = isGoogleDocUrl(source) ? "Google Doc" : path.basename(source);
  emit(`Extracting text from ${label}…`);
  const { text, format } = await extractScriptText(source);
  if (!text) throw new Error("No text could be extracted from that source.");
  emit(`Extracted ${text.length.toLocaleString()} characters (${format}).`);

  let scriptText = text;
  if (scriptText.length > MAX_SCRIPT_CHARS) {
    scriptText = scriptText.slice(0, MAX_SCRIPT_CHARS);
    emit(`Script is long — sending the first ${MAX_SCRIPT_CHARS.toLocaleString()} characters only.`, "error");
  }

  emit(`Breaking into scenes and shots (model: ${model})…`);
  const gab = new GabClient(apiKey);
  const { text: reply } = await gab.completeOnce(model, [systemMessage(), breakdownPrompt(scriptText)], 8000);
  const parsed = parseBreakdownJson(reply);
  const scenes = normalizeScenes(parsed);
  const shotCount = scenes.reduce((n, s) => n + s.shots.length, 0);
  if (!shotCount) throw new Error("The breakdown came back with no shots — check the script and retry.");
  emit(`Parsed ${scenes.length} scene(s), ${shotCount} shot(s).`);

  // Keep discoveries separate so ingest never silently creates active references.
  p.suggestedReferences = suggestedReferences(parsed.characters, parsed.products);
  if (p.suggestedReferences.length) emit(`Found ${p.suggestedReferences.length} suggested character/prop reference(s).`);

  // Preserve manually edited board prompts across re-ingestion. The old shot
  // list is about to be replaced, so stash each manually edited prompt keyed
  // by its shot number first; freshly numbered shots that land on a stashed
  // number get their manual prompt back below.
  const overrides: Record<string, string> = { ...(p.promptOverrides ?? {}) };
  for (const s of p.scenes.flatMap((sc) => sc.shots)) {
    if (s.promptManual && s.prompt?.trim()) overrides[s.number] = s.prompt.trim();
    else delete overrides[s.number];
  }
  p.promptOverrides = overrides;

  // Write the two-column markdown artifact inside the production folder.
  const md = scriptMarkdown(p.meta.name, scenes);
  const mdPath = assetPath(p, p.assets.scriptMd);
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, md, "utf8");
  emit(`Wrote ${p.assets.scriptMd} to the production folder.`);

  p.scenes = scenes;
  // Restore manual prompts onto shots whose number matches a stashed override.
  let restored = 0;
  for (const s of p.scenes.flatMap((sc) => sc.shots)) {
    const manual = overrides[s.number];
    if (manual) {
      s.prompt = manual;
      s.promptManual = true;
      restored++;
    }
  }
  if (restored) emit(`Kept ${restored} manually edited prompt(s) from the previous breakdown.`);
  p.status[1] = "done";
  p.scriptSource = label;
  emit(`Step 1 complete — ${shotCount} shots, numbered ${scenes[0].shots[0].number}–${scenes[scenes.length - 1].shots.slice(-1)[0].number}.`, "done");
  return p;
}
