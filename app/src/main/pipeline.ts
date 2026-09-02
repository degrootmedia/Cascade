/**
 * Pipeline orchestration — guided, fixed steps (NOT a free-form agent loop).
 * Step 1: script text -> scenes/shots JSON via one bounded LLM call ->
 * normalized two-column markdown + Production state.
 */
import * as fs from "node:fs";
import * as path from "node:path";
// Soft dependency: JPEG conversion needs Electron's nativeImage, but this
// module must also load outside Electron (vitest). Files still save without
// it — only the JPEG conversion falls back to the original bytes.
let nativeImage: typeof import("electron").nativeImage | undefined;
void import("electron")
  .then((m) => {
    nativeImage = m.nativeImage;
  })
  .catch(() => {});
import { GabClient } from "@core";
import {
  escapeRegExp,
  insertBrandParagraph,
  parseJsonLooseArray,
  parseJsonLooseObject,
  parsePromptBoxes,
  refTagMatches,
  stripBrandParagraph,
  stripReferenceClause,
  stripStyleParagraph,
} from "../shared/prompt-grammar.js";
import type { Production, ProductionScene, ProductionShot, GraphGenItem } from "../shared/ipc.js";
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

/** Parse the model's reply as JSON, tolerating fences and stray prose around it. */
export function parseBreakdownJson(raw: string): { scenes: RawScene[]; characters?: RawCharacter[]; products?: unknown[] } {
  const parsed = parseJsonLooseObject(raw);
  if (!parsed || !Array.isArray(parsed.scenes)) throw new Error("Model reply contained no JSON object");
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
  const arr = parseJsonLooseArray(text);
  if (!arr) throw new Error("Style generation returned no JSON array.");
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
  const parsed = parseJsonLooseObject(text);
  const name = String(parsed?.name ?? "").trim();
  const prompt = String(parsed?.prompt ?? "").trim();
  if (!prompt) throw new Error("Style generation from image came back empty — try a different image.");
  return {
    name: (name || "From image").slice(0, 60),
    prompt: prompt.slice(0, 600),
  };
}

/**
 * Magic Prompt — content-only generation for the full storyboard.
 * The style system stays separate (Style:/Brand paragraphs are not included).
 * Generation parameters (prompt template, rules) live in the magic-prompt
 * skill md file so cascade devs can update them without code changes.
 */
let cachedMagicSkill: string | null | undefined;
export function loadMagicSkillText(): string | null {
  if (cachedMagicSkill !== undefined) return cachedMagicSkill;
  const candidates: string[] = [];
  try {
    // When bundled, __dirname is app/out/main
    const base = typeof __dirname !== "undefined" ? __dirname : process.cwd();
    candidates.push(path.join(base, "magic-prompt.md"));
    candidates.push(path.join(base, "..", "skills", "magic-prompt.md"));
    candidates.push(path.join(base, "..", "..", "skills", "magic-prompt.md"));
    candidates.push(path.join(base, "..", "..", "app", "skills", "magic-prompt.md"));
    candidates.push(path.join(process.cwd(), "skills", "magic-prompt.md"));
    candidates.push(path.join(process.cwd(), "app", "skills", "magic-prompt.md"));
    candidates.push(path.join(process.cwd(), "app", "src", "main", "magic-prompt.md"));
  } catch {}
  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand)) {
        const t = fs.readFileSync(cand, "utf8");
        if (t.trim()) { cachedMagicSkill = t; return t; }
      }
    } catch {}
  }
  cachedMagicSkill = null;
  return null;
}
export function clearMagicSkillCache(): void { cachedMagicSkill = undefined; }

