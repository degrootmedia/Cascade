/**
 * Production-domain types (master plan step 06 T1).
 *
 * Domain module of `shared/ipc.ts`; the barrel re-exports everything, so
 * `../shared/ipc.js` import paths are unchanged.
 */
import type {
  CameraGridData,
  GenParams,
  GraphLayout,
  Graph,
  GraphEditNode,
  GraphGenItem,
  TweenBlock,
  PendingImageGen,
  UpscaleData,
} from "./graph.js";

export interface ProductionMeta {
  id: string;
  name: string;
  /** Absolute path of the production's own folder. */
  folder: string;
  createdAt: string;
  updatedAt: string;
  /** Highest pipeline step that has produced output (0 = nothing run yet). */
  stepDone: number;
  shotCount: number;
}

export interface ProductionShot {
  /** Stable identity — survives renumbering and reordering. */
  id: string;
  /** Displayed 4-digit number ("0100"), derived, never the identity. */
  number: string;
  /** Column A: dialogue, VO, or SFX. */
  audio: string;
  /** Column B: what we see. */
  visual: string;
  /** Workspace-relative artwork path once boards exist. */
  artwork?: string;
  /** Previous frames for this shot (workspace-relative paths), newest first,
   * capped at BOARD_HISTORY_CAP. The active frame is always `artwork`. */
  artworkHistory?: string[];
  /** Step 4: workspace-relative path to a generated video for this shot. When
   *  present, the animatic timeline plays it for this shot's duration window. */
  videoPath?: string;
  /** Step 4: mute the clip's own embedded audio in the animatic preview
   *  (speaker button on its timeline block). VO and music are unaffected. */
  muted?: boolean;
  /** Step 4: planned screen time in seconds (animatic). */
  durationSec?: number;
  /** Optional per-shot render-style override: the id of a ProductionStyle
   *  from the Step 2 set (legacy productions may store raw prompt text —
   *  resolved by name/prompt at generation time). When absent, the master
   *  style (styles[0]) applies. */
  style?: string;
  /** True when the user picked "None" for this shot's render style: the Style
   *  paragraph is suppressed entirely, even though a master style exists. */
  styleNone?: boolean;
  /** Character/product reference ids explicitly attached to this frame in
   *  Step 3 — beyond those auto-matched by name from the shot's text. */
  refIds?: string[];
  /** Auto-matched (by name) character/product ids the user unchecked for this
   *  frame. The entry stays visible so it can be re-checked later; excluded
   *  ids are skipped at generation/export time too. */
  refExcluded?: string[];
  /** The board generation prompt, editable in Step 3. When empty/absent the
   *  prompt is derived from the master/per-shot style, brand, and references;
   *  when set, this exact text drives the shot's generation. */
  prompt?: string;
  /** True once the user has edited `prompt` by hand: a manual prompt survives
   *  script re-ingestion and design changes (it never auto-regenerates). */
  promptManual?: boolean;
  /** Whether the generated prompt includes the production brand identity.
   *  Opt-in: brand identity is excluded by default and only appears when this
   *  is explicitly true. */
  includeBrandIdentity?: boolean;
  /** Per-reference prompt overrides for this frame, keyed by reference id
   *  (character, product, or custom reference). A non-blank entry replaces
   *  that reference's Design-page description in this shot's prompts; an
   *  empty/absent entry falls back to the Design-page text. */
  refPromptOverrides?: Record<string, string>;
  /** Step 3 node graph: last saved node positions + canvas viewport. */
  graphLayout?: GraphLayout;
  /** Step 3 node graph: the persisted wiring (nodes + typed edges). Absent on
   *  legacy shots until the one-time migration (or first connect) builds it;
   *  reads fall back to materializing from flags/text while absent. */
  graph?: Graph;
  /** Step 3 node graph: stored outputs of the image generation node (newest
   *  first), plus the cycled selection index. */
  graphImageGens?: GraphGenItem[];
graphImageGenIndex?: number;
  /** Schema-driven advanced/variant params for the image gen node (keyed by
   *  canonical flag). Optional/additive. */
  graphImageParams?: GenParams;
  /** Node graph video generation node: stored clips (newest first) + index. */
  graphVideoGens?: GraphGenItem[];
  graphVideoGenIndex?: number;
  /** The video-prompt node's text (motion prompt for the video gen node). */
  graphVideoPrompt?: string;
  /** Per-shot video-gen selections (the classic modal and the graph's video
   *  node both read/write them; they win over the global media-default, so a
   *  change in one shot never propagates to the others). */
  graphVideoModel?: string;
  graphVideoResolution?: string;
  graphVideoDurationSec?: number;
  /** Schema-driven advanced/variant params for the video gen node (keyed by
   *  canonical flag). Optional/additive — absent on old documents. */
  graphVideoParams?: GenParams;
  /** Node graph edit-image nodes (zero or more, daisy-chainable). The list is
   *  the source of truth; the legacy flat `graphEdit*` fields below migrate
   *  into a single `edit0` entry on load. */
  graphEditNodes?: GraphEditNode[];
  /** Which edit node feeds the output when `graphOutputSource === "editgen"`. */
  graphOutputEditNodeId?: string;
  /** Which edit node feeds the video node's image input when
   *  `graphEditToVideo` is set. */
  graphVideoSourceEditNodeId?: string;
  /** @deprecated Migrated into `graphEditNodes[0].gens`. */
  graphEditGens?: GraphGenItem[];
  /** @deprecated Migrated into `graphEditNodes[0].genIndex`. */
  graphEditGenIndex?: number;
  /** The classic Edit-frame popup's draft prompt. Seeds `graphEditNodes[0]`
   *  on migration; afterwards it is the text for the NEXT classic edit, which
   *  appends a new node to the chain. */
  graphEditPrompt?: string;
  /** @deprecated Migrated into `graphEditNodes[0].source`. */
  graphEditImageSource?: boolean;
  /** @deprecated Migrated into `graphEditNodes[0].source`. */
  graphEditSourceRefId?: string;
  /** Reference ids feeding the video gen node's extra reference inputs (beyond
   *  the main image pipe), in connection order. Only image refs connect. */
  graphVideoRefIds?: string[];
  /** Whether the image generation node's output also feeds the video node's
   *  image input. Independent of the output feed — the image node can pipe to
   *  the video node AND the output simultaneously. */
  graphImageToVideo?: boolean;
  /** Whether an edit-image node's output feeds the video node's image input
   *  (the frame the clip is animated from). Which node is named by
   *  `graphVideoSourceEditNodeId`. Mutually exclusive with `graphImageToVideo`
   *  — the video node's source input accepts any image output, and connecting
   *  one replaces the other. */
  graphEditToVideo?: boolean;
  /** A reference feeding the video node's image input (the frame the clip is
   *  animated from). Mutually exclusive with `graphImageToVideo` /
   *  `graphEditToVideo` — the source input accepts one image at a time. */
  graphVideoSourceRefId?: string;
  /** Keyframe source ids wired into the in-betweener node's keyframe sockets,
   *  in timeline order (2–5). Each is a bare reference id OR a generation-node
   *  sentinel (`TWEEN_KEY_IMGGEN` / `TWEEN_KEY_EDITGEN`), so keyframes can be
   *  reference images, the image node's selected frame, or the edit node's
   *  selected edit. Each adjacent pair forms an action block (see
   *  `graphTweenBlocks`). */
  graphTweenRefIds?: string[];
  /** Action blocks derived from `graphTweenRefIds` (one per adjacent pair).
   *  Prompts and per-block generation history survive re-derivation when
   *  keyframes are reordered. */
  graphTweenBlocks?: TweenBlock[];
  /** The in-betweener node's video model id ("auto" when Cascade picks). */
  graphTweenModel?: string;
  /** The in-betweener node's output resolution label (e.g. "1080p"). */
  graphTweenResolution?: string;
  /** Node-graph edit-video node: stored edited clips (newest first) + index. */
  graphEditVideoGens?: GraphGenItem[];
  graphEditVideoGenIndex?: number;
  /** The edit-video node's prompt. */
  graphEditVideoPrompt?: string;
  /** The edit-video node's model (a video-edit model). */
  graphEditVideoModel?: string;
  graphEditVideoResolution?: string;
  /** Schema-driven advanced params for the edit-video node. */
  graphEditVideoParams?: GenParams;
  /** Reference ids feeding the edit-video node (beyond the mandatory source). */
  graphEditVideoRefIds?: string[];
  /** A video reference feeding the edit-video source input (the video to
   *  edit). Absent = the shot's video, or a clip piped from the video node
   *  (`graphVideoToEditVideo`). */
  graphEditVideoSourceRefId?: string;
  /** Whether the video generation node's output feeds the edit-video source. */
  graphVideoToEditVideo?: boolean;
  /** Schema-driven advanced/variant params for the in-betweener (keyed by
   *  canonical flag; `aspect_ratio` lives here). Optional/additive. */
  graphTweenParams?: GenParams;
  /** The 16-panel camera-grid node's state (sheet path + grid geometry). A
   *  self-contained tool node with no ports; absent until the user drags one
   *  out and generates. Optional/additive. */
  graphCameraGrid?: CameraGridData;
  /** The upscale node's state (source wiring, model picks, output history).
   *  A generator node with a source-image input and an image output; absent
   *  until the user drags one out. Optional/additive. */
  graphUpscale?: UpscaleData;
  /** Workspace-relative path of the last stitched tween output (the single
   *  continuous clip previewed by the output node and the animatic). */
  graphTweenOutput?: string;
  /** True when the stitched preview clip was re-encoded (block codecs
   *  differed, so lossless `-c copy` concat failed). The assembly package
   *  always uses the original per-block clips regardless. */
  graphTweenReencoded?: boolean;
  /** Whether the style node is plugged into the image prompt (composer). When
   *  false the Style paragraph is absent from that prompt but the plug is
   *  remembered — switching the style to None removes the paragraph without
   *  disconnecting. */
  graphStyleConnected?: boolean;
  /** Whether the style node is plugged into the video-prompt node. */
  graphVideoStyleConnected?: boolean;
  /** @deprecated Migrated into the edit node's `styleConnected`. */
  graphEditStyleConnected?: boolean;
  /** Which node is piped into the output (becomes the shot's primary
   *  artwork/videoPath): an image/video generation node, the in-betweener
   *  node, or a reference. */
  graphOutputSource?: "imagegen" | "videogen" | "editgen" | "editvideo" | "tween" | "ref" | "upscale";
  /** The reference feeding the output when `graphOutputSource === "ref"`. */
  graphOutputRefId?: string;
  /** One-time marker: classic generations were moved into the gen nodes. */
  graphMigrated?: boolean;
  /** An OpenArt frame job that outlived the generating call (timed out or the
   *  finished image couldn't be downloaded). The job keeps rendering
   *  server-side, so the frame can be reclaimed later instead of re-paid.
   *  Cleared when a fresh generation supersedes it or the recheck recovers it. */
  pendingImageGen?: PendingImageGen;
}

