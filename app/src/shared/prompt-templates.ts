/**
 * The user-editable creative prompt templates (Settings → Advanced → Prompts).
 *
 * One home for the built-in wording of every generation prompt a user might
 * want to tune. The code that consumes a template resolves it against the
 * user's overrides (`settings.promptTemplates`, keyed by id) and falls back to
 * the built-in here, so the shipped defaults and the Settings editor can never
 * drift. Mechanical grammar — JSON output shapes, `@imageN` token positions,
 * the Style:/Brand identity: paragraph markers, citation format — deliberately
 * stays in code, not here.
 *
 * Templates may contain `{{placeholder}}` tokens; `renderPromptTemplate`
 * substitutes the caller's variables (unknown tokens are left intact).
 */

export type PromptTemplateId =
  | "cameraGrid"
  | "videoMotion"
  | "editImage"
  | "characterSheet"
  | "styleFrame"
  | "lookClause";

export interface PromptTemplateDef {
  id: PromptTemplateId;
  /** Settings label. */
  label: string;
  /** One-line explanation of when the template is used. */
  description: string;
  /** The built-in wording used when the user has no override. */
  builtin: string;
  /** `{{placeholder}}` names the template may contain (documentation only). */
  placeholders?: string[];
}

/** The built-in style-frame subject scaffold (a look plate, not a story beat). */
export const STYLE_FRAME_SUBJECT = "figure in plain clothing, mid-shot";
/** The built-in neutral style-frame setting. */
export const STYLE_FRAME_SETTING = "softly lit interior";

/** The built-in LOOK clause prepended to every board prompt when a style frame is active. */
export const LOOK_CLAUSE =
  "Look reference (reference image 1): match its medium, palette, lighting, line/texture and rendering treatment. Do not copy its subject matter.";

/** The shared clause bodies for the wide / detail / medium / face buckets; the
 *  per-size distribution strings below set the counts. Kept as fragments so the
 *  three tuned variants stay in sync. */
const CAMERA_GRID_WIDE_EXAMPLES =
  "(drone overhead bird's-eye, ultra-wide establishing from a new angle, pulled-far-out wide where the subject is small in the landscape, low-angle hero with the full landscape visible, ground-level frame with foreground texture and full backdrop, panoramic landscape)";
const CAMERA_GRID_DETAIL_EXAMPLES =
  "(extreme close-up of a wheel or tire, dashboard or steering wheel detail, prop close-up, fabric or wardrobe texture, hands holding something with no face visible, ground texture, plant or organic detail, vehicle badge)";
const CAMERA_GRID_MEDIUM_EXAMPLES =
  "(three-quarter front with location visible, three-quarter back, over-the-shoulder, profile with environment, subject walking past camera, dutch-tilted medium)";
const CAMERA_GRID_FACE_EXAMPLES =
  "(medium close-up of the face, extreme close-up of the eyes, side profile portrait)";

/** The tuned 16-cell (4×4) shot distribution — the original shipped wording. */
const CAMERA_GRID_DIST_16 =
  `AT LEAST 5 wide / establishing / environmental shots ${CAMERA_GRID_WIDE_EXAMPLES}, ` +
  `AT LEAST 3 detail / texture crops that are NOT of the face ${CAMERA_GRID_DETAIL_EXAMPLES}, ` +
  `3 to 4 medium / action shots where the subject and environment share the frame ${CAMERA_GRID_MEDIUM_EXAMPLES}, ` +
  `and AT MOST 4 face / subject close-ups ${CAMERA_GRID_FACE_EXAMPLES}. Never exceed 4 face close-ups.`;

/** The 9-cell (3×3) distribution: the same buckets, scaled down. */
const CAMERA_GRID_DIST_9 =
  `AT LEAST 3 wide / establishing / environmental shots ${CAMERA_GRID_WIDE_EXAMPLES}, ` +
  `AT LEAST 2 detail / texture crops that are NOT of the face ${CAMERA_GRID_DETAIL_EXAMPLES}, ` +
  `2 to 3 medium / action shots where the subject and environment share the frame ${CAMERA_GRID_MEDIUM_EXAMPLES}, ` +
  `and AT MOST 2 face / subject close-ups ${CAMERA_GRID_FACE_EXAMPLES}. Never exceed 2 face close-ups.`;