export function stripMagicLeakage(text: string): string {
  let t = text.trim();
  // Model sometimes leaks Style:/Brand paragraphs despite instructions — strip them
  t = stripStyleParagraph(t);
  t = stripBrandParagraph(t);
  // Also strip stray prefixes like "Content:" or quoted wrappers
  t = t.replace(/^\s*Content:\s*/i, "");
  t = t.replace(/^["']|["']$/g, "");
  return t.trim();
}

/**
 * One bounded LLM call that generates CONTENT-ONLY prompts for every shot.
 * Uses the magic-prompt skill file as the prompt source when available,
 * otherwise falls back to the embedded template.
 * Returns a map of shotId → content prompt and mutates the production to
 * store it with magicEnabled=true.
 */
export async function generateMagicPrompts(
  p: Production,
  apiKey: string,
  model: string,
  emit: EmitFn
): Promise<Production> {
  const shots = p.scenes.flatMap((s) => s.shots);
  if (!shots.length) throw new Error("No shots yet — ingest a script in Step 1 first.");
  const skillText = loadMagicSkillText();
  // Build shot list for the model: number | audio | visual | currentContent (stripped)
  const shotLines = shots.map((s) => {
    const boxes = parsePromptBoxes(effectivePrompt(p, s));
    // Current content without style/brand — what magic replaces
    const curContent = boxes.content.trim() || s.visual.trim() || "(no visual direction)";
    const audio = s.audio.trim() ? s.audio.trim().slice(0, 220) : "(no dialogue)";
    const visual = s.visual.trim() ? s.visual.trim().slice(0, 400) : "(no visual direction)";
    return `${s.number} | audio: ${audio} | visual: ${visual} | current prompt content: ${curContent.slice(0, 500)}`;
  }).join("\n");

  const refNames = [
    ...p.characters.map((c) => c.name).filter(Boolean),
    ...p.products.map((pr) => pr.name).filter(Boolean),
    ...(p.references ?? []).map((r) => r.name).filter(Boolean),
  ];
  const refList = refNames.length ? refNames.map((n) => `@[${n}]`).join(", ") : "(none)";

  // Use skill file as instruction source when available (fallback embedded)
  const skillPrefix = skillText ? skillText.slice(0, 2000) : "";
  const systemContent = skillPrefix
    ? "You are a cinematic storyboard prompt engineer. Reply with JSON only — no prose, no markdown fences. Follow the MAGIC PROMPT skill instructions verbatim. Content prompts only — never style language.\n\nSKILL:\n" + skillPrefix
    : "You are a cinematic storyboard prompt engineer for an animation pipeline. Reply with JSON only — no prose, no markdown fences. You write CONTENT prompts only — never style language.";

  const userContent =
    "You are a storyboard image-prompt generator. Analyze the full script and visual direction and produce a CONTENT-ONLY prompt for each shot.\n\n" +
    "Rules:\n" +
    "- CONTENT ONLY: Describe subject, framing, action, camera (wide/medium/closeup), composition, key props and characters, setting, time of day, mood conveyed by content.\n" +
    "- NEVER include style words: no medium, palette, lighting style, line treatment, rendering, brush, painterly, photorealistic, 3D, anime, etc. The style system will handle that.\n" +
    "- Keep each prompt to 1-3 sentences, concrete and visual, suitable to append after a \"Style:\" paragraph.\n" +
    "- Understand flow: track continuity across shots — maintain character presence, location progression, action continuity, and shot-to-shot rhythm. Adjacent shots should read as a visual sequence, not isolated images.\n" +
    "- Include ALL elements needed in each frame: foreground/background elements, character count and placement, key objects from references when tagged, and any text-implied visuals (e.g. SFX sources).\n" +
    "- Respect @[Name] reference tags if present — keep them verbatim when that reference should appear in the frame; omit when not needed for this shot's content.\n" +
    "- Do NOT invent dialogue or off-screen elements. If audio is provided, use it only to infer what should be visible (speaker, mouth, context) — don't quote it.\n\n" +
    "Shots (in order):\n" + shotLines + "\n\n" +
    "References available (name — will be inserted as @[Name] where needed):\n" + refList + "\n\n" +
    'Reply with JSON only: { "prompts": [ { "number": "0100", "prompt": "..." }, ... ] }\nOrder must match the shot numbers given, one entry per shot.';

  emit(`Generating Magic Prompts for ${shots.length} shot(s) (model: ${model})…`);
  const gab = new GabClient(apiKey);
  const { text } = await gab.completeOnce(
    model,
    [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
    8000
  );

  const parsed = parseJsonLooseObject(text);
  const rawPrompts = (parsed?.prompts ?? parsed?.shots ?? parsed?.data) as unknown;
  let arr: unknown[] | null = null;
  if (Array.isArray(rawPrompts)) arr = rawPrompts;
  else if (Array.isArray(parsed)) arr = parsed as unknown[];
  else {
    // Try loose array extraction
    const loose = parseJsonLooseArray(text);
    if (loose) arr = loose;
  }
  if (!arr || !arr.length) throw new Error("Magic Prompt generation returned no JSON prompts — try again.");

  const byNumber = new Map(shots.map((s) => [s.number, s]));
  const byNumberLoose = new Map(shots.map((s) => [s.number.padStart(4, "0"), s]));
  const generated: Record<string, string> = {};
  let matched = 0;
  for (const item of arr) {
    const o = (item ?? {}) as Record<string, unknown>;
    const rawNum = String(o.number ?? o.shot ?? o.id ?? "").trim();
    const num = rawNum.padStart(4, "0");
    const shot = byNumber.get(num) ?? byNumberLoose.get(num) ?? byNumber.get(rawNum);
    if (!shot) continue;
    let prompt = String(o.prompt ?? o.content ?? o.text ?? "").trim();
    if (!prompt) continue;
    prompt = stripMagicLeakage(prompt).slice(0, 600);
    if (!prompt) continue;
    generated[shot.id] = prompt;
    matched++;
  }
  if (!matched) throw new Error("Magic Prompt generation produced no matching shot numbers — try again.");
  // Fill gaps with fallback (keep existing visual or previous content)
  for (const s of shots) {
    if (!generated[s.id]) {
      const fallback = stripMagicLeakage(parsePromptBoxes(effectivePrompt(p, s)).content) || s.visual.trim() || "Establishing frame for this moment.";
      generated[s.id] = fallback.slice(0, 600);
    }
  }
  p.magicPrompts = generated;
  p.magicEnabled = true;
  emit(`Magic Prompt generated ${Object.keys(generated).length} prompt(s) — enabled.`, "done");
  return p;
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
    resolved = resolved.replace(new RegExp(`@\\[${escapeRegExp(name)}\\]`, "gi"), token);
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

/** The Style text a shot's prompt should carry: its per-shot override, else the
 *  master style — unless the user explicitly picked "None" (styleNone), which
 *  suppresses the paragraph entirely (the master fallback must not sneak back). */
export function effectiveShotStyle(p: Production, shot: ProductionShot): string {
  if (shot.styleNone) return "";
  const s = resolveShotStyle(p, shot);
  if (s) return s;
  return (p.styles?.[0]?.prompt ?? "").trim() || (p.visualStyle ?? "").trim();
}

export function boardPrompt(p: Production, shot: ProductionShot): string {
  // Paragraph 1 — STYLE. A per-shot style tag overrides the master style: it
  // lets a production mix render languages (e.g. some shots "3D Motion
  // Graphics", others "Photorealistic") without the two bleeding together.
  // With no override, the Step 2 master style is used for every frame (with a
  // legacy free-text visualStyle fallback for older productions).
  const paras: string[] = [];
  const style = effectiveShotStyle(p, shot);
  // No auto-appended period — style texts usually end with their own, and
  // adding another produced "render..". Used verbatim, matching the
  // renderer's style paragraph composer.
  if (style) paras.push(`Style: ${style}`);
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
  if (font) parts.push(`Font: ${font}.`);
  return parts.join(" ");
}

/**
 * The prompt actually used to generate/export a shot's board: a user override
 * set in Step 3 wins; otherwise the auto-derived boardPrompt applies.
 * When Magic Prompt is enabled, its alternate content store takes precedence
 * (still wrapped with Style/Brand paragraphs so style system remains separate).
 */
export function effectivePrompt(p: Production, shot: ProductionShot): string {
  if (p.magicEnabled && p.magicPrompts?.[shot.id]?.trim()) {
    const content = stripMagicLeakage(p.magicPrompts[shot.id].trim());
    const paras: string[] = [];
    const style = effectiveShotStyle(p, shot);
    if (style) paras.push(`Style: ${style}`);
    const consistency: string[] = [];
    const brand = shot.includeBrandIdentity !== false ? brandPrompt(p) : "";
    if (brand) consistency.push(`Brand identity: ${brand}`);
    const haystack = `${shot.audio} ${shot.visual}`.toLowerCase();
    const excludedIds = new Set(shot.refExcluded ?? []);
    for (const c of p.characters) {
      if (c.key && c.name && !excludedIds.has(c.id) && haystack.includes(c.name.toLowerCase())) consistency.push(`${c.name}: ${c.key}.`);
    }
    if (consistency.length) paras.push(consistency.join("\n"));
    paras.push(content || "Establishing frame for this moment.");
    const base = paras.join("\n\n").slice(0, 2000);
    // Respect includeBrandIdentity flag (magic content is brand-aware)
    if (shot.includeBrandIdentity === false) return stripBrandParagraph(base);
    return base;
  }
  if (shot.prompt?.trim()) {
    const base = shot.prompt.trim();
    const brand = brandPrompt(p);
    if (shot.includeBrandIdentity === false) return stripBrandParagraph(base);
    if (brand) return insertBrandParagraph(base, brand);
    return base;
  }
  return boardPrompt(p, shot);
}

/** Return the raw content-only text that effectivePrompt will use for this shot (without Style/Brand wrappers). */
export function effectivePromptContent(p: Production, shot: ProductionShot): string {
  if (p.magicEnabled && p.magicPrompts?.[shot.id]?.trim()) return stripMagicLeakage(p.magicPrompts[shot.id].trim());
  if (shot.prompt?.trim()) return parsePromptBoxes(shot.prompt).content.trim() || shot.prompt.trim();
  return shot.visual.trim() || "Establishing frame for this moment.";
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

/** Reference artwork as an uploadable data URL: an on-disk `imagePath` is read
 *  at call time (references live in referencesDir as files), with legacy inline
 *  data URLs as the fallback. Returns undefined when no artwork is available. */
export function refArtworkDataUrl(p: Production, ref: { imagePath?: string; artwork?: string }): string | undefined {
  if (ref.imagePath) {
    try {
      const buf = fs.readFileSync(assetPath(p, ref.imagePath));
      const ext = path.extname(ref.imagePath).slice(1).toLowerCase() || "png";
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/png";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      return undefined;
    }
  }
  return ref.artwork || undefined;
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
    ...p.characters.map((c) => ({ id: c.id, name: c.name, artwork: refArtworkDataUrl(p, c) })),
    ...p.products.map((pr) => ({ id: pr.id, name: pr.name, artwork: refArtworkDataUrl(p, pr) })),
    ...(p.references ?? []).map((r) => ({ id: r.id, name: r.name, artwork: refArtworkDataUrl(p, r) })),
  ];
  const promptForTags = p.magicEnabled && p.magicPrompts?.[shot.id]?.trim()
    ? p.magicPrompts[shot.id]
    : shot.prompt ?? "";
  for (const { name } of refTagMatches(promptForTags)) {
    const ref = candidates.find((r) => r.name.toLowerCase() === name.toLowerCase());
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
 *  or the file the user imported). Kept in the shot's `originals/` subfolder
 *  so a regenerate doesn't overwrite it. Never read by the renderer. */
export function boardOriginalRelPath(p: Production, shot: ProductionShot, ext = "png"): string {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  return `${p.assets.boardsDir}/${shot.number}/originals/shot-${shot.number}-${tag}.${ext}`;
}

/** Relative path of the served JPEG, grouped by shot. The renderer's
 *  boardImage/boardThumbnail IPCs read this file. */
export function boardJpegRelPath(p: Production, shot: ProductionShot): string {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  return `${p.assets.boardsDir}/${shot.number}/shot-${shot.number}-${tag}.jpg`;
}

/** Write both the archived original and the served JPEG for a frame. Returns
 *  the JPEG rel (what `shot.artwork` should point to). The original's
 *  extension is preserved (PNG for model output, original ext for imports).
 *  Both files share the same tag so the original ↔ JPEG mapping is
 *  deterministic — the external editor opens the original and the JPEG is
 *  regenerated from it when the file is edited externally. */
export function writeBoardFrame(
  p: Production,
  shot: ProductionShot,
  originalBytes: Buffer,
  originalExt: string
): { jpegRel: string; originalRel: string } {
  fs.mkdirSync(assetPath(p, `${p.assets.boardsDir}/${shot.number}`), { recursive: true });
  fs.mkdirSync(assetPath(p, `${p.assets.boardsDir}/${shot.number}/originals`), { recursive: true });
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const safeExt = (originalExt || "png").replace(/^\./, "").toLowerCase() || "png";
  const originalRel = `${p.assets.boardsDir}/${shot.number}/originals/shot-${shot.number}-${tag}.${safeExt}`;
  const jpegRel = `${p.assets.boardsDir}/${shot.number}/shot-${shot.number}-${tag}.jpg`;
  fs.writeFileSync(assetPath(p, originalRel), originalBytes);
  let jpegBytes: Buffer;
  try {
    const img = nativeImage?.createFromBuffer(originalBytes);
    jpegBytes = img && !img.isEmpty() ? img.toJPEG(90) : originalBytes;
  } catch {
    jpegBytes = originalBytes;
  }
  fs.writeFileSync(assetPath(p, jpegRel), jpegBytes);
  return { jpegRel, originalRel };
}

/** Derive the expected JPEG path for an original, or null when it isn't a
 *  board original (`boards/<shot>/originals/shot-<shot>-<tag>.<ext>`). */
export function jpegForOriginalRel(p: Production, originalRel: string): string | null {
  const esc = p.assets.boardsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^${esc}/(\\d{4})/originals/shot-\\d{4}-([^/]+)\\.[^/]+$`).exec(originalRel);
  if (!m) return null;
  const shotNumber = m[1];
  const tag = m[2];
  return `${p.assets.boardsDir}/${shotNumber}/shot-${shotNumber}-${tag}.jpg`;
}

/** Find the archived original file for a board JPEG (`boards/<shot>/shot-<shot>-<tag>.jpg`).
 *  With the post-fix layout both files share the tag, so a direct lookup works.
 *  For legacy frames that used independent tags, the scan falls back to the
 *  newest file in that shot's `originals/` directory. Returns the
 *  workspace-relative original rel or null when none exists. */
export function originalForJpegRel(p: Production, jpegRel: string): string | null {
  const esc = p.assets.boardsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^${esc}/(\\d{4})/shot-\\d{4}-([^/]+)\\.jpg$`, "i").exec(jpegRel);
  if (!m) return null;
  const shotNumber = m[1];
  const tag = m[2];
  const originalsDir = `${p.assets.boardsDir}/${shotNumber}/originals`;
  let absDir: string;
  try {
    absDir = assetPath(p, originalsDir);
  } catch {
    return null;
  }
  // Direct tag match first — the high-quality file the external editor edits.
  try {
    const files = fs.readdirSync(absDir);
    const direct = files.find((f) => f === `shot-${shotNumber}-${tag}.png` || f === `shot-${shotNumber}-${tag}.jpg` || f === `shot-${shotNumber}-${tag}.jpeg` || f === `shot-${shotNumber}-${tag}.webp` || f.startsWith(`shot-${shotNumber}-${tag}.`));
    if (direct) return `${originalsDir}/${direct}`;
    // Legacy: tags diverged — pick the newest original for that shot.
    let newest: { rel: string; mtime: number } | null = null;
    for (const f of files) {
      if (!/^shot-\d{4}-.+\.\w+$/.test(f)) continue;
      try {
        const st = fs.statSync(path.join(absDir, f));
        if (!newest || st.mtimeMs > newest.mtime) newest = { rel: `${originalsDir}/${f}`, mtime: st.mtimeMs };
      } catch {}
    }
    return newest?.rel ?? null;
  } catch {
    return null;
  }
}

/** Re-encode `originalRel` into `jpegRel` (90-quality JPEG). Returns true
 *  when the JPEG was overwritten, false when the original couldn't be read. */
export function regenerateBoardJpeg(p: Production, originalRel: string, jpegRel: string): boolean {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(assetPath(p, originalRel));
  } catch {
    return false;
  }
  let jpegBytes: Buffer;
  try {
    const img = nativeImage?.createFromBuffer(bytes);
    jpegBytes = img && !img.isEmpty() ? img.toJPEG(90) : bytes;
  } catch {
    jpegBytes = bytes;
  }
  try {
    fs.mkdirSync(path.dirname(assetPath(p, jpegRel)), { recursive: true });
    fs.writeFileSync(assetPath(p, jpegRel), jpegBytes);
    return true;
  } catch {
    return false;
  }
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
  fs.mkdirSync(assetPath(p, `${p.assets.boardsDir}/${shot.number}/originals`), { recursive: true });
  let jpegBytes: Buffer;
  try {
    const img = nativeImage?.createFromBuffer(bytes);
    jpegBytes = img && !img.isEmpty() ? img.toJPEG(90) : bytes;
  } catch {
    jpegBytes = bytes;
  }
  fs.writeFileSync(assetPath(p, jpegRel), jpegBytes);
  try { fs.renameSync(abs, assetPath(p, originalRel)); } catch { /* leave PNG in place; migration is best-effort */ }
  shot.artwork = jpegRel;
  return true;
}

/** One-time layout migration: storyboard frames used to live flat under
 *  `boards/` (`boards/shot-0100-<tag>.jpg` + `boards/originals/…`). They now
 *  live in a per-shot subfolder (`boards/0100/shot-0100-<tag>.jpg`,
 *  `boards/0100/originals/…`). Moves every referenced file (artwork, history,
 *  node-graph generations) plus the archived originals directory. Idempotent —
 *  already-relocated paths no longer match the flat pattern. */
export function relocateBoardLayout(p: Production, shot: ProductionShot): boolean {
  let changed = false;
  const move = (rel: string): string => {
    if (!rel) return rel;
    const flat = /^([^/]+)\/shot-(\d{4})-[^/]+\.(?:jpg|png|webp)$/i.exec(rel);
    if (!flat || flat[1] !== p.assets.boardsDir) return rel;
    const newRel = `${p.assets.boardsDir}/${flat[2]}/${path.basename(rel)}`;
    if (newRel === rel) return rel;
    try {
      const abs = assetPath(p, rel);
      if (!fs.existsSync(abs)) return rel;
      fs.mkdirSync(assetPath(p, `${p.assets.boardsDir}/${flat[2]}`), { recursive: true });
      fs.renameSync(abs, assetPath(p, newRel));
      changed = true;
      return newRel;
    } catch { return rel; }
  };
  if (shot.artwork) shot.artwork = move(shot.artwork);
  if (shot.artworkHistory?.length) shot.artworkHistory = shot.artworkHistory.map(move);
  if (shot.graphImageGens?.length) shot.graphImageGens = shot.graphImageGens.map((g) => ({ ...g, path: move(g.path) }));
  try {
    const originalsDir = assetPath(p, `${p.assets.boardsDir}/originals`);
    if (fs.existsSync(originalsDir)) {
      for (const f of fs.readdirSync(originalsDir)) {
        const m = /^shot-(\d{4})-[^/]+\.\w+$/i.exec(f);
        if (!m) continue;
        const dest = assetPath(p, `${p.assets.boardsDir}/${m[1]}/originals/${f}`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(path.join(originalsDir, f), dest);
        changed = true;
      }
    }
  } catch { /* best-effort */ }
  return changed;
}

/** One-time migration: reference images used to be stored inline in the JSON
 *  as data URLs (`artwork`). They now live as files in referencesDir
 *  (`imagePath`), so write every legacy data-URL artwork out to disk and clear
 *  it. Runs for characters, products, and custom references. */
export function migrateReferenceArtwork(p: Production): boolean {
  let changed = false;
  const write = (ref: { name?: string; artwork?: string; imagePath?: string }): boolean => {
    if (!ref.artwork || !ref.artwork.startsWith("data:")) return false;
    if (ref.imagePath) return false;
    const comma = ref.artwork.indexOf(",");
    if (comma === -1) return false;
    let buf: Buffer;
    try { buf = Buffer.from(ref.artwork.slice(comma + 1), "base64"); } catch { return false; }
    if (!buf.length) return false;
    const mime = ref.artwork.slice(5, comma).split(";")[0];
    const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";
    const base = (ref.name ?? "reference").trim().replace(/\s+/g, "-").replace(/[^a-z0-9_-]+/gi, "").slice(0, 60) || "reference";
    const dir = p.assets.referencesDir;
    fs.mkdirSync(assetPath(p, dir), { recursive: true });
    let rel = `${dir}/${base}.${ext}`;
    let i = 2;
    while (fs.existsSync(assetPath(p, rel))) { rel = `${dir}/${base}-${i}.${ext}`; i++; }
    fs.writeFileSync(assetPath(p, rel), buf);
    ref.imagePath = rel;
    delete ref.artwork;
    return true;
  };
  for (const c of p.characters) if (write(c)) changed = true;
  for (const pr of p.products) if (write(pr)) changed = true;
  for (const r of p.references ?? []) if (write(r)) changed = true;
  return changed;
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

/**
 * Relocate storyboard board folders/files when shots are renumbered (e.g.
 * drag-reorder). For every shot whose number changed (old→new), rename the
 * per-shot directory boards/<old> → boards/<new> (via temp to avoid
 * collisions), rename inner filenames shot-<old>- → shot-<new>-, and patch
 * every board-related path stored on the shot. promptOverrides (keyed by
 * number) follows the shot as well.
 */
export function relocateBoardsForRenumber(
  p: Production,
  oldNumbers: Map<string, string>
): void {
  const boardsDir = p.assets.boardsDir;
  // Build list of shots that actually changed number and whose old folder exists
  const moves: Array<{ shot: ProductionShot; oldNum: string; newNum: string }> = [];
  for (const sc of p.scenes) {
    for (const shot of sc.shots) {
      const old = oldNumbers.get(shot.id);
      if (old && old !== shot.number) moves.push({ shot, oldNum: old, newNum: shot.number });
    }
  }
  if (!moves.length) return;

  // Phase 1: move each old dir → temp dir (avoid collisions where new dirs already exist)
  const tempMap = new Map<string, string>(); // oldNum → tempRel
  for (const { oldNum } of moves) {
    const oldRel = `${boardsDir}/${oldNum}`;
    let oldAbs: string;
    try { oldAbs = assetPath(p, oldRel); } catch { continue; }
    if (!fs.existsSync(oldAbs)) continue;
    const tmpRel = `${boardsDir}/.tmp-reorder-${oldNum}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
    try {
      fs.renameSync(oldAbs, assetPath(p, tmpRel));
      tempMap.set(oldNum, tmpRel);
    } catch { /* best-effort */ }
  }

  // Phase 2: temp → final new dir, renaming inner filenames to use new number
  for (const { oldNum, newNum } of moves) {
    const tmpRel = tempMap.get(oldNum);
    if (!tmpRel) continue;
    const newRel = `${boardsDir}/${newNum}`;
    try {
      fs.mkdirSync(path.dirname(assetPath(p, newRel)), { recursive: true });
      // Remove existing new dir if it already exists (should be empty after temp dance, but handle)
      const newAbs = assetPath(p, newRel);
      if (fs.existsSync(newAbs)) {
        try { fs.rmSync(newAbs, { recursive: true, force: true }); } catch {}
      }
      fs.renameSync(assetPath(p, tmpRel), newAbs);
      // Rename filenames inside new dir that contain old number
      const renameInDir = (dirRel: string) => {
        let dirAbs: string;
        try { dirAbs = assetPath(p, dirRel); } catch { return; }
        if (!fs.existsSync(dirAbs)) return;
        for (const entry of fs.readdirSync(dirAbs)) {
          const full = path.join(dirAbs, entry);
          try {
            const st = fs.statSync(full);
            if (st.isDirectory()) {
              renameInDir(`${dirRel}/${entry}`);
            } else if (entry.includes(`shot-${oldNum}-`)) {
              const newEntry = entry.replace(`shot-${oldNum}-`, `shot-${newNum}-`);
              fs.renameSync(full, path.join(dirAbs, newEntry));
            }
          } catch {}
        }
      };
      renameInDir(newRel);
    } catch { /* best-effort */ }
  }

  // Patch stored paths: replace boards/<old>/ → boards/<new>/ and shot-<old>- → shot-<new>-
  const patchOne = (rel: string | undefined, oldNum: string, newNum: string): string | undefined => {
    if (!rel) return rel;
    return rel
      .replace(`${boardsDir}/${oldNum}/`, `${boardsDir}/${newNum}/`)
      .replace(`shot-${oldNum}-`, `shot-${newNum}-`);
  };
  for (const { shot, oldNum, newNum } of moves) {
    if (shot.artwork) shot.artwork = patchOne(shot.artwork, oldNum, newNum)!;
    if (shot.artworkHistory?.length) shot.artworkHistory = shot.artworkHistory.map((r) => patchOne(r, oldNum, newNum)!);
    if (shot.graphImageGens?.length) shot.graphImageGens = shot.graphImageGens.map((g) => ({ ...g, path: patchOne(g.path, oldNum, newNum)! }));
    if (shot.graphVideoGens?.length) shot.graphVideoGens = shot.graphVideoGens.map((g) => ({ ...g, path: patchOne(g.path, oldNum, newNum)! }));
    if (shot.graphEditGens?.length) shot.graphEditGens = shot.graphEditGens.map((g) => ({ ...g, path: patchOne(g.path, oldNum, newNum)! }));
  }

  // promptOverrides is keyed by displayed number — move entries with the shot
  if (p.promptOverrides && typeof p.promptOverrides === "object") {
    const nextOverrides: Record<string, string> = {};
    const overrides = p.promptOverrides as Record<string, string>;
    // Build old→new lookup for quick mapping
    const oldToNew = new Map<string, string>();
    for (const { oldNum, newNum } of moves) oldToNew.set(oldNum, newNum);
    for (const [oldKey, val] of Object.entries(overrides)) {
      const newKey = oldToNew.get(oldKey) ?? oldKey;
      // If two old keys map to same new key (shouldn't happen with sequential), last wins — acceptable
      if (typeof val === "string" && val.trim()) nextOverrides[newKey] = val;
    }
    p.promptOverrides = nextOverrides;
  }
}

/** How many generations each node-graph generation node keeps. */
export const GRAPH_HISTORY_CAP = 20;

/** Store a generated frame on the shot's image generation node (newest
 *  first) so the node history mirrors every generation. */
export function recordGraphImageGen(shot: ProductionShot, rel: string, prompt: string, model: string): void {
  const item: GraphGenItem = { path: rel, prompt, model, at: new Date().toISOString() };
  shot.graphImageGens = [item, ...(shot.graphImageGens ?? [])].slice(0, GRAPH_HISTORY_CAP);
  shot.graphImageGenIndex = 0;
}

/** Store a generated clip on the shot's video generation node (newest first). */
export function recordGraphVideoGen(shot: ProductionShot, rel: string, prompt: string, model: string): void {
  const item: GraphGenItem = { path: rel, prompt, model, at: new Date().toISOString() };
  shot.graphVideoGens = [item, ...(shot.graphVideoGens ?? [])].slice(0, GRAPH_HISTORY_CAP);
  shot.graphVideoGenIndex = 0;
}

/** Store an AI-edited frame on the shot's edit-image node (newest first). */
export function recordGraphEditGen(shot: ProductionShot, rel: string, prompt: string, model: string): void {
  const item: GraphGenItem = { path: rel, prompt, model, at: new Date().toISOString() };
  shot.graphEditGens = [item, ...(shot.graphEditGens ?? [])].slice(0, GRAPH_HISTORY_CAP);
  shot.graphEditGenIndex = 0;
}

/** Apply a video clip as the shot's output AND guarantee it has a still frame.
 *  When the shot has no primary artwork yet (the video was animated from a
 *  node-graph image pipe, not from the shot's own frame), the video's source
 *  frame — the image node's current output, or the piped `sourceFallback` —
 *  becomes the still, so the animatic timeline always has a frame to show. */
export function applyVideoOutput(shot: ProductionShot, rel: string, sourceFallback?: string): void {
  shot.videoPath = rel;
  if (!shot.artwork) {
    const source = shot.graphImageGens?.[shot.graphImageGenIndex ?? 0]?.path ?? sourceFallback;
    if (source) shot.artwork = source;
  }
}

/** Auto-hook a classic image generation into the node graph: when nothing is
 *  piped into the output yet, bind the image node as the feed and apply its
 *  newest frame so the storyboard AND the node view both show the result.
 *  When the image node is already piped, the new frame still auto-applies;
 *  a deliberate videogen/ref pipe is never displaced. */
export function hookImageGenToOutput(shot: ProductionShot): void {
  if (shot.graphOutputSource === "videogen" || shot.graphOutputSource === "editgen" || shot.graphOutputSource === "ref") return;
  shot.graphOutputSource = "imagegen";
  const cur = shot.graphImageGens?.[shot.graphImageGenIndex ?? 0];
  if (cur) recordBoardArtwork(shot, cur.path);
}

/** Auto-hook a classic video generation into the node graph: when nothing is
 *  piped into the output yet, bind the video node as the feed. */
export function hookVideoGenToOutput(shot: ProductionShot): void {
  if (shot.graphOutputSource === "imagegen" || shot.graphOutputSource === "editgen" || shot.graphOutputSource === "ref") return;
  shot.graphOutputSource = "videogen";
}

/** The node-graph output pipe is the source of truth for the shot's primary
 *  frame/clip. Re-derive `artwork`/`videoPath` from the piped generation node's
 *  selected output so the storyboard (which reads `shot.artwork`) always
 *  mirrors the graph's frame output node. A piped node whose selection changed,
 *  or whose apply raced a renderer save, can't leave a stale or missing frame —
 *  e.g. an edit-image node piped to the output whose selected edit never landed
 *  on `shot.artwork`. Returns true when anything changed. */
export function syncBoardOutputToPipe(shot: ProductionShot): boolean {
  const imgSel = shot.graphImageGens?.[shot.graphImageGenIndex ?? 0];
  const editSel = shot.graphEditGens?.[shot.graphEditGenIndex ?? 0];
  const vidSel = shot.graphVideoGens?.[shot.graphVideoGenIndex ?? 0];
  switch (shot.graphOutputSource) {
    case "imagegen":
    case "editgen": {
      const sel = shot.graphOutputSource === "imagegen" ? imgSel : editSel;
      if (sel?.path) {
        if (shot.artwork !== sel.path) { shot.artwork = sel.path; shot.videoPath = undefined; return true; }
        return false;
      }
      // Node piped but empty — the storyboard frame goes blank until a
      // generation is piped back in (matches the output node's preview).
      if (shot.artwork !== undefined || shot.videoPath !== undefined) {
        shot.artwork = undefined;
        shot.videoPath = undefined;
        return true;
      }
      return false;
    }
    case "videogen": {
      if (vidSel?.path) {
        let changed = false;
        if (shot.videoPath !== vidSel.path) { shot.videoPath = vidSel.path; changed = true; }
        if (!shot.artwork && imgSel?.path && shot.artwork !== imgSel.path) { shot.artwork = imgSel.path; changed = true; }
        return changed;
      }
      if (shot.videoPath !== undefined) { shot.videoPath = undefined; return true; }
      return false;
    }
    default:
      return false;
  }
}

/** One-time migration: MOVE the classic generations (current artwork +
 *  history, videoPath) into the node-graph generation nodes — the nodes own
 *  the generation history, and the storyboard frame comes from the output
 *  node's pipe instead (so it starts empty until something is piped in).
 *  Guarded by `graphMigrated` so it runs exactly once per shot. */
export function migrateGraphGenerations(shot: ProductionShot): boolean {
  if (shot.graphMigrated) return false;
  // Move any classic frames the node doesn't already hold (deduped by path).
  const existing = new Set((shot.graphImageGens ?? []).map((g) => g.path));
  const items = [shot.artwork, ...(shot.artworkHistory ?? [])]
    .filter((v): v is string => typeof v === "string" && v.length > 0 && !existing.has(v))
    .map((path) => ({ path, prompt: "", model: "auto", at: "" }));
  if (items.length) {
    shot.graphImageGens = [...items, ...(shot.graphImageGens ?? [])].slice(0, GRAPH_HISTORY_CAP);
    shot.graphImageGenIndex ??= 0;
  }
  if (!shot.graphVideoGens?.length && shot.videoPath) {
    shot.graphVideoGens = [{ path: shot.videoPath, prompt: "", model: "auto", at: "" }];
    shot.graphVideoGenIndex ??= 0;
  }
  // The nodes own the generations now; the storyboard frame comes from the
  // output pipe, so it starts empty until something is piped in.
  shot.artwork = undefined;
  shot.artworkHistory = undefined;
  shot.videoPath = undefined;
  shot.graphMigrated = true;
  return true;
}

/** Image generator injected by the caller (OpenArt MCP in production).
 *  `refs` carries the shot's reference artwork (if any) for image-input models.
 *  `shot` (when given) lets the generator record a pending async job on the
 *  shot if the generation outlives its wait — the frame can then be reclaimed
 *  later instead of being lost. */
export type ImageGenFn = (prompt: string, refs: GenerationRef[], shot?: ProductionShot) => Promise<Buffer>;

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
    : opts.regenerateAll || !(s.artwork || s.graphImageGens?.length)
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
        const genPrompt = openArtPrompt(p, shot);
        const png = await generate(genPrompt, refs, shot);
        const { jpegRel } = writeBoardFrame(p, shot, png, "png");
        recordGraphImageGen(shot, jpegRel, genPrompt, "auto");
        // Classic flow: the storyboard frame comes from the output pipe — if
        // nothing is piped yet, hook the image node in so the new frame shows
        // in the storyboard AND the node view (never displaces a pipe).
        hookImageGenToOutput(shot);
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

/** Step 3 is "done" once every shot has a frame — either the piped output or
 *  generations waiting on its node. */
function markBoardsStatus(p: Production): void {
  const all = p.scenes.flatMap((s) => s.shots);
  if (all.length && all.every((s) => s.artwork || s.graphImageGens?.length)) p.status[3] = "done";
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
      recordGraphImageGen(shot, jpegRel, "", "import");
      hookImageGenToOutput(shot);
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
    const parsed = parseJsonLooseObject(text);
    const timing = parsed?.timing;
    const byNumber = new Map(shots.map((s) => [s.number, s]));
    for (const t of Array.isArray(timing) ? (timing as Array<{ number?: unknown; durationSec?: unknown }>) : []) {
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