export interface ProductionScene {
  /** Scene ordinal 1..N (display only). */
  number: number;
  title: string;
  shots: ProductionShot[];
}

/** Populated by Step 2 (later milestone). */
export interface CharacterSheet {
  id: string;
  name: string;
  /** Canonical descriptor prepended to every prompt using this character. */
  key: string;
  /** Reference image (data URL) attached in Step 2. */
  artwork?: string;
  /** Workspace-relative path of the reference image on disk (the modern
   *  storage — images live in referencesDir, not as inline data URLs). */
  imagePath?: string;
  /** Step 2 character builder: the last description + generation settings used
   *  for this character's sheet, so the builder panel can recall them. Re-running
   *  the builder overwrites — no history is kept. */
  builder?: CharacterSheetBuilder;
}

/** The character builder's last-used form state for one character. */
export interface CharacterSheetBuilder {
  /** The character description (as typed/refined) that produced the sheet. */
  description: string;
  /** View layout of the last sheet (front, or front + back). */
  view: CharacterSheetView;
  /** OpenArt model id used ("auto" when Cascade picked). */
  model: string;
  /** Output resolution bucket used. */
  resolution: string;
  /** Schema-driven model options used (absent = vendor defaults). */
  params?: Record<string, string | number | boolean | string[]>;
}

