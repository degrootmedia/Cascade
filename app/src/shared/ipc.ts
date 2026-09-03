/** Types shared across main, preload, and renderer. */

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
  | { type: "error"; message: string };

/** An agent event tagged with the chat (session) it belongs to, so the renderer
 *  can route it to the right transcript even when multiple chats are live. */
export interface ChatEvent {
  sessionId: string;
  event: AgentEventIpc;
}

export interface SettingsView {
  hasApiKey: boolean;
  model: string;
  workspace: string | null;
  /** UI accent color (hex). */
  accent: string;
  /** Absolute path to the external image editor, or null when not set. */
  externalEditor: string | null;
}

export interface ModelInfo {
  id: string;
  thinking: boolean;
  vision: boolean;
  /** Credits per request at base context. */
  baseCost: number;
}

export interface SkillInfo {
  name: string;
  description: string;
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
  /** Canvas pan/zoom as last left by the user. */
  viewport?: { x: number; y: number; zoom: number };
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
  /** Whether the generated prompt includes the production brand identity. */
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
  /** Node graph edit-image node: stored edits (newest first) + index. */
  graphEditGens?: GraphGenItem[];
  graphEditGenIndex?: number;
  /** The edit-prompt node's text (edit instructions for the edit-image node). */
  graphEditPrompt?: string;
  /** Whether the image generation node's output feeds the edit-image node's
   *  source input (the image being edited). */
  graphEditImageSource?: boolean;
  /** A reference feeding the edit-image node's source input (single source —
   *  connecting one displaces the other). Only image refs connect. */
  graphEditSourceRefId?: string;
  /** Reference ids feeding the video gen node's extra reference inputs (beyond
   *  the main image pipe), in connection order. Only image refs connect. */
  graphVideoRefIds?: string[];
  /** Whether the image generation node's output also feeds the video node's
   *  image input. Independent of the output feed — the image node can pipe to
   *  the video node AND the output simultaneously. */
  graphImageToVideo?: boolean;
  /** Whether the style node is plugged into the image prompt (composer). When
   *  false the Style paragraph is absent from that prompt but the plug is
   *  remembered — switching the style to None removes the paragraph without
   *  disconnecting. */
  graphStyleConnected?: boolean;
  /** Whether the style node is plugged into the video-prompt node. */
  graphVideoStyleConnected?: boolean;
  /** Whether the style node is plugged into the edit-prompt node. */
  graphEditStyleConnected?: boolean;
  /** Which node is piped into the output (becomes the shot's primary
   *  artwork/videoPath): an image/video generation node, or a reference. */
  graphOutputSource?: "imagegen" | "videogen" | "editgen" | "ref";
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
}

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
  /** Which source was last ingested (shown in the Step 1 card). */
  scriptSource?: string;
  /** Step 5 assembly configuration + last-run bookkeeping. */
  assembly?: ProductionAssembly;
  assets: { scriptMd: string; boardsDir: string; voiceoverDir: string; musicDir: string; videosDir: string; outDir: string; referencesDir: string; assemblyDir: string };
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
  setAccent(color: string): Promise<void>;
  pickExternalEditor(): Promise<string | null>;
  setExternalEditor(path: string | null): Promise<void>;
  /** Open an image in the external editor (or the OS default when none is set). */
  openInExternalEditor(opts: { productionId?: string; relPath?: string; dataUrl?: string }): Promise<void>;
  /** Fired when the user picks File → Settings… from the native menu. */
  onOpenSettings(cb: () => void): () => void;
  /** Fired after the window's page zoom changes (Ctrl+/-/0 or pinch), so canvases can re-rasterize. */
  onZoomChanged(cb: () => void): () => void;
  listModels(): Promise<ModelInfo[]>;
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
  /** Move a shot before another shot (or to the end when beforeShotId is null). Re-numbers and relocates board files. */
  reorderShot(productionId: string, shotId: string, beforeShotId: string | null): Promise<Production>;
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
   *  `index` selects an entry of the shot's `artworkHistory` (0 = most recent
   *  previous frame); omit it for the current frame. */
  boardImage(productionId: string, shotId: string, index?: number): Promise<string | null>;
  /** Load a board frame at full resolution (no downscale) for the lightbox. */
  boardImageFull(productionId: string, shotId: string, index?: number): Promise<string | null>;
  boardThumbnail(productionId: string, shotId: string, index?: number): Promise<string | null>;
  deleteBoardImage(productionId: string, shotId: string): Promise<Production>;
  /**
   * Step 3: edit a shot's current frame via an image-input model — the frame
   * is sent as a visual reference alongside `prompt`, and the result becomes
   * the new current frame (the old one moves into the history).
   */
  editBoard(productionId: string, shotId: string, model: string, prompt: string): Promise<Production>;
  /**
   * Step 3: promote a history frame back to primary for a shot. The current
   * `artwork` moves into `artworkHistory`; the selected history entry becomes
   * the active frame. Returns the updated production.
   */
  promoteBoardHistory(productionId: string, shotId: string, index: number): Promise<Production>;
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
   * Step 3 node graph: AI-edit one image for the edit-image node. The source
   * image is the node's source pipe (image node selection, else a reference),
   * falling back to the shot's current frame. The result is stored on the
   * edit-image node. Returns the updated production.
   */
  generateEditNode(productionId: string, shotId: string, opts: { prompt: string; model: string; resolution: string }): Promise<Production>;
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
  /** Step 3: Magic Prompt — generate content-only prompts for the full storyboard (enables magic). */
  generateMagicPrompts(productionId: string): Promise<Production>;
  /** Step 3: toggle Magic Prompt alternate state on/off (false restores original prompts). */
  setMagicEnabled(productionId: string, enabled: boolean): Promise<Production>;
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
  "chat:send": { method: "sendMessage", kind: "invoke" },
  "chat:stop": { method: "stop", kind: "send" },
  "chat:undo": { method: "undoLast", kind: "invoke" },
  "approval:response": { method: "respondApproval", kind: "send" },
  "display:sync": { method: "syncDisplay", kind: "send" },

  "workspace:pick": { method: "pickWorkspace", kind: "invoke" },
  "workspace:pickSession": { method: "pickSessionWorkspace", kind: "invoke" },
  "workspace:setSession": { method: "setSessionWorkspace", kind: "invoke" },
  "workspace:setSessionNone": { method: "setSessionWorkspaceNone", kind: "invoke" },
  "settings:clearWorkspace": { method: "clearDefaultWorkspace", kind: "invoke" },
  "workspace:recent": { method: "getRecentWorkspaces", kind: "invoke" },
  "workspace:current": { method: "getCurrentWorkspace", kind: "invoke" },
  "settings:get": { method: "getSettings", kind: "invoke" },
  "settings:setApiKey": { method: "setApiKey", kind: "invoke" },
  "settings:setModel": { method: "setModel", kind: "invoke" },
  "settings:setAccent": { method: "setAccent", kind: "invoke" },
  "settings:pickExternalEditor": { method: "pickExternalEditor", kind: "invoke" },
  "settings:setExternalEditor": { method: "setExternalEditor", kind: "invoke" },
  "external:open": { method: "openInExternalEditor", kind: "invoke" },
  "models:list": { method: "listModels", kind: "invoke" },
  "credits:get": { method: "getCredits", kind: "invoke" },

  "sessions:list": { method: "listSessions", kind: "invoke" },
  "sessions:load": { method: "loadSession", kind: "invoke" },
  "sessions:activate": { method: "activateSession", kind: "send" },
  "sessions:new": { method: "newSession", kind: "invoke" },
  "sessions:current": { method: "getCurrentSessionId", kind: "invoke" },
  "sessions:remove": { method: "removeSession", kind: "invoke" },
  "sessions:rename": { method: "renameSession", kind: "invoke" },

  "skills:list": { method: "listSkills", kind: "invoke" },
  "skills:openFolder": { method: "openSkillsFolder", kind: "invoke" },
  "workspace:instructions": { method: "getWorkspaceInstructions", kind: "invoke" },
  "workspace:openInstructions": { method: "openWorkspaceInstructions", kind: "invoke" },

  "mcp:getConfig": { method: "getMcpConfig", kind: "invoke" },
  "mcp:setConfig": { method: "setMcpConfig", kind: "invoke" },
  "mcp:status": { method: "getMcpStatus", kind: "invoke" },
  "mcp:reload": { method: "reloadMcp", kind: "invoke" },
  "mcp:onDemand": { method: "getMcpOnDemand", kind: "invoke" },
  "mcp:setOnDemand": { method: "setMcpOnDemand", kind: "invoke" },

  "agents:list": { method: "listAgents", kind: "invoke" },
  "agents:get": { method: "getAgent", kind: "invoke" },
  "agents:create": { method: "createAgent", kind: "invoke" },
  "agents:update": { method: "updateAgent", kind: "invoke" },
  "agents:uploadAvatar": { method: "uploadAgentAvatar", kind: "invoke" },
  "agents:duplicate": { method: "duplicateAgent", kind: "invoke" },
  "agents:remove": { method: "removeAgent", kind: "invoke" },
  "agents:export": { method: "exportAgent", kind: "invoke" },
  "agents:import": { method: "importAgent", kind: "invoke" },
  "agents:getSessionAgent": { method: "getSessionAgent", kind: "invoke" },
  "agents:setSessionAgent": { method: "setSessionAgent", kind: "invoke" },

  /* Production Assistant */
  "production:list": { method: "listProductions", kind: "invoke" },
  "production:pickFolder": { method: "pickProductionFolder", kind: "invoke" },
  "production:create": { method: "createProduction", kind: "invoke" },
  "production:load": { method: "loadProduction", kind: "invoke" },
  "production:save": { method: "saveProduction", kind: "invoke" },
  "production:remove": { method: "removeProduction", kind: "invoke" },
  "production:pickScriptFile": { method: "pickScriptFile", kind: "invoke" },
  "production:pickReferenceImage": { method: "pickReferenceImage", kind: "invoke" },
  "production:addReferenceMedia": { method: "addReferenceMedia", kind: "invoke" },
  "production:addReferenceImage": { method: "addReferenceImage", kind: "invoke" },
  "production:generateReferenceImage": { method: "generateReferenceImage", kind: "invoke" },
  "production:generateCharacterSheet": { method: "generateCharacterSheet", kind: "invoke" },
  "production:removeReferenceFile": { method: "removeReferenceFile", kind: "invoke" },
  "production:ingest": { method: "ingestScript", kind: "invoke" },
  "production:refineStyle": { method: "refineStylePrompt", kind: "invoke" },
  "production:refineCharacterDescription": { method: "refineCharacterDescription", kind: "invoke" },
  "production:generateStyles": { method: "generateStyles", kind: "invoke" },
  "production:styleFromImage": { method: "styleFromImage", kind: "invoke" },
  "production:insertShot": { method: "insertShot", kind: "invoke" },
  "production:deleteShot": { method: "deleteShot", kind: "invoke" },
  "production:updateShot": { method: "updateShot", kind: "invoke" },
  "production:reorderShot": { method: "reorderShot", kind: "invoke" },
  "production:generateBoards": { method: "generateBoards", kind: "invoke" },
  "production:regenerateBoard": { method: "regenerateBoard", kind: "invoke" },
  "production:regenerateBoards": { method: "regenerateBoards", kind: "invoke" },
  "production:recheckBoard": { method: "recheckBoard", kind: "invoke" },
  "production:boardPrompts": { method: "exportBoardPrompts", kind: "invoke" },
  "production:boardPrompt": { method: "getBoardPrompt", kind: "invoke" },
  "production:updateBoardPrompt": { method: "updateBoardPrompt", kind: "invoke" },
  "production:refreshBoardPrompt": { method: "refreshBoardPrompt", kind: "invoke" },
  "production:openArtModels": { method: "listOpenArtModels", kind: "invoke" },
  "production:openArtCredits": { method: "getOpenArtCredits", kind: "invoke" },
  "production:pickBoardImages": { method: "pickBoardImages", kind: "invoke" },
  "production:importBoards": { method: "importBoards", kind: "invoke" },
  "production:boardImage": { method: "boardImage", kind: "invoke" },
  "production:boardImageFull": { method: "boardImageFull", kind: "invoke" },
  "production:boardThumbnail": { method: "boardThumbnail", kind: "invoke" },
  "production:deleteBoardImage": { method: "deleteBoardImage", kind: "invoke" },
  "production:editBoard": { method: "editBoard", kind: "invoke" },
  "production:promoteBoardHistory": { method: "promoteBoardHistory", kind: "invoke" },
  "production:planAnimatic": { method: "planAnimatic", kind: "invoke" },
  "production:importVoiceover": { method: "importVoiceover", kind: "invoke" },
  "production:voiceoverFile": { method: "voiceoverFile", kind: "invoke" },
  "production:voiceoverUrl": { method: "voiceoverUrl", kind: "invoke" },
  "production:removeVoiceover": { method: "removeVoiceover", kind: "invoke" },
  "production:importMusic": { method: "importMusic", kind: "invoke" },
  "production:musicFile": { method: "musicFile", kind: "invoke" },
  "production:musicUrl": { method: "musicUrl", kind: "invoke" },
  "production:removeMusic": { method: "removeMusic", kind: "invoke" },
