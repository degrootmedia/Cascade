/**
 * Prompt snippets — the user's reusable library of prompt text blocks.
 *
 * A snippet is a named, categorized block of prompt text the user inserts
 * into any prompt field (classic view side panel, node graph, Image Suite)
 * instead of re-typing it. The library is global user-level state: it lives
 * in `settings.promptSnippets` (app userData), shared across every project,
 * because the snippets are the user's personal toolkit, not project content.
 *
 * Storage semantics: a `null`/absent stored value means "never customized"
 * and resolves to the seeded starter library below. Any stored array —
 * including an EMPTY one — is the user's library as-is, so deleting a seeded
 * snippet (or all of them) sticks across restarts. Seeds are ordinary
 * snippets once resolved: editable and deletable like user ones.
 */

export interface PromptSnippet {
  id: string;
  name: string;
  category: string;
  body: string;
}

export const MAX_PROMPT_SNIPPETS = 500;
export const MAX_SNIPPET_NAME_CHARS = 120;
export const MAX_SNIPPET_CATEGORY_CHARS = 80;
export const MAX_SNIPPET_BODY_CHARS = 20000;
/** Category for snippets whose stored value is blank. */
export const DEFAULT_SNIPPET_CATEGORY = "General";

/** The seeded geometry/camera lock (style-transfer edits). Exact wording. */
export const GEOMETRY_CAMERA_LOCK_SNIPPET_BODY =
  "Preserve EXACTLY, pixel-for-pixel in position and proportion:\n" +
  "- The camera angle, framing, and composition\n" +
  "- The geometry and silhouette of every object\n" +
  "- All product dimensions and proportions\n" +
  "- The pose and placement of every element\n" +
  "- The perspective and depth relationships\n" +
  "\n" +
  "Do NOT move, resize, rotate, add, remove, or reshape anything. Do NOT reframe or crop. Do NOT reinterpret the design. If a detail is ambiguous, keep it exactly as it appears in the source image rather than inventing a new one. The result must overlay perfectly on the original — only the surface look changes.";

/** The seeded character-swap pose lock. Exact wording. */
export const CHARACTER_SWAP_POSE_LOCK_SNIPPET_BODY =
  "The character must adopt the figure's pose EXACTLY:\n" +
  "- Same head position, tilt, and gaze direction\n" +
  "- Same shoulder and hip height and angle\n" +
  "- Same bend in every joint — elbows, knees, wrists, spine\n" +
  "- Same hand and foot placement, feet in the same spots on the ground\n" +
  "- The character occupies the exact same space and silhouette volume as the figure — same height, same reach, nothing stretched, widened, or shrunk\n" +
  "\n" +
  "Do NOT use the pose from the character sheet. Do NOT change the figure's size relative to the scene. Match the scene's existing lighting and keep the contact shadow under the feet.";

/** The seeded no-music instruction (mirrors shared/no-music.ts verbatim so
 *  the shelf copy and the submit-time append can never drift in meaning —
 *  a test pins them equal). Exact wording. */
export const NO_MUSIC_SNIPPET_BODY =
  "No music. Do not add any music or musical score. Audio: diegetic sound only — in-scene sound effects, ambience, and dialogue.";

/** The starter library, in shelf display order. Deliberately small: three
 *  proven snippets, not an invented catalog. Ids are stable so a user who
 *  edits a seed keeps editing the same entry. */
export const SEEDED_PROMPT_SNIPPETS: readonly PromptSnippet[] = [
  {
    id: "seed-geometry-camera-lock",
    name: "Geometry & camera lock",
    category: "Locks — geometry & pose",
    body: GEOMETRY_CAMERA_LOCK_SNIPPET_BODY,
  },
  {
    id: "seed-character-swap-pose-lock",
    name: "Character swap — pose lock",
    category: "Locks — geometry & pose",
    body: CHARACTER_SWAP_POSE_LOCK_SNIPPET_BODY,
  },
  {
    id: "seed-no-music",
    name: "No music",
    category: "Audio",
    body: NO_MUSIC_SNIPPET_BODY,
  },
];

function cleanField(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\0/g, "").trim().slice(0, max) : "";
}

/**
 * Coerce an unknown stored/sent value into a clean snippet list. Entries
 * without a non-blank name or body are dropped; a blank category becomes
 * "General"; a missing/duplicate id is replaced with a stable positional
 * one. The body keeps its interior formatting (only the outer edges are
 * trimmed). Pure.
 */