/** A product whose look must stay consistent (label, packaging, hero item). */
export interface ProductRef {
  id: string;
  name: string;
  /** Reference image (data URL) attached in Step 2. */
  artwork?: string;
  /** Workspace-relative path of the reference image on disk. */
  imagePath?: string;
}

/** A user-added reference (material, texture, mood, hero prop) that must be
 *  applied to specific shots. Created in Step 2; associated to shots in Step 3. */
export interface CustomRef {
  /** Stable identity. */
  id: string;
  /** User label, e.g. "Gondola Interior". */
  name: string;
  /** Reference image (data URL) attached in Step 2. Legacy storage — modern
   *  references keep their image in `imagePath` instead. */
  artwork?: string;
  /** Workspace-relative path of the reference image on disk (referencesDir). */
  imagePath?: string;
  /** Non-image media kind when the reference is a dropped video/audio file. */
  media?: "video" | "audio";
  /** Workspace-relative path of the dropped video/audio file (on disk, not in
   *  the JSON — data URLs are only used for images). */
  mediaPath?: string;
  /** Shot ids this reference applies to. Empty until toggled on specific shots. */
  shotIds?: string[];
  /** User-created category; absent means uncategorized. */
  categoryId?: string;
  /** Style-only override: auto-attaches with a style-only clause. */
  styleOnly?: boolean;
}

