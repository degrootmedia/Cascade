/** Types shared across main, preload, and renderer. */

import { chatChannels } from "./ipc-channels/chat.js";
import { workspaceChannels, settingsChannels } from "./ipc-channels/workspace.js";
import { sessionChannels } from "./ipc-channels/sessions.js";
import { mcpChannels } from "./ipc-channels/mcp.js";
import { agentChannels } from "./ipc-channels/agents.js";
import { productionChannels } from "./ipc-channels/production.js";
import { ledgerChannels } from "./ipc-channels/ledger.js";

export interface ApprovalRequestIpc {
  id: number;
  tool: string;
  summary: string;
  detail: string;
}

export type ApprovalDecisionIpc = "allow" | "allow-session" | "allow-group-session" | "deny";

/** Mirror of the core AgentEvent, safe to send over IPC. */
export type AgentEventIpc =
  | { type: "text-delta"; text: string }
  | { type: "text-done"; text: string }
  | { type: "tool-start"; call: { name: string; args: Record<string, unknown> } }
  | { type: "tool-result"; name: string; result: string; isError: boolean; images?: string[] }
  | { type: "turn-done"; usage: Record<string, number | undefined> }
  | { type: "agent-done"; finalText: string; totalCredits: number }
  | { type: "group-enabled"; group: string }
  | { type: "notice"; text: string }
  | { type: "error"; message: string };

/** An agent event tagged with the chat (session) it belongs to, so the renderer
 *  can route it to the right transcript even when multiple chats are live. */
export interface ChatEvent {
  sessionId: string;
  event: AgentEventIpc;
}

export interface SettingsView {
  /** Selected LLM API provider id (see shared/providers.ts). */
  provider: string;
  hasApiKey: boolean;
  model: string;
  workspace: string | null;
  /** UI accent color (hex). */
  accent: string;
  /** Absolute path to the external image editor, or null when not set. */
  externalEditor: string | null;
  /** Whether a 3D AI Studio API key is stored (encrypted). */
  has3daiApiKey: boolean;
}

export interface ModelInfo {
  id: string;
  thinking: boolean;
  vision: boolean;
  /** Numeric cost used for cheapest-first ordering; units are provider-specific
   *  (gab credits vs. USD per 1M output tokens for Cheaper Inference). */
  baseCost: number;
  /** Short badge text, e.g. "12" (gab credits) or "$3.50/1M". */
  costLabel: string;
  /** Tooltip detail, e.g. "12 credits per message" or "in $0.70 / out $3.50 per 1M tokens". */
  costTitle: string;
  /** Billing semantics detected from the model's own fields (see providers.ts).
   *  "per-message" prices a request exactly; "per-token" only supports a
   *  relative ranking, so the UI shows costTier instead of costLabel. */
  costKind: import("./providers.js").CostKind;
  /** Relative rank across the provider's list ("cheapest"/"mid"/"priciest"),
   *  or null when the model is unpriced or costs can't be ranked. */
  costTier: import("./providers.js").CostTier;
}

/** Result of listing the current provider's models — carries the real failure
 *  reason so Settings can show it instead of an empty dropdown. */
export type ModelListResult =
  | { ok: true; models: ModelInfo[] }
  | { ok: false; error: string };

export interface SkillInfo {
  name: string;
  description: string;
  /** Namespace the skill lives under ("spec", "oracle", "code", …). */
  namespace?: string;
  /** How the agent should treat the skill: sequential / advisory / utility. */
  kind?: "sequential" | "advisory" | "utility";
}

/** Per-directory instructions (CASCADE.md) status for the current workspace. */
export interface WorkspaceInstructionsInfo {
  workspace: string | null;
  /** True when an instructions file exists and is loaded into the system prompt. */
  active: boolean;
  /** Absolute path to the active instructions file (or the folder if none yet). */
  file: string | null;
}

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: string;
  /** One-line snippet of the last user/assistant message ("" if none). */
  preview: string;
}

/** Result of undoing a chat's last agent turn. */
export interface UndoResultIpc {
  restored: number;
  /** Relative (workspace-relative) paths of the restored files. */
  files: string[];
}

export interface McpStatusIpc {
  name: string;
  status: "connected" | "error" | "disabled";
  toolCount: number;
  error?: string;
}

/** Which vendor serves image/video generation (global setting). `higgsfield-cli`
 *  is the same Higgsfield account driven through the local `higgsfield` CLI
 *  binary instead of the MCP server; its model ids are namespaced
 *  `higgsfield-cli:<job_type>` so the two transports never collide.
 *  `openart-cli` is likewise the OpenArt account via the local `openart`
 *  CLI binary (`openart-cli:<id>`); it cannot send end frames or multiple
 *  video references, so those requests fail loudly with an MCP redirect. */
export type MediaProviderId = "openart" | "higgsfield" | "higgsfield-cli" | "openart-cli";

/** One generation vendor for the Settings picker. */
export interface MediaProviderInfo {
  id: MediaProviderId;
  displayName: string;
  /** Whether the vendor's generation tools are currently connected. */
  available: boolean;
}

/** The Higgsfield CLI transport status (Settings → Media generation). */
export interface HiggsfieldCliStatus {
  /** Resolved binary path, or null when no `higgsfield` binary was found. */
  binary: string | null;
  /** `higgsfield version` output, or null when the binary is missing. */
  version: string | null;
  /** Whether `account status` succeeds (signed in with a workspace). */
  authenticated: boolean;
  /** The signed-in account email, when known. */
  account: string | null;
}

/** The OpenArt CLI transport status (Settings → Media generation). */
export interface OpenArtCliStatus {
  /** Resolved binary path, or null when no `openart` binary was found. */
  binary: string | null;
  /** `openart version` output, or null when the binary is missing. */
  version: string | null;
  /** Whether `account` succeeds (signed in). */
  authenticated: boolean;
  /** The signed-in account email, when known. */
  account: string | null;
}

export interface AgentMeta {
  id: string;
  name: string;
  description: string;
  avatar: { kind: "emoji"; value: string } | { kind: "image"; path: string } | null;
  model: string;
  allowedTools: "all" | string[];
  createdAt: string;
  updatedAt: string;
  hasPrompt: boolean;
}

export interface AgentDetail {
  meta: AgentMeta;
  prompt: string;
  avatarDataUrl?: string | null;
}

/* ---------- Production Assistant ---------- */

/** Summary of a saved production (sidebar/list payload). */
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