"production:generateVideo": { method: "generateVideo", kind: "invoke" },
  "production:generateFrameNode": { method: "generateFrameNode", kind: "invoke" },
  "production:generateVideoNode": { method: "generateVideoNode", kind: "invoke" },
  "production:generateEditNode": { method: "generateEditNode", kind: "invoke" },
  "production:applyGraphOutput": { method: "applyGraphOutput", kind: "invoke" },
  "production:applyGraphRefOutput": { method: "applyGraphRefOutput", kind: "invoke" },
  "production:videoUrl": { method: "videoUrl", kind: "invoke" },
  "production:removeVideo": { method: "removeVideo", kind: "invoke" },
  "production:videoModelOptions": { method: "videoModelOptions", kind: "invoke" },
  "production:generateMagicPrompts": { method: "generateMagicPrompts", kind: "invoke" },
  "production:setMagicEnabled": { method: "setMagicEnabled", kind: "invoke" },
  "production:checkExternalEdits": { method: "checkExternalEdits", kind: "invoke" },
  "production:assemblyBuild": { method: "assemblyBuild", kind: "invoke" },
  "production:assemblyRender": { method: "assemblyRender", kind: "invoke" },
  "production:assemblyOpenFolder": { method: "assemblyOpenFolder", kind: "invoke" },
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