export interface ReferenceCategory {
  id: string;
  name: string;
  /** "style" refs auto-attach to every submission with a style-only clause. */
  kind?: "content" | "style";
}

/** A character or prop found during ingest, awaiting explicit user approval. */
export interface SuggestedReference {
  id: string;
  name: string;
  kind: "character" | "product";
  key?: string;
}

/** OpenArt generation choices made on the Step 3 board controls. */
export interface OpenArtBoardConfig {
  /** OpenArt model id, or "auto" for Cascade to pick per run. */
  model: string;
  /** Output resolution bucket fed to the generate tool's sizing param. */
  resolution: "1k" | "2k" | "4k";
  /** Quality tier fed to the generate tool's quality param (Higgsfield models
   *  that declare one, e.g. Seedream basic/high). Omitted when the model
   *  declares no quality options — the vendor default then applies. */
  quality?: string;
  /**
   * Per-model, schema-driven option values keyed by canonical flag name
   * (see `CliModelSchema`). Optional and additive — old configs load with
   * `params` undefined and unknown keys from newer schemas are ignored by
   * older readers. The generic arg builder drops values the active model's
   * schema doesn't allow, so switching models never carries stale keys
   * into the next submission.
   */
  params?: Record<string, string | number | boolean | string[]>;
}

/** One named visual style in the Step 2 style set. A production keeps up to 5.
 *  The first entry is the master/fallback style; the named styles populate the
 *  per-shot style dropdown in Storyboard (Step 3). */