/** One shot row: the smallest Audio/Visual unit. */
/** Step 3 node graph: saved canvas state for one shot's graph, so it reopens
 *  the way the user left it. */
export interface GraphLayout {
  /** Node positions keyed by graph node id (ref/composer/style/brand/output). */
  positions?: Record<string, { x: number; y: number }>;
  /** Node sizes keyed by graph node id (the frame output plus the resizable
   *  image/edit/video generation nodes). */
  sizes?: Record<string, { width: number; height: number }>;
  /** Canvas pan/zoom as last left by the user. */
  viewport?: { x: number; y: number; zoom: number };
}

/** One node-graph edit-image node. A shot may hold several and daisy-chain
 *  them (an edit node's output feeds another's source). The list is the source
 *  of truth; the legacy flat `graphEdit*` fields migrate into `edit0`. */
export interface GraphEditNode {
  /** Stable identity within the shot: "edit0", "edit1", …. */
  id: string;
  /** The node's own edit instructions (its `editprompt` node's text). */
  prompt: string;
  /** Stored edits (newest first) + the selected index. */
  gens?: GraphGenItem[];
  genIndex?: number;
  /** What feeds this node's source input. Absent = the shot's current frame. */
  source?:
    | { kind: "imagegen" }
    | { kind: "editgen"; nodeId: string }
    | { kind: "ref"; refId: string };
  /** Whether the style node is plugged into this node's prompt node. */
  styleConnected?: boolean;
  /** The node's own model/resolution picks (per-node, win over the global
   *  media-default; unset falls back to it). */
  model?: string;
  resolution?: string;
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
  /** Step 3 node graph: stored outputs of the image generation node (newest
   *  first), plus the cycled selection index. */
  graphImageGens?: GraphGenItem[];
graphImageGenIndex?: number;
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
  graphOutputSource?: "imagegen" | "videogen" | "editgen" | "tween" | "ref";
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

/** In-betweener keyframe source sentinels that read a generation node's output
 *  instead of a production reference's artwork. They are stored in
 *  `graphTweenRefIds` (and `TweenBlock.startRefId`/`endRefId`) alongside bare
 *  reference ids — a reference id (base36 timestamp + random suffix, see
 *  `store.newId`) can never equal these node ids, so the two are
 *  unambiguous. The image node is structural and always present; each edit
 *  node is addressed as `editgen:<nodeId>` (the bare `"editgen"` is the legacy
 *  single-node form migrated to `editgen:edit0`). */
export const TWEEN_KEY_IMGGEN = "imagegen";
export const TWEEN_KEY_EDITGEN = "editgen";
export const TWEEN_KEY_EDITGEN_PREFIX = "editgen:";

/** The in-betweener keyframe source id for an edit node. */
export function editNodeKeyframe(nodeId: string): string {
  return `${TWEEN_KEY_EDITGEN_PREFIX}${nodeId}`;
}

/** The edit node id a keyframe source refers to, or null. Handles the legacy
 *  bare `"editgen"` as `"edit0"` so pre-migration wiring keeps resolving. */
export function parseEditNodeKeyframe(id: string): string | null {
  if (id === TWEEN_KEY_EDITGEN) return "edit0";
  return id.startsWith(TWEEN_KEY_EDITGEN_PREFIX) ? id.slice(TWEEN_KEY_EDITGEN_PREFIX.length) : null;
}

/** True when an in-betweener keyframe source id refers to a generation node's
 *  output rather than a production reference. */
export function isTweenGenKeyframe(id: string): boolean {
  return id === TWEEN_KEY_IMGGEN || id === TWEEN_KEY_EDITGEN || id.startsWith(TWEEN_KEY_EDITGEN_PREFIX);
}

/** One stored output of a node-graph generation node. */
export interface GraphGenItem {
  /** Workspace-relative path (boards JPEG for frames, videos file for clips). */
  path: string;
  /** The prompt used for this generation. */
  prompt: string;
  /** The model id used ("auto" when Cascade picked). */
  model: string;
  /** ISO timestamp. */
  at: string;
}

/** One action block on the in-betweener timeline: a start keyframe, an end
 *  keyframe, and the action prompt describing the motion between them. Each
 *  block generates its own clip (start→end interpolation); the selected clips
 *  stitch into the shot's continuous output. History lives on the block so the
 *  per-block dropdown (Keyframes + previous generations) is independent. */
export interface TweenBlock {
  /** Stable identity ("tw0", "tw1", … in keyframe order). */
  id: string;
  /** Keyframe source id of the start keyframe (reference id or a
   *  `TWEEN_KEY_IMGGEN` / `TWEEN_KEY_EDITGEN` sentinel). */
  startRefId: string;
  /** Keyframe source id of the end keyframe (reference id or a
   *  `TWEEN_KEY_IMGGEN` / `TWEEN_KEY_EDITGEN` sentinel). */
  endRefId: string;
  /** Action prompt describing the motion from start to end. */
  prompt: string;
  /** Timeline position of the block start in seconds (1s grid). */
  startSec: number;
  /** Block length in seconds (1–15, 1s grid). */
  durationSec: number;
  /** Generated clips for this block (newest first). */
  gens?: GraphGenItem[];
  /** Selected generation index (0 = newest). Absent = show keyframes. */
  genIndex?: number;
}

/** An OpenArt async image job that outlived the generating call — the wait
 *  timed out or the finished image couldn't be downloaded, but the job keeps
 *  rendering server-side. Kept on the shot so the finished frame can be
 *  reclaimed (recheck + download) instead of paying for a second generation. */
export interface PendingImageGen {
  /** The async job id to re-poll (`openart_creation_get`/`wait`). */
  historyId?: string;
  /** Direct result URL to re-download when the submission returned one
   *  (no historyId) and the first download failed. */
  url?: string;
  /** The prompt this job was submitted with. */
  prompt: string;
  /** The model id used ("auto" when Cascade picked). */
  model: string;
  /** ISO timestamp of when the job was orphaned. */
  at: string;
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
}

export interface ReferenceCategory {
  id: string;
  name: string;
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
}

/** An OpenArt model surfaced in the Step 3 model dropdown. */
export interface OpenArtModelChoice {
  id: string;
  displayName: string;
  description: string;
  /** Whether the model accepts reference images (extra meta for Auto). */
  imageInput: boolean;
  /** Whether the model generates video (surfaced in the video-generation modal). */
  videoInput: boolean;
  /** Base credit cost for one job (may be null for metadata). */
  cost: number | null;
  /** Advertised video-mode spellings from the model list (e.g. `image2video`,
   *  `element2video`). Used to submit in the mode that actually carries
   *  references; absent for non-video models. */
  videoModes?: string[];
}

/** The one kind classification every dropdown follows: a model is IMAGE only
 *  when it outputs images and is not a video generator — video models accept
 *  an input image (image-to-video), so the imageInput flag alone can't
 *  classify. Matches the auto-detected kind in Models & expenses and what an
 *  "image" manual override bakes (videoInput cleared). */
export const isImageModel = (m: Pick<OpenArtModelChoice, "imageInput" | "videoInput">): boolean =>
  m.imageInput && !m.videoInput;
/** A model the video dropdowns offer — any video-capable generator. */
export const isVideoModel = (m: Pick<OpenArtModelChoice, "videoInput">): boolean => m.videoInput;

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

/** One generation dropdown's remembered last choice (Settings-backed, global
 *  per context): each dropdown starts where the user last left it. */
export interface MediaDefaultChoice {
  model?: string;
  resolution?: string;
  durationSec?: number;
  aspectRatio?: string;
}
/** The dropdown contexts a media default is remembered for. */
export type MediaDefaultCtx = "image" | "video" | "edit" | "reference" | "character" | "tween";

/** Choices made in the per-shot video-generation modal. */
export interface VideoGenOptions {
  /** OpenArt video model id, or "auto" for Cascade to pick. */
  model: string;
  /** Output resolution label (e.g. "480p", "720p", "1080p"). */
  resolution: string;
  /** Desired clip length in seconds. */
  durationSec: number;
  /** Motion/animation prompt (may contain @[name] reference tags). */
  prompt: string;
}

/** The resolution / length options a video model actually accepts, read from
 *  its live form schema. Used to populate the video modal per model. */
export interface VideoModelOptions {
  /** Resolution labels the model accepts (e.g. ["720p","1080p"]). */
  resolutions: string[];
  /** Clip lengths in seconds the model accepts. */
  durations: number[];
}

/** The quality options an image model actually accepts, read from its live
 *  catalog detail. Used to populate the storyboard quality dropdown per
 *  model. Null when the model (or its options) can't be read. */
export interface ImageModelOptions {
  /** Quality labels the model accepts (e.g. ["basic","high"]). */
  qualities: string[];
  /** The model's declared default quality, when it names one we recognize. */
  defaultQuality?: string | null;
}

/** A discovered media model with its pricing ladder baked — the read model for
 *  the Settings → Models & expenses tab. One entry per model from EITHER
 *  vendor (ids are provider-namespaced, so the union can't collide). */
export interface MediaModelLadder {
  /** Which vendor surfaced this model (the settings tab groups by it). */
  provider: MediaProviderId;
  /** The model choice as surfaced by its vendor (display name, capabilities). */
  choice: OpenArtModelChoice;
  /** Resolution ladder, low → high (image: fixed 1k/2k/4k buckets; video:
   *  read from the model's live form options, kind defaults when unreadable). */
  resolutions: string[];
  /** Cheapest video length in seconds this model accepts (null for images). */
  durMin: number | null;
  /** Most expensive video length in seconds this model accepts (null for images). */
  durMax: number | null;
}

/** One row in the expenses ledger — a priced AI generation or a manual
 *  "purchased asset" entry the user adds by hand. */
export interface LedgerEntry {
  /** Stable identity. */
  id: string;
  /** What was generated: image / video, or "manual" for custom purchased-asset rows. */
  kind: "image" | "video" | "manual";
  /** Resolved OpenArt model id (empty for manual rows). */
  model: string;
  /** Resolution label: "1k"/"2k"/"4k" bucket for images, e.g. "1080p" for video. */
  resolution: string;
  /** Clip length in seconds (video only). */
  durationSec?: number;
  /** Aspect ratio for images (e.g. "16:9"). */
  aspectRatio?: string;
  /** The price stamped when the entry was recorded ($0 when no rule matched). */
  price: number;
  /** When the generation completed / the manual row was added. */
  at: number;
  /** Custom label for manual entries. */
  label?: string;
  /** Production the generation belongs to. */
  productionId?: string;
  /** Shot the generation belongs to. */
  shotId?: string;
}

/** A pricing rule: kind + model → a dollar range. One range per model: the
 *  price interpolates between minPrice (cheapest config) and maxPrice (most
 *  expensive config) based on the generation's resolution and (video) length
 *  against the model's baked option ladder (resolutions[] + durMin/durMax).
 *  An empty model acts as "*" (any model). Exact models beat the wildcard;
 *  generations matching no rule are priced at $0. */
export interface ExpensePriceRule {
  id: string;
  kind: "image" | "video";
  model: string;
  /** Price at the cheapest config (lowest resolution, shortest video). */
  minPrice: number;
  /** Price at the most expensive config (highest resolution, longest video). */
  maxPrice: number;
  /** The model's resolution ladder, low → high (baked from its live form
   *  options at edit time; kind defaults when unknown). */
  resolutions: string[];
  /** Shortest video length in seconds this range prices (null for images). */
  durMin: number | null;
  /** Longest video length in seconds this range prices (null for images). */
  durMax: number | null;
}

/** The renderer read model for the Expenses page. */
export interface LedgerView {
  entries: LedgerEntry[];
  total: number;
  imageCount: number;
  videoCount: number;
}

/** Metadata handed to the generation seam for one successful AI generation. */
export interface LedgerGenMeta {
  kind: "image" | "video";
  model: string;
  resolution: string;
  durationSec?: number;
  aspectRatio?: string;
  at: number;
  productionId?: string;
  shotId?: string;
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
  /** The user's description of the character. The generation prompt always
   *  wraps it in the character-sheet framing: full body shot + face-closeup
   *  inset, neutral pose/expression/lighting on a plain gray background. */
  description: string;
  /** Front only, or front + back (both with the face inset). */
  view: CharacterSheetView;
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
  status: Record<number, "todo" | "running" | "done" | "error">;
  /** Step 2: generated 3D models (design-page generator). Newest first. */
  models3d?: ProductionModel[];
  /** Which source was last ingested (shown in the Step 1 card). */
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
  assets: { scriptMd: string; boardsDir: string; voiceoverDir: string; musicDir: string; videosDir: string; outDir: string; referencesDir: string; assemblyDir: string; modelsDir: string };
  /** Schema version gating the one-time board-artwork migrations (perf 1.2):
   *  when >= PRODUCTION_SCHEMA_VERSION, loadProduction skips the board walk
   *  entirely. Missing/older runs the idempotent migrations once, then stamps. */
  schemaVersion?: number;
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
export interface ChatAttachment {
  /** Data URL of the file (any MIME: `data:image/png;base64,…`, `data:application/pdf;base64,…`, …). */
  dataUrl: string;
  /** Original filename. */
  name: string;
  /** MIME type. */
  mime: string;
}

/** Items rendered in the chat transcript. Owned by the renderer, persisted via
 *  `syncDisplay` so the transcript survives a reload. */
export type DisplayItem =
  | { kind: "user"; text: string; attachments?: ChatAttachment[]; images?: string[] }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "tool"; name: string; args: string; result?: string; isError?: boolean; images?: string[] }
  | { kind: "mention"; filename: string; image: string }
  | { kind: "agent-switch"; agentId: string | null; name: string; description?: string; model?: string; avatar: { kind: "emoji"; value: string } | { kind: "image"; path: string } | null; avatarDataUrl?: string | null; at: string }
  | { kind: "notice"; text: string };

/** API exposed to the renderer via contextBridge. */
export interface CascadeApi {
  sendMessage(sessionId: string, text: string, attachments?: ChatAttachment[]): Promise<void>;
  stop(sessionId: string): void;
  /** Undo the file changes made by a chat's most recent agent turn. */
  undoLast(sessionId: string): Promise<UndoResultIpc>;
  /** Turn plan mode on/off for the current chat (persisted per session). */
  setPlanMode(sessionId: string, on: boolean): Promise<void>;
  /** Whether plan mode is currently on for the given chat. */
  getPlanMode(sessionId: string): Promise<boolean>;
  respondApproval(id: number, decision: ApprovalDecisionIpc): void;
  onAgentEvent(cb: (e: ChatEvent) => void): () => void;
  onApprovalRequest(cb: (req: ApprovalRequestIpc) => void): () => void;
  /** Called when a reference image is picked/uploaded via the OpenArt native picker. */
  onMentionAdded(cb: (e: { sessionId: string; dataUrl: string; filename: string }) => void): () => void;