export function sanitizePromptSnippets(raw: unknown): PromptSnippet[] {
  if (!Array.isArray(raw)) return [];
  const out: PromptSnippet[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= MAX_PROMPT_SNIPPETS) break;
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = cleanField(e.name, MAX_SNIPPET_NAME_CHARS);
    const body = typeof e.body === "string" ? e.body.replace(/\0/g, "").trim().slice(0, MAX_SNIPPET_BODY_CHARS) : "";
    if (!name || !body) continue;
    const category = cleanField(e.category, MAX_SNIPPET_CATEGORY_CHARS) || DEFAULT_SNIPPET_CATEGORY;
    let id = cleanField(e.id, 64);
    if (!id || seen.has(id)) id = `snippet-${out.length + 1}`;
    while (seen.has(id)) id = `${id}-x`;
    seen.add(id);
    out.push({ id, name, category, body });
  }
  return out;
}

/**
 * The active library: the seeds when nothing was ever stored (`null` /
 * `undefined` / non-array), else the stored list sanitized — an empty
 * stored array stays empty (the user deleted everything on purpose).
 * Returns fresh objects so callers can never mutate the seed constants.
 */
export function resolvePromptSnippets(stored: unknown): PromptSnippet[] {
  if (!Array.isArray(stored)) return SEEDED_PROMPT_SNIPPETS.map((s) => ({ ...s }));
  return sanitizePromptSnippets(stored);
}

/** Snippets grouped by category, categories in first-appearance order. */
export function groupSnippetsByCategory(
  snippets: readonly PromptSnippet[],
): { category: string; snippets: PromptSnippet[] }[] {
  const groups: { category: string; snippets: PromptSnippet[] }[] = [];
  const byCategory = new Map<string, PromptSnippet[]>();
  for (const s of snippets) {
    const list = byCategory.get(s.category);
    if (list) list.push(s);
    else {
      const fresh = [s];
      byCategory.set(s.category, fresh);
      groups.push({ category: s.category, snippets: fresh });
    }
  }
  return groups;
}

/** Case-insensitive substring filter over name, category, and body. */
export function filterSnippets(snippets: readonly PromptSnippet[], query: string): PromptSnippet[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...snippets];
  return snippets.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q) ||
      s.body.toLowerCase().includes(q),
  );
}

/** One-line shelf preview of a body (whitespace collapsed, ellipsized). */
export function snippetPreview(body: string, max = 90): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1))}…`;
}

export interface TextRange {
  start: number;
  end: number;
}

/**
 * The first `[bracketed placeholder]` inside `text[start, end)`, as absolute
 * offsets covering the brackets (so typing replaces the whole token).
 * `@[Name]` reference tags are NOT placeholders and are skipped. Pure.
 */
export function firstPlaceholderRange(text: string, start = 0, end = text.length): TextRange | null {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  const re = /\[[^\[\]\n]{1,120}\]/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index >= to) break;
    if (m.index > 0 && text[m.index - 1] === "@") continue;
    if (m.index + m[0].length > to) break;
    return { start: m.index, end: m.index + m[0].length };
  }
  return null;
}

export interface SnippetInsertion {
  text: string;
  /** Collapsed caret after insertion (end of the inserted body). */
  caret: number;
  /** First placeholder inside the inserted body, to select for typing over. */
  placeholder: TextRange | null;
}

/**
 * Insert `body` into `text` at the caret/selection `[start, end]`
 * (replacing a non-collapsed selection). When the field has no cursor
 * position (`start`/`end` null or non-finite), the body is appended at the
 * end. Pure — the DOM adapters in the renderer apply the result.
 */
export function insertSnippetText(
  text: string,
  start: number | null | undefined,
  end: number | null | undefined,
  body: string,
): SnippetInsertion {
  const hasCaret =
    typeof start === "number" && Number.isFinite(start) && typeof end === "number" && Number.isFinite(end);
  const s = hasCaret ? Math.max(0, Math.min(Math.floor(Math.min(start!, end!)), text.length)) : text.length;
  const e = hasCaret ? Math.max(s, Math.min(Math.floor(Math.max(start!, end!)), text.length)) : text.length;
  const next = text.slice(0, s) + body + text.slice(e);
  return {
    text: next,
    caret: s + body.length,
    placeholder: firstPlaceholderRange(next, s, s + body.length),
  };
}