export interface ProductionStyle {
  /** Stable identity. */
  id: string;
  /** 1-based display position (1..5). */
  index: number;
  /** Short human label appended after the number (e.g. "Heroic 3D"). */
  name: string;
  /** The full generation prompt for this style. */
  prompt: string;
  /** Workspace-relative path of the style frame (the look anchor reused on
   *  every shot that resolves to this style). Absent = text-only behavior. */
  imagePath?: string;
  /** The seed reused for the board (defaults to the production lookSeed). */
  seed?: number;
  /** How the frame was authored — the UI only auto-regenerates generated frames. */
  frameSource?: "upload" | "generated" | "reference" | "anchor";
  /** Per-style image-model override for style-frame generation. Absent (or
   *  "auto") = inherit the production default (`prod.openArt`). */
  model?: string;
  /** Per-style resolution override for style-frame generation. Absent =
   *  inherit the production default. */
  resolution?: "1k" | "2k" | "4k";
  /** Per-style schema-driven model options (variant, seed, …) for
   *  style-frame generation. Absent/empty = vendor defaults. */
  params?: Record<string, string | number | boolean | string[]>;
}

/** True when a shot carries anything worth confirming before delete: written
 *  text/prompts or visible media/generations. Blank shots delete immediately;
 *  anything with Audio/Visual direction, a custom prompt, a frame/history, a
 *  video clip, node-graph generations, tween wiring/output, or a pending frame
 *  job asks first. */
export function shotHasContent(s: ProductionShot): boolean {
  if (s.audio?.trim() || s.visual?.trim()) return true;
  if (s.prompt?.trim() || s.graphVideoPrompt?.trim() || s.graphEditPrompt?.trim()) return true;
  if (s.artwork || (s.artworkHistory?.length ?? 0) > 0) return true;
  if (s.videoPath || s.graphTweenOutput || s.pendingImageGen) return true;
  if ((s.graphImageGens?.length ?? 0) > 0) return true;
  if ((s.graphVideoGens?.length ?? 0) > 0) return true;
  if ((s.graphEditGens?.length ?? 0) > 0) return true;
  if (s.graphEditNodes?.some((n) => n.prompt?.trim() || (n.gens?.length ?? 0) > 0 || n.source)) return true;
  if ((s.refIds?.length ?? 0) > 0) return true;
  if ((s.graphTweenRefIds?.length ?? 0) > 0) return true;
  if (s.graphTweenBlocks?.some((b) => b.prompt?.trim() || (b.gens?.length ?? 0) > 0)) return true;
  if (s.graphUpscale?.source || (s.graphUpscale?.gens?.length ?? 0) > 0) return true;
  return false;
}

/** Order a model list by the user's saved arrangement (Settings → Models &
 *  expenses drag-to-reorder). Models missing from the order keep their
 *  relative discovery order after the known ones, so a fresh model appends
 *  instead of jumping. Stable sort — ties never reshuffle. */
export function sortByModelOrder<T>(items: T[], order: string[], id: (t: T) => string): T[] {
  if (!order || !order.length) return items;
  const rank = new Map(order.map((mid, i) => [mid, i]));
  return [...items].sort((a, b) => (rank.get(id(a)) ?? Infinity) - (rank.get(id(b)) ?? Infinity));
}

/** Aspect ratios offered when generating reference images (Design, Step 2). */
export type ImageGenAspectRatio = "1:1" | "4:3" | "16:9";

/** Choices made in the reference-image generation/edit modal (Step 2). */
export interface ReferenceImageGenOptions {
  /** OpenArt model id, or "auto" for Cascade to pick. */
  model: string;
  /** Output resolution bucket fed to the generate tool's sizing param. */
  resolution: string;
  /** The desired aspect ratio for the generated image. */
  aspectRatio: ImageGenAspectRatio;
  /** Generation/edit prompt (may contain @[name] reference tags). */
  prompt: string;
  /** Name for a freshly generated reference (ignored when editing). */
  name?: string;
  /** Category the generated reference lands in (ignored when editing). */
  categoryId?: string;
  /** When set, the reference's current image is edited in place. */
  sourceRefId?: string;
  /** Schema-driven advanced/variant params (keyed by canonical flag). */
  params?: GenParams;
}

/** The view layout a character-sheet generation produces: front view only, or
 *  front + back views (both with a face-closeup inset). */