  pickWorkspace(): Promise<string | null>; // default folder (Settings)
  pickSessionWorkspace(): Promise<string | null>; // current chat's folder
  setSessionWorkspace(dir: string): Promise<void>; // set current chat's folder (from a recent)
  /** Switch the current chat to pure chat (no folder, no tools). */
  setSessionWorkspaceNone(): Promise<void>;
  /** Clear the default folder for new chats (Settings → None). */
  clearDefaultWorkspace(): Promise<void>;
  getRecentWorkspaces(): Promise<string[]>; // recent folders
  getCurrentWorkspace(): Promise<string | null>;
  getSettings(): Promise<SettingsView>;
  setApiKey(key: string): Promise<void>;
  setModel(model: string): Promise<void>;
  setProvider(id: string): Promise<void>;
  setAccent(color: string): Promise<void>;
  pickExternalEditor(): Promise<string | null>;
  setExternalEditor(path: string | null): Promise<void>;
  /** Set (or clear with "") the 3D AI Studio API key, encrypted at rest. */
  set3daiApiKey(key: string): Promise<void>;
  /** Video model ids the user manually declared end-frame capable. */
  getEndFrameModels(): Promise<string[]>;
  setEndFrameModels(ids: string[]): Promise<void>;
  /** Media model ids the user hides from the generation model dropdowns. */
  getHiddenMediaModels(): Promise<string[]>;
  setHiddenMediaModels(ids: string[]): Promise<void>;
  /** Manual per-model kind assignments (model id → "image" | "video") that
   *  override the provider's auto-detected flags in every model dropdown. */
  getModelKindOverrides(): Promise<Record<string, "image" | "video">>;
  setModelKindOverrides(overrides: Record<string, "image" | "video">): Promise<void>;
  /** Per-dropdown remembered last choices (context → model/settings). */
  getMediaDefaults(): Promise<Partial<Record<MediaDefaultCtx, MediaDefaultChoice>>>;
  setMediaDefault(ctx: MediaDefaultCtx, patch: MediaDefaultChoice): Promise<void>;
  /** The user's saved media model arrangement (dropdowns follow it). */
  getMediaModelOrder(): Promise<string[]>;
  setMediaModelOrder(ids: string[]): Promise<void>;
  /** Show the native media context menu (Save as / Copy image / Edit externally / Open file folder) at the given page coords. */
  showImageMenu(opts: { src: string; x: number; y: number; media?: "image" | "video"; productionId?: string; relPath?: string; dataUrl?: string }): Promise<void>;
  /** Download an image URL via the native save dialog (same as the native menu's "Save image as…"). */
  saveImage(src: string): Promise<void>;
  /** Copy the image under the given page coords to the clipboard (same as the native menu's "Copy image"). */
  copyImage(x: number, y: number): Promise<void>;
  /** Open an image in the external editor (same as the native menu's "Edit externally"). */
  editImageExternally(opts: { src?: string; productionId?: string; relPath?: string; dataUrl?: string }): Promise<void>;
  /** Reveal a production image/video file in the OS file manager. Accepts an
   *  explicit `productionId`+`relPath` or a `cascade-media://` src. */
  showInFolder(opts: { productionId?: string; relPath?: string; src?: string }): Promise<void>;
  /** Fired when the user picks File → Settings… from the native menu. */
  onOpenSettings(cb: () => void): () => void;
  /** Fired after the window's page zoom changes (Ctrl+/-/0 or pinch), so canvases can re-rasterize. */
  onZoomChanged(cb: () => void): () => void;
  listModels(): Promise<ModelListResult>;
  getCredits(): Promise<number | null>;
  /** Remaining credit balance on the signed-in OpenArt account (null when OpenArt isn't connected). */
  getOpenArtCredits(): Promise<number | null>;