/** The 4-cell (2×2) distribution: one of each bucket at most. */
const CAMERA_GRID_DIST_4 =
  `AT LEAST 1 wide / establishing / environmental shot ${CAMERA_GRID_WIDE_EXAMPLES}, ` +
  `AT LEAST 1 detail / texture crop that is NOT of the face ${CAMERA_GRID_DETAIL_EXAMPLES}, ` +
  `1 to 2 medium / action shots where the subject and environment share the frame ${CAMERA_GRID_MEDIUM_EXAMPLES}, ` +
  `and AT MOST 1 face / subject close-up ${CAMERA_GRID_FACE_EXAMPLES}. Never exceed 1 face close-up.`;

/** The shot-distribution clause for a camera-grid prompt, scaled to the grid
 *  size. The `cameraGrid` template's `{{distribution}}` placeholder renders it,
 *  so the 16-cell wording stays exactly as shipped while 9- and 4-cell grids get
 *  a proportionally smaller mix. Pure. */
export function cameraGridDistribution(cols: number, rows: number): string {
  const c = Math.max(1, Math.floor(cols) || 1);
  const r = Math.max(1, Math.floor(rows) || 1);
  const count = c * r;
  if (count === 16) return CAMERA_GRID_DIST_16;
  if (count === 9) return CAMERA_GRID_DIST_9;
  if (count === 4) return CAMERA_GRID_DIST_4;
  return (
    `Spread the ${count} cells across a mix of wide / establishing / environmental shots, ` +
    `detail / texture crops that are NOT of the face, medium / action shots where the subject and environment share the frame, ` +
    `and no more than a quarter of the cells as face / subject close-ups.`
  );
}

/** The variables a camera-grid prompt renders with: the geometry and the
 *  size-scaled `{{distribution}}` clause. Pure. */
export function cameraGridPromptVars(cols: number, rows: number): Record<string, string | number> {
  const c = Math.max(1, Math.floor(cols) || 1);
  const r = Math.max(1, Math.floor(rows) || 1);
  return { cols: c, rows: r, count: c * r, distribution: cameraGridDistribution(c, r) };
}

const CAMERA_GRID =
  "Create a 16:9 high resolution grid showing the {{count}} best camera angles of the same scene captured in the reference image. " +
  "The cells are arranged in a clean {{cols}} by {{rows}} grid on a pure black background, with thin black gutters of consistent width separating each cell and a thin black border around the outer edge of the grid. " +
  "Each cell is sized to 16:9 to match the parent canvas proportions. " +
  "ABSOLUTELY NO TEXT IN ANY CELL: no labels, no captions, no numbering, no scene names, no artist names, no song titles, no film title cards, no shot markers, no slate markers, no watermarks, no logos, no platform UI. " +
  "Nothing rendered as text anywhere on the canvas. The reference image is the establishing shot for the scene. " +
  "Every subject, character, vehicle, prop, wardrobe detail, accessory, environmental detail, lighting condition, time of day, weather, color palette, and overall grade must be preserved exactly across every one of the {{count}} cells. " +
  "Only the camera moves between cells.\n\n" +
  "IDENTITY LOCK: if the reference shows a person, that person's identity is locked across all {{count}} cells - the face, bone structure, facial features, skin tone, eye color, hair, hairline, makeup, body proportions, wardrobe, and accessories all match the reference image exactly and read as the same single individual in every cell, never a lookalike, a sibling, or an aged, slimmed, or beautified version. " +
  "The face must not drift, morph, or change between cells. In cells where the face is not visible (wides, detail crops, back views), the body, wardrobe, and proportions still match the reference exactly. " +
  "The scene is the star - treat the location, vehicle, props, wardrobe, and atmosphere as co-subjects. The person (if there is one) is one element of the world, not the sole focus. " +
  "Follow this required shot distribution across the {{count}} cells: {{distribution}}\n" +
  "Mix the categories across the rows so every row of the grid contains visual variety. Subjects in every cell are still, mouths closed, not speaking or singing or mouthing words. " +
  "Cinematic register: the same lighting and grade as the reference holds across every cell. No baked in text, no scene labels, no watermarks, no logos, no platform UI, no caption strip beneath the grid, no frame numbers, no slate markers, no artist names, no title cards. " +
  "Even if the cinematic register would suggest a title card (like a 70s film opening or a fashion editorial header), do not include one."