export type CharacterSheetView = "front" | "front-back";

/** Choices made in the Step 2 character-builder panel. The generated image is
 *  attached to a character reference (`prod.characters`), creating the
 *  character when one with that name doesn't exist yet. Sheets are always
 *  generated 16:9. */
export interface CharacterSheetGenOptions {
  /** OpenArt model id, or "auto" for Cascade to pick. */
  model: string;
  /** Output resolution bucket fed to the generate tool's sizing param. */
  resolution: string;
  /** Character name — the sheet is attached to this character. */
  name: string;
  /** The user's description of the character. May cite references with
   *  `@[name]` tags (typed via the editor's @ autocomplete or dropped in from
   *  the references panel); each cited reference is uploaded as a visual input.
   *  The generation prompt always wraps it in the character-sheet framing:
   *  full body shot + face-closeup inset, neutral pose/expression/lighting on a
   *  plain gray background. */
  description: string;
  /** Front only, or front + back (both with the face inset). */
  view: CharacterSheetView;
  /** Schema-driven model options (variant, seed, …); absent = defaults. */
  params?: Record<string, string | number | boolean | string[]>;
}

/** A generated 3D model stored in the production's models folder. */
export interface ProductionModel {
  /** Stable identity. */
  id: string;
  /** Workspace-relative path of the .glb file. */
  glbPath: string;
  /** The prompt (or description) this model was generated from. */
  prompt: string;
  /** Tencent Hunyuan edition ("pro"). */
  edition: string;
  /** Whether PBR textures were enabled. */
  pbr: boolean;
  /** Whether the generation ran text-to-3D (true) or image-to-3D (false). */
  fromImage: boolean;
  /** ISO timestamp of generation completion. */
  at: string;
}

/** Choices made in the Step 2 3D-model generator. Tencent Hunyuan Pro
 *  (text-to-3D / image-to-3D / multi-view, GLB output). */
export type Model3dViewType =
  | "front" | "left" | "right" | "back"
  | "top" | "bottom" | "left_front" | "right_front";

/** One multi-view reference image for 3D generation. The Tencent Pro API
 *  requires a "front" view; the other angles are optional and version-limited
 *  (3.0: front/left/right/back, 3.1 adds top/bottom/left_front/right_front). */
export interface Model3dViewImage {
  viewType: Model3dViewType;
  /** Data URL of the view image. */
  dataUrl: string;
}

export interface Model3dGenOptions {
  /** The prompt (text-to-3D). For Sketch mode a prompt is sent alongside the
   *  image; for Normal/Geometry/LowPoly image-to-3D it is omitted (the API
   *  rejects a prompt+image pair outside Sketch). */
  prompt: string;
  /** Single reference image for image-to-3D, as a data URL. */
  imageDataUrl?: string;
  /** Multi-view reference images for multi-view image-to-3D (must include
   *  "front"). Takes precedence over `imageDataUrl`. */
  multiViewImages?: Model3dViewImage[];
  /** Model version: "3.0" or "3.1". */
  version: "3.0" | "3.1";
  /** Enable PBR textures (adds credits). */
  enablePbr: boolean;
  /** Generation mode: "Normal" (textured), "Geometry" (white, no texture),
   *  "LowPoly" (3.0 only), "Sketch" (3.0 only, requires prompt + image). */
  generateType: "Normal" | "Geometry" | "LowPoly" | "Sketch";
  /** Target polygon count (40,000 to 1,500,000). */
  faceCount: number;
}

/** Step 5 assembly configuration + last-run bookkeeping.
 *  `fps`/`width`/`height` describe the exported timeline and the MP4 render;
 *  `exportDir` is workspace-relative (defaults to `<outDir>/assembly`). */