  listSessions(): Promise<SessionMeta[]>;
  loadSession(id: string): Promise<DisplayItem[]>;
  /** Tell main which chat is now focused (keeps its active-chat pointer in sync). */
  activateSession(id: string): void;
  /** Mirror the renderer's transcript into the session file so it survives a reload. */
  syncDisplay(sessionId: string, display: DisplayItem[]): void;
  newSession(): Promise<string>; // returns the new session id
  getCurrentSessionId(): Promise<string>;
  removeSession(id: string, mode: "delete" | "archive"): Promise<boolean>;
  /** Re-derive a chat's title from its context via Arya. Resolves to the new title. */
  renameSession(id: string): Promise<string | null>;
  onSessionRenamed(cb: (e: { id: string; title: string }) => void): () => void;

  listSkills(): Promise<SkillInfo[]>;
  openSkillsFolder(): Promise<void>;

  getWorkspaceInstructions(): Promise<WorkspaceInstructionsInfo>;
  openWorkspaceInstructions(): Promise<void>;

  getMcpConfig(): Promise<string>;
  setMcpConfig(text: string): Promise<McpStatusIpc[]>;
  getMcpStatus(): Promise<McpStatusIpc[]>;
  reloadMcp(): Promise<McpStatusIpc[]>;
  /** Server names whose tools attach only on user request (leaner default payload). */
  getMcpOnDemand(): Promise<string[]>;
  setMcpOnDemand(names: string[]): Promise<void>;
  /** Generation vendors (OpenArt/Higgsfield) with their connection state. */
  listMediaProviders(): Promise<MediaProviderInfo[]>;
  /** Which vendor serves image/video generation (global setting). */
  getMediaProvider(): Promise<MediaProviderId>;
  setMediaProvider(id: MediaProviderId): Promise<void>;
  /** Remaining credit balances per media vendor (null per vendor when unconnected). */
  getMediaCredits(): Promise<Record<MediaProviderId, number | null>>;
  /** Custom path to the `higgsfield` CLI binary (null = resolve from PATH). */
  getHiggsfieldCliBinary(): Promise<string | null>;
  setHiggsfieldCliBinary(path: string | null): Promise<void>;
  /** The Higgsfield CLI transport status (binary, version, auth). */
  getHiggsfieldCliStatus(): Promise<HiggsfieldCliStatus>;
  /** Custom path to the `openart` CLI binary (null = resolve from PATH). */
  getOpenArtCliBinary(): Promise<string | null>;
  setOpenArtCliBinary(path: string | null): Promise<void>;
  /** The OpenArt CLI transport status (binary, version, auth). */
  getOpenArtCliStatus(): Promise<OpenArtCliStatus>;