/** The built-in style-frame look-plate prompt. */
export const STYLE_FRAME_TEMPLATE =
  `A neutral, story-agnostic look reference for an animated production. ` +
  `Show a single generic ${STYLE_FRAME_SUBJECT} in a generic ${STYLE_FRAME_SETTING}. ` +
  `Render in the following style: {{style}}.{{brand}} ` +
  `Emphasise palette, lighting, materials and surface treatment, and overall finish. ` +
  `No text, no logos, no named characters, no scene-specific action.`

/** The built-in edit-image framing. `{{source}}` is the source-frame token. */
export const EDIT_IMAGE_TEMPLATE =
  "Edit this reference image ({{source}}). Keep its composition unless asked otherwise.\n\nEdit instructions: {{instructions}}";

/** The built-in character-sheet framing. */
export const CHARACTER_SHEET_TEMPLATE =
  `Character reference sheet: {{description}}. ` +
  `{{views}}, with an inset closeup of the character's face. ` +
  `Neutral pose, neutral expression, neutral lighting, plain gray background. ` +
  `No text, no labels, no watermarks.`;

/** The shipped creative templates, in Settings display order. */
export const PROMPT_TEMPLATES: readonly PromptTemplateDef[] = [
  {
    id: "cameraGrid",
    label: "Camera grid",
    description: "The prompt used for every camera-grid sheet (a 4×4, 3×3, or 2×2 grid of camera angles).",
    builtin: CAMERA_GRID,
    placeholders: ["cols", "rows", "count", "distribution"],
  },
  {
    id: "videoMotion",
    label: "Video motion default",
    description: "The video node/modal's motion prompt when a shot has none.",
    builtin: "Animate this reference image with smooth, cinematic motion.",
  },
  {
    id: "editImage",
    label: "Edit-image framing",
    description: "Wraps an edit instruction before it is sent to the image model.",
    builtin: EDIT_IMAGE_TEMPLATE,
    placeholders: ["source", "instructions"],
  },
  {
    id: "characterSheet",
    label: "Character sheet framing",
    description: "Wraps a character description into the sheet structure.",
    builtin: CHARACTER_SHEET_TEMPLATE,
    placeholders: ["description", "views"],
  },
  {
    id: "styleFrame",
    label: "Style-frame framing",
    description: "Builds the neutral look-plate prompt for a generated style frame.",
    builtin: STYLE_FRAME_TEMPLATE,
    placeholders: ["style", "brand"],
  },
  {
    id: "lookClause",
    label: "LOOK clause",
    description: "The verbatim look sentence prepended to board prompts when a style frame is active.",
    builtin: LOOK_CLAUSE,
  },
];

/** User overrides, keyed by template id (absent id = the built-in). */
export type PromptTemplateOverrides = Record<string, string>;

const BY_ID = new Map<string, PromptTemplateDef>(PROMPT_TEMPLATES.map((d) => [d.id, d]));

/** The definition for a template id, or undefined for an unknown id. */
export function promptTemplateDef(id: string): PromptTemplateDef | undefined {
  return BY_ID.get(id);
}

/** The built-in wording for a template id (empty string for an unknown id). */
export function promptTemplateDefault(id: PromptTemplateId | string): string {
  return BY_ID.get(id)?.builtin ?? "";
}

/** The active wording: the user's override when present and non-blank, else the built-in. */
export function resolvePromptTemplate(
  id: PromptTemplateId | string,
  overrides?: PromptTemplateOverrides | null
): string {
  const def = BY_ID.get(id);
  if (!def) return "";
  const override = overrides?.[id];
  return typeof override === "string" && override.trim() ? override : def.builtin;
}

/** Substitute `{{name}}` tokens; unknown tokens are left intact. Pure. */
export function renderPromptTemplate(
  template: string,
  vars: Record<string, string | number | undefined>
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

/** True when the override record actually changes at least one known template. */
export function hasTemplateOverrides(overrides?: PromptTemplateOverrides | null): boolean {
  if (!overrides) return false;
  return PROMPT_TEMPLATES.some((d) => {
    const v = overrides[d.id];
    return typeof v === "string" && v.trim() !== "" && v !== d.builtin;
  });
}