export interface ProductionAssembly {
  fps: number;
  width: number;
  height: number;
  /** Workspace-relative export folder (media + EDL + AEScript + manifest + render). */
  exportDir: string;
  /** ISO timestamp of the last package build (gather + EDL + AEScript + manifest). */
  assembledAt?: string;
  /** Workspace-relative path of the last rendered MP4. */
  renderPath?: string;
  /** ISO timestamp of the last successful render. */
  renderedAt?: string;
  /** Total runtime of the assembled timeline in seconds. */
  totalSec?: number;
  /** Shot numbers rendered as black slots at the last build (no frame, no clip). */
  skippedShots?: string[];
}

/** A free-text card pinned to the reference moodboard. `text` is markdown,
 *  sanitized at render time (never trusted as HTML). */
export interface MoodboardNote {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

/** One reference's placement on the Reference Moodboard canvas. */
export interface MoodboardNodeLayout {
  /** CustomRef id. Layouts whose reference no longer exists are pruned. */
  refId: string;
  /** World coordinates, px. */
  x: number;
  y: number;
  /** Node size, px. Height is stored (not derived) so a node keeps its box
   *  before the media's real aspect is known. */
  w: number;
  h: number;
  /** Stacking order. */
  z: number;
  /** Hidden from the board — the reference itself still exists. */
  hidden?: boolean;
  /** Rotation in degrees (snapped to 15° when Shift is held). */
  rotation?: number;
}

/** A colored, labeled container that groups moodboard references. Created by
 *  multi-selecting nodes and grouping them (Ctrl/Cmd+G); the frame is a region
 *  whose `refIds` travel with it when the frame is dragged. */
export interface MoodboardFrame {
  id: string;
  /** World coordinates of the frame's top-left (header included). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Editable label shown in the frame's header. */
  label: string;
  /** Accent color key (see `MOODBOARD_FRAME_COLORS` in moodboard-layout.ts). */
  color: string;
  /** Member reference ids. Empty frames are pruned on reconcile. */
  refIds: string[];
}

/** PureRef-style reference moodboard layout, persisted per production. Additive
 *  and optional: older documents load with `moodboard` undefined and the board
 *  auto-places every reference it sees. */
export interface MoodboardLayout {
  version: 1;
  nodes: MoodboardNodeLayout[];
  /** Saved viewport so reopening restores the exact view. */
  viewport: { x: number; y: number; zoom: number };
  /** Plain solid or tiled background. */
  background?: "dark" | "mid" | "grid";
  /** Free-text cards pinned to the board. */
  notes?: MoodboardNote[];
  /** Labeled colored groups of references. */
  frames?: MoodboardFrame[];
}

export interface Production {
  meta: ProductionMeta;
  /** Pipeline step the user is focused on (1..5). */
  currentStep: 1 | 2 | 3 | 4 | 5;
  /** Master visual style applied to all generation prompts. */
  visualStyle: string;
  /** Step 2 style set (up to 5 named styles). styles[0] doubles as the master;
   *  when empty, `visualStyle` back-fills the master for older productions. */
  styles: ProductionStyle[];
  scenes: ProductionScene[];
  /**
   * Manual board prompts carried across re-ingestion, keyed by shot number.
   * When a re-ingested shot lands on a number that has an entry here (and the
   * user had edited that prompt by hand), the manual text is restored instead
   * of being lost with the old shot list. Cleared per-shot by "refresh".
   */
  promptOverrides?: Record<string, string>;
  characters: CharacterSheet[];
  products: ProductRef[];
  /** User-added per-shot references (materials, textures, hero props). */
  references?: CustomRef[];
  /** Script discoveries shown for approval at the end of Step 1. */
  suggestedReferences?: SuggestedReference[];
  /** User-created groups for manual reference images. */
  referenceCategories?: ReferenceCategory[];
  /** Step 3 OpenArt generation preferences. */
  openArt?: OpenArtBoardConfig;
  /** Step 4: workspace-relative path to the single voiceover clip for the whole production. */
  voiceoverPath?: string;
  /** Step 4: voiceover playback volume (0..1). Defaults to 1 when voiceoverPath is set. */
  voiceoverVolume?: number;
  /** Step 4: workspace-relative path to an imported background music track. */
  musicPath?: string;
  /** Step 4: music playback volume (0..1). Defaults to 0.5 when musicPath is set. */
  musicVolume?: number;
  /**
   * Global brand look applied to every frame: up to 5 palette swatches plus an
   * optional font. Set in Design (Step 2); appended to every board prompt.
   */
  brand?: { colors: string[]; font?: string };
  /** Magic Prompt: alternate content-only prompts generated for the full storyboard.
   *  When `magicEnabled` is true the storyboard prompt editors show `magicPrompts`
   *  content instead of the normal/manual prompts; style and brand paragraphs
   *  remain separate. The original prompts stay in `shot.prompt` untouched. */
  magicPrompts?: Record<string, string>;
  magicEnabled?: boolean;
  /** Board-wide storyboard seed: fixed once per production so the same style
   *  frame + frozen model/resolution repeats as closely as the vendor allows. */
  lookSeed?: number;
  /** The approved hero frame the look was locked to (its file backs a style frame). */
  anchorShotId?: string;
  status: Record<number, "todo" | "running" | "done" | "error">;
  /** Step 2: generated 3D models (design-page generator). Newest first. */
  models3d?: ProductionModel[];
  /** The source last ingested — a Google Docs URL or a local file path —
   *  refilled into the Step 1 controls so re-ingesting is one click. */
  scriptSource?: string;
  /** Step 5 assembly configuration + last-run bookkeeping. */
  assembly?: ProductionAssembly;
  /**
   * Step 3 storyboard-PDF export settings, remembered per production: the
   * last-used version label + panel layout, and the workspace-relative logo
   * asset (`logoRel`, copied into the production folder on pick) printed in
   * the lower-right corner of every page.
   */
  storyboardPdf?: StoryboardPdfSettings;
  /** The Reference Moodboard (PureRef-style canvas of every custom reference):
   *  node placements, viewport, background, and notes. Optional/additive —
   *  absent on documents that never opened the board. */
  moodboard?: MoodboardLayout;
  assets: { scriptMd: string; boardsDir: string; voiceoverDir: string; musicDir: string; outDir: string; referencesDir: string; assemblyDir: string; modelsDir: string; /** @deprecated Legacy flat video folder; clips now live in each shot's board folder under `video/`. Read only by the one-time relocation migration. */ videosDir?: string };
  /** Schema version gating the one-time board-artwork migrations (perf 1.2):
   *  when >= PRODUCTION_SCHEMA_VERSION, loadProduction skips the board walk
   *  entirely. Missing/older runs the idempotent migrations once, then stamps. */
  schemaVersion?: number;
  /** Monotonic write revision stamped by saveProduction. Never set by the
   *  renderer — the renderer's applySnapshot guard uses it to reject stale
   *  whole-object snapshots (a prompt-save response produced before an
   *  insert/delete must not overwrite the newer structural state). */
  rev?: number;
}

/** Remembered Step 3 storyboard-PDF export settings (see `Production.storyboardPdf`). */
export interface StoryboardPdfSettings {
  /** Last-used version label (free-typed, e.g. "v3"). */
  version?: string;
  /** 1-panel or 3-panels-per-page layout. */
  panelsPerPage?: 1 | 3;
  /** Workspace-relative logo image copied into the production folder. */
  logoRel?: string;
}

/** Options the renderer passes for one storyboard-PDF export. */
export interface StoryboardPdfExportOptions {
  panelsPerPage: 1 | 3;
  version: string;
}

/** Result of a storyboard-PDF export: saved path (null when cancelled) + updated production. */
export interface StoryboardPdfExportResult {
  filePath: string | null;
  production: Production;
}

/** Log line streamed to the Production UI while a step runs. */
export interface ProductionEvent {
  id: string;
  message: string;
  level: "info" | "error" | "done";
}

/** A file attached to a chat message (image, PDF, document, etc.). */