  listAgents(): Promise<AgentMeta[]>;
  getAgent(id: string): Promise<AgentDetail | null>;
  createAgent(data: { name: string; description?: string; avatar?: AgentMeta["avatar"]; model?: string; allowedTools?: "all" | string[]; prompt?: string }): Promise<string>;
  updateAgent(id: string, patch: Partial<{ name: string; description: string; avatar: AgentMeta["avatar"]; model: string; allowedTools: "all" | string[]; prompt: string }>): Promise<void>;
  uploadAgentAvatar(id: string, dataUrl: string): Promise<string>;
  duplicateAgent(id: string): Promise<string>;
  removeAgent(id: string, mode: "delete" | "archive"): Promise<boolean>;
  exportAgent(id: string): Promise<{ json: string; md: string } | null>;
  importAgent(json: string, md: string): Promise<string>;
  getSessionAgent(sessionId: string): Promise<string | null>;
  setSessionAgent(sessionId: string, agentId: string | null): Promise<void>;
  onAgentSwitched(cb: (e: { sessionId: string; agentId: string | null; frame: DisplayItem }) => void): () => void;

  /* Production Assistant */
  listProductions(): Promise<ProductionMeta[]>;
  /** Native folder dialog for a new production. Returns abs path or null. */
  pickProductionFolder(): Promise<string | null>;
  createProduction(name: string, folder: string): Promise<Production>;
  /** Re-register an existing production folder whose JSON is missing. Returns the existing document when the folder is already registered. */
  importProduction(folder: string): Promise<Production>;
  loadProduction(id: string): Promise<Production | null>;
  saveProduction(p: Production): Promise<void>;
  removeProduction(id: string, mode: "delete" | "archive"): Promise<boolean>;
  /** Native file dialog for a script (pdf/docx/txt/md/fountain). */
  pickScriptFile(): Promise<string | null>;
  /** Step 2: open a native file dialog for a reference image. Returns a data URL or null. */
  pickReferenceImage(): Promise<string | null>;
  /**
   * Step 3 node graph: save a dropped video/audio file into the production's
   * referencesDir (on disk, keeping media out of the JSON). Returns the
   * workspace-relative path and the media kind, or null when the production
   * is gone.
   */
  addReferenceMedia(productionId: string, fileName: string, mime: string, bytes: ArrayBuffer): Promise<{ path: string; kind: "video" | "audio" } | null>;
  /**
   * Step 2/3: save a reference image (inline data URL) into the production's
   * referencesDir on disk and return the workspace-relative path, so image
   * references stop riding the JSON as data URLs.
   */
  addReferenceImage(productionId: string, fileName: string, dataUrl: string): Promise<{ path: string } | null>;
  /**
   * Step 2: generate (or AI-edit) a reference image via OpenArt and persist it
   * into the production's referencesDir. With `sourceRefId` the reference's
   * current image is edited in place; otherwise a brand-new reference is added
   * (named by `name`) to the given `categoryId`. Returns the updated
   * production.
   */
  generateReferenceImage(productionId: string, opts: ReferenceImageGenOptions): Promise<Production>;
  /**
   * Step 2 character builder: generate a character-sheet reference image via
   * OpenArt — the user's description plus the always-on framing (full body shot
   * with a face-closeup inset, front or front + back view, neutral pose /
   * expression / lighting on a plain gray background). Attached to a character
   * reference, creating the character when that name isn't on the production
   * yet. Returns the updated production.
   */
  generateCharacterSheet(productionId: string, opts: CharacterSheetGenOptions): Promise<Production>;
  /** Delete a reference's on-disk file (image or media) when the reference is
   *  removed, so the references folder doesn't accumulate orphans. */
  removeReferenceFile(productionId: string, rel: string): Promise<void>;
  /**
   * Step 2: rescan the production's referencesDir and adopt every on-disk
   * image no reference/character/product points at yet — images dropped into
   * the folder externally show up in the panel. Returns the updated production.
   */
  scanReferencesFolder(productionId: string): Promise<Production>;
  /**
   * Step 1: ingest a script. `source` is an absolute file path or a Google
   * Docs share URL. Resolves to the updated production.
   */
  ingestScript(productionId: string, source: string): Promise<Production>;
  /** Step 2 magic wand: refine the style notes via one LLM call. Returns the refined text. */
  refineStylePrompt(productionId: string, style: string): Promise<string>;
  /**
   * Step 2 character builder: refine the character description via one LLM call
   * (polishes the user's rough text into a concrete visual description — the
   * always-on sheet framing is NOT part of it). Returns the refined text.
   */
  refineCharacterDescription(productionId: string, description: string): Promise<string>;
  /**
   * Step 2: generate up to 5 distinct named styles (name + generation prompt)
   * from the user's rough style notes. The renderer assigns numbers/ids and
   * persists them as the production's `styles` set.
   */
  generateStyles(productionId: string, notes: string): Promise<{ name: string; prompt: string }[]>;
  /**
   * Step 2: look at a reference image (data URL) and distill one named style
   * from it. The caller is responsible for checking the active model supports
   * image input first.
   */
  styleFromImage(productionId: string, imageDataUrl: string): Promise<{ name: string; prompt: string }>;
  /** Insert a shot (mid-numbered) before the given position; returns updated production. */
  insertShot(productionId: string, sceneNumber: number, index: number): Promise<Production>;
  /** Remove a shot by its stable id. */
  deleteShot(productionId: string, shotId: string): Promise<Production>;
  /** Edit a shot's audio/visual text. */
  updateShot(productionId: string, shotId: string, patch: { audio?: string; visual?: string }): Promise<Production>;
  /** Manually set a shot's 4-digit number. Rejected when the number is malformed, below 0100, or already used by another shot; board files relocate with the number. */
  setShotNumber(productionId: string, shotId: string, number: string): Promise<Production>;
  /** Move a shot before another shot (or to the end of the production when beforeShotId is null, or to the end of one scene when endSceneNumber is set). Re-numbers and relocates board files. */
  reorderShot(productionId: string, shotId: string, beforeShotId: string | null, endSceneNumber?: number): Promise<Production>;
  /** Start a production without a script: one scene with five blank shots (refuses when scenes already exist). */
  startBlank(productionId: string): Promise<Production>;
  /** Insert an empty scene after the given ordinal (0 = before the first, null = at the end); later scenes renumber. */
  addScene(productionId: string, afterSceneNumber: number | null): Promise<Production>;
  /**
   * Step 3: generate storyboard frames via the OpenArt MCP server. Generates
   * for shots without artwork (or all shots when `regenerateAll`), capped at
   * `maxShots` per run. When OpenArt isn't connected, prompts are exported to
   * <folder>/boards/prompts.md instead (manual generation + import workflow).
   */
  generateBoards(productionId: string, opts?: { maxShots?: number; regenerateAll?: boolean }): Promise<Production>;
  /** Step 3: regenerate a single shot's frame (same MCP-or-prompts fallback). */
  regenerateBoard(productionId: string, shotId: string): Promise<Production>;
  /** Step 3: regenerate several frames in parallel (single shared production). */
  regenerateBoards(productionId: string, shotIds: string[]): Promise<Production>;
  /**
   * Step 3: reclaim a shot's frame from an OpenArt job that outlived the
   * generating call (the wait timed out or the finished image couldn't be
   * downloaded). Rechecks the pending job and downloads the image when ready.
   */
  recheckBoard(productionId: string, shotId: string): Promise<Production>;
  /** Step 3: write every shot's generation prompt to <folder>/boards/prompts.md. */
  exportBoardPrompts(productionId: string): Promise<Production>;
  /** Step 3: return one shot's full generation prompt (used by the per-frame copy button). */
  getBoardPrompt(productionId: string, shotId: string): Promise<string | null>;
  /** Step 3: set a shot's editable board prompt (empty clears the override back to auto-derived). */
  updateBoardPrompt(productionId: string, shotId: string, prompt: string): Promise<Production>;
  /**
   * Step 3: discard a shot's manually edited prompt and re-derive it from the
   * current design (style, brand, references) + script. Returns the updated
   * production.
   */
  refreshBoardPrompt(productionId: string, shotId: string): Promise<Production>;
  /** Step 3: OpenArt image-capable models for the model dropdown (includes "auto"). */
  listOpenArtModels(): Promise<OpenArtModelChoice[]>;
  /** Models & expenses: probe BOTH media vendors and bake each model's pricing
   *  ladder (resolution ladder + video length range). Never filtered by the
   *  hidden-model list — the settings tab must show every model. */
  listAllMediaModels(): Promise<MediaModelLadder[]>;
  /** Step 3: native multi-picker for externally generated frames. Returns paths. */
  pickBoardImages(): Promise<string[]>;
  /**
   * Step 3: import externally generated frames. With `shotId`, the first file
   * is assigned to that shot; otherwise files are matched by the 4-digit shot
   * number in their filename (e.g. "0100.png"). With no files at all, the
   * <folder>/boards/import/ directory is scanned instead.
   */
  importBoards(productionId: string, files?: string[], shotId?: string): Promise<Production>;
/** Load a board frame as a data URL (thumbnail) for the contact sheet.
   *  `framePath` selects a frame from either generation node or legacy history;
   *  omit it for the current frame. */
  boardImage(productionId: string, shotId: string, framePath?: string): Promise<string | null>;
  /** Full-resolution board frame for the lightbox (perf 2.5): a
   *  cascade-media:// URL streamed by media-protocol.ts, not a base64 blob.
   *  Usable directly as an <img> src. */
  boardImageFull(productionId: string, shotId: string, framePath?: string): Promise<string | null>;
  boardThumbnail(productionId: string, shotId: string, framePath?: string): Promise<string | null>;
  /** Batch board thumbnails: one IPC for N shots (perf 1.4). Returns only the
   *  shots that resolved to artwork; missing frames are omitted. */
  boardThumbnails(productionId: string, shotIds: string[]): Promise<Record<string, string>>;
  /**
   * Step 3: re-link broken storyboard image paths — after board files were
   * moved/renamed externally (or a production folder was re-registered), a
   * shot's `artwork`/history/node-graph generation paths can point at files
   * that no longer exist. Each broken path is repointed to the newest
   * `shot-<number>-*.jpg` present in that shot's board folder; valid paths are
   * untouched. Returns the updated production.
   */
  refreshBoardLinks(productionId: string): Promise<Production>;
  deleteBoardImage(productionId: string, shotId: string): Promise<Production>;
  /**
   * Step 3: edit a shot's current frame via an image-input model — the frame
   * is sent as a visual reference alongside `prompt`, and the result becomes
   * the new current frame (the old one moves into the history).
   */
  editBoard(productionId: string, shotId: string, model: string, prompt: string): Promise<Production>;
  /**
   * Step 3: make a stored frame primary, selecting its image/edit generation
   * and wiring that node to the output. The path stays stable as history grows.
   */
  promoteBoardHistory(productionId: string, shotId: string, framePath: string): Promise<Production>;
  /** Step 4: one LLM call assigning durationSec + transition to every shot. */
  planAnimatic(productionId: string): Promise<Production>;
  /** Step 4: open a native picker, copy the chosen audio file into voiceoverDir, and set voiceoverPath. */
  importVoiceover(productionId: string): Promise<Production | null>;
  /** Step 4: read the production's voiceover clip as a data URL. */
  voiceoverFile(productionId: string): Promise<string | null>;
  /** Step 4: streamable `cascade-media://` URL for the voiceover clip (no
   *  base64 / data-URL length limits; supports range requests). */
  voiceoverUrl(productionId: string): Promise<string | null>;
  /** Step 4: remove the voiceover file and clear voiceoverPath. */
  removeVoiceover(productionId: string): Promise<Production>;
  /** Step 4: open a native picker, copy the chosen music file into the production's musicDir, and set musicPath. */
  importMusic(productionId: string): Promise<Production | null>;
  /** Step 4: read the imported music file as a data URL (for the inline player / animatic mixing). */
  musicFile(productionId: string): Promise<string | null>;
  /** Step 4: streamable `cascade-media://` URL for the music track. */
  musicUrl(productionId: string): Promise<string | null>;
  /** Step 4: remove the imported music file and clear musicPath. */
  removeMusic(productionId: string): Promise<Production>;
  /**
   * Step 3/4: generate a video clip for one shot, using its current frame
   * (full resolution) plus any @[name] references as visual references.
   * Writes the clip into videosDir and stores the relative path on the shot.
   */
  generateVideo(productionId: string, shotId: string, opts: VideoGenOptions): Promise<Production>;
  /**
   * Step 3 node graph: generate one frame from a custom prompt (the prompt
   * composer's text) without touching the shot's artwork — the result is
   * stored on the image generation node. Returns the updated production.
   */
  generateFrameNode(productionId: string, shotId: string, opts: { prompt: string; model: string; resolution: string }): Promise<Production>;
  /**
   * Step 3 node graph: generate one video clip for the video generation node.
   * `sourcePath` overrides the animated source frame (workspace-relative);
   * when absent the shot's current frame is used. The result is stored on the
   * video generation node. Returns the updated production.
   */
  generateVideoNode(productionId: string, shotId: string, opts: { prompt: string; model: string; resolution: string; durationSec: number; sourcePath?: string; refIds?: string[] }): Promise<Production>;
  /**
   * Step 3 in-betweener node: generate one action block's clip (start keyframe
   * → end keyframe interpolation for `blockId`). The clip is stored on the
   * block's history; it joins the stitched output only via `stitchTween`.
   * Returns the updated production.
   */
  generateTweenBlock(productionId: string, shotId: string, blockId: string, opts: { model?: string; resolution?: string; durationSec?: number }): Promise<Production>;
  /**
   * Step 3 in-betweener node: stitch every action block's selected clip (in
   * timeline order) into one continuous clip. Tries a lossless `-c copy`
   * concat first; when the block codecs differ it falls back to a re-encoded
   * preview stitch (flagged on `graphTweenReencoded`) — the assembly package
   * always uses the original per-block clips regardless. When the tween node
   * is piped to the output, the stitched clip becomes the shot's videoPath.
   * Returns the updated production.
   */
  stitchTween(productionId: string, shotId: string): Promise<Production>;
  /**
   * Step 3 in-betweener node: undo a stitch — drop the continuous clip
   * (`graphTweenOutput`) and, when the tween feeds the output, unbind the
   * feed so the shot falls back to its individual block clips. The per-block
   * clips and the timeline stay intact, so the user can view/edit and re-stitch.
   * Returns the updated production.
   */
  unstitchTween(productionId: string, shotId: string): Promise<Production>;
  /**
   * Step 3 node graph: AI-edit one image for an edit-image node. The source
   * image is that node's source pipe (another edit node's selection, the image
   * node's selection, or a reference), falling back to the shot's current
   * frame. The result is stored on the named edit node (`nodeId`; the first
   * node when omitted). Returns the updated production.
   */
  generateEditNode(productionId: string, shotId: string, opts: { nodeId?: string; prompt: string; model: string; resolution: string }): Promise<Production>;
  /**
   * Step 3 node graph: make a generation node's selected output the shot's
   * primary output (artwork for frames, videoPath for clips). Returns the
   * updated production.
   */
  applyGraphOutput(productionId: string, shotId: string, opts: { kind: "image" | "video"; path: string }): Promise<Production>;
  /**
   * Step 3 node graph: apply a reference as the shot's primary output (a
   * reference piped into the frame output). Image refs are written to the
   * boards dir as the artwork; video refs become the shot's videoPath.
   * Returns the updated production.
   */
  applyGraphRefOutput(productionId: string, shotId: string, refId: string): Promise<Production>;
  /** Step 4: streamable `cascade-media://` URL for a shot's generated video. */
  videoUrl(productionId: string, shotId: string): Promise<string | null>;
  /** Step 4: remove a shot's generated video file and clear videoPath. */
  removeVideo(productionId: string, shotId: string): Promise<Production>;
  /** Step 4: the resolution / length options a video model accepts (from its
   *  live form schema). Null when the model form can't be read. */
  videoModelOptions(modelId: string, withImage?: boolean): Promise<VideoModelOptions | null>;
  /** Step 3: the quality options an image model accepts (from its live
   *  catalog detail). Null when the model declares none or can't be read —
   *  the storyboard quality dropdown hides itself and the vendor default
   *  applies. */
  imageModelOptions(modelId: string): Promise<ImageModelOptions | null>;
  /** Step 3 in-betweener: ids of the video-capable models that accept a
   *  dedicated end-frame slot (live form/schema probe) unioned with the
   *  user's manual allowlist (Settings → Media generation). The tween model
   *  lists offer ONLY these ids. */
  videoEndFrameModels(): Promise<string[]>;
  /** Step 3: Magic Prompt — generate content-only prompts for the full storyboard (enables magic). */
  generateMagicPrompts(productionId: string): Promise<Production>;
  /** Step 3: toggle Magic Prompt alternate state on/off (false restores original prompts). */
  setMagicEnabled(productionId: string, enabled: boolean): Promise<Production>;
  /**
   * Step 2: generate a 3D model via the 3D AI Studio API (Tencent Hunyuan Pro).
   * Downloads the finished GLB into the production's models folder, records it
   * in `prod.models3d`, and returns the updated production. Requires a stored
   * 3D AI Studio API key.
   */
  generate3dModel(productionId: string, opts: Model3dGenOptions): Promise<Production>;
  /** Step 2: remove a generated 3D model (deletes the .glb + removes the record). */
  delete3dModel(productionId: string, modelId: string): Promise<Production>;
  /** Step 2: open a native "Save As" dialog and copy a generated .glb to the user's chosen location. */
  save3dModel(productionId: string, modelId: string): Promise<string | null>;
  /** The 3D AI Studio credit balance (null when no key is stored). */
  get3daiCredits(): Promise<number | null>;
  /** Board external edit — re-encode any externally modified originals to their JPEG previews. */
  checkExternalEdits(): Promise<void>;
  /** Fired after an externally edited board's JPEG preview has been regenerated. */
  onBoardExternalUpdate(cb: (e: { productionId: string; jpegRel: string; originalRel: string }) => void): () => void;
  /**
   * Step 5: gather all full-res frames + video clips + audio into the export
   * folder and write the EDL, After Effects rebuild script, and manifest.
   * `cfg` overrides the persisted fps / target resolution. Returns the
   * updated production.
   */
  assemblyBuild(productionId: string, cfg?: Partial<Pick<ProductionAssembly, "fps" | "width" | "height">>): Promise<Production>;
  /**
   * Step 5: render the assembled timeline to MP4 via ffmpeg (3-pass: normalize
   * per-shot segments → concat → mix VO + music). Requires an ffmpeg binary
   * (bundled ffmpeg-static, else a system `ffmpeg`). Returns the updated
   * production.
   */
  assemblyRender(productionId: string): Promise<Production>;
  /** Step 5: open the export folder in the OS file manager. */
  assemblyOpenFolder(productionId: string): Promise<void>;
  /**
   * Step 3: render the storyboard (panel stills + Audio/Visual boxes) to a
   * landscape PDF via a Save dialog. Remembers the version label + layout on
   * the production. Resolves to the saved path (null when cancelled) and the
   * updated production.
   */
  exportStoryboardPdf(productionId: string, opts: StoryboardPdfExportOptions): Promise<StoryboardPdfExportResult>;
  /** Step 3: pick a logo image (PNG/JPG) — copied into the production folder
   *  and printed in the lower-right corner of every storyboard-PDF page.
   *  Resolves to the updated production, or null when the user cancels. */
  pickStoryboardLogo(productionId: string): Promise<Production | null>;
  /** Step 3: remove the stored storyboard-PDF logo. */
  clearStoryboardLogo(productionId: string): Promise<Production>;
  /** Step 3: data URL of the stored storyboard-PDF logo (for the export
   *  dialog preview), or null when none is attached. */
  storyboardLogoImage(productionId: string): Promise<string | null>;
  /** Expenses: the full ledger (entries + running total + per-kind counts). */
  getLedger(): Promise<LedgerView>;
  /** Expenses: the pricing rules edited from Settings. */
  getExpensePriceRules(): Promise<ExpensePriceRule[]>;
  /** Expenses: persist the pricing rules edited from Settings. Saving re-prices
   *  every existing generation against the new ranges (manual rows untouched). */
  setExpensePriceRules(rules: ExpensePriceRule[]): Promise<void>;
  /** Expenses: re-run the current rules over every existing generation and
   *  update its price (manual rows untouched). Resolves to the refreshed view. */
  repriceExpenses(): Promise<LedgerView>;
  /** Expenses: save the current price rules to a user-picked CSV file.
   *  Resolves to the saved path, or null when the user cancels. */
  exportExpensePriceRules(): Promise<string | null>;
  /** Expenses: load price rules from a user-picked CSV file and apply them.
   *  Resolves to the applied rules (or null when the user cancels). */
  importExpensePriceRules(): Promise<{ path: string; rules: ExpensePriceRule[] } | null>;
  /** Expenses: add a manual "purchased asset" row with a custom dollar amount. */
  addManualExpense(label: string, amount: number): Promise<LedgerView>;
  /** Expenses: remove one ledger row. */
  removeLedgerEntry(id: string): Promise<LedgerView>;
  /** Expenses: open the human-readable CSV ledger in the OS file manager. */
  openLedgerFile(): Promise<void>;
  /** Pre-generate the node-graph reference-thumbnail cache for every
   *  production (compressed JPEGs), reusing valid entries and pruning stale
   *  ones. Counts: newly encoded / reused from cache / could not encode. */
  regenerateThumbnails(): Promise<{ generated: number; fromDisk: number; failed: number; projects: number }>;
  onProductionEvent(cb: (e: ProductionEvent) => void): () => void;
}

/* ---------- IPC channel contract ----------
 *
 * The single wiring map between renderer-facing methods (CascadeApi) and the
 * IPC channels main listens on. The preload adapter builds `window.cascade`
 * from this map mechanically, so adding a channel means editing ONE entry here
 * instead of three files (ipc.ts + preload + main handlers). Main validates
 * every handler's channel against this map at startup. `kind` records whether
 * the renderer side is a request/response (`invoke`) or fire-and-forget
 * (`send`); the `on*` subscriptions are hand-wired in preload (they take
 * callbacks, not payloads).
 */
export interface IpcChannelSpec {
  /** The CascadeApi method that fronts this channel. */
  method: keyof CascadeApi;
  kind: "invoke" | "send";
}

export const ipcContract = {
  ...chatChannels,
  ...workspaceChannels,
  ...settingsChannels,
  ...sessionChannels,
  ...mcpChannels,
  ...agentChannels,
  ...productionChannels,
  ...ledgerChannels,
} as const satisfies Record<string, IpcChannelSpec>;

/** The subscription methods on CascadeApi, which preload wires by hand. */
type SubscriptionMethod =
  | "onAgentEvent"
  | "onApprovalRequest"
  | "onMentionAdded"
  | "onOpenSettings"
  | "onZoomChanged"
  | "onSessionRenamed"
  | "onAgentSwitched"
  | "onBoardExternalUpdate"
  | "onProductionEvent";

/** Every non-subscription method on CascadeApi must be wired in ipcContract,
 *  and every contract method must exist on CascadeApi — a type-level drift
 *  guard so the two can't fall out of sync without failing typecheck. */
type ContractMethod = (typeof ipcContract)[keyof typeof ipcContract]["method"];
type ExposedMethod = Exclude<keyof CascadeApi, SubscriptionMethod>;
type AssertEqual<A, B> = A extends B ? (B extends A ? true : false) : false;
const _ipcContractCoversApi: AssertEqual<ExposedMethod, ContractMethod> = true;

