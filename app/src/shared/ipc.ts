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
  /** Step 4: planned screen time in seconds (animatic). */
  durationSec?: number;
  /** Optional per-shot render-style override: the id of a ProductionStyle
   *  from the Step 2 set (legacy productions may store raw prompt text —
   *  resolved by name/prompt at generation time). When absent, the master
   *  style (styles[0]) applies. */
  style?: string;
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
}

/** A product whose look must stay consistent (label, packaging, hero item). */
export interface ProductRef {
  id: string;
  name: string;
  /** Reference image (data URL) attached in Step 2. */
  artwork?: string;
}

/** A user-added reference (material, texture, mood, hero prop) that must be
 *  applied to specific shots. Created in Step 2; associated to shots in Step 3. */
export interface CustomRef {
  /** Stable identity. */
  id: string;
  /** User label, e.g. "Gondola Interior". */
  name: string;
  /** Reference image (data URL) attached in Step 2. */
  artwork?: string;
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
 *  per-shot style dropdown in Storyboards (Step 3). */
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
  /** Base credit cost for one image job (may be null for metadata). */
  cost: number | null;
}

/** A TTS-capable audio model surfaced in the Step 4 voiceover picker. */
export interface AudioModelInfo {
  id: string;
  displayName: string;
  /** Voice ids the model accepts (OpenAI-style: alloy/echo/fable/onyx/nova/shimmer). */
  voices: string[];
  /** Base credit cost for one VO job (null when the registry didn't report one). */
  cost: number | null;
  /** What this audio model generates — the VO picker shows tts, the music
   *  picker shows music. */
  kind: "tts" | "music" | "sfx";
}

/** Voiceover generation choices made on the Step 4 VO panel. */
export interface VoiceoverConfig {
  /** Audio model id, or "auto" for Cascade to pick. */
  model: string;
  /** Voice id fed to the model (when the model supports voices). */
  voice: string;
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
  /** Step 4 voiceover generation preferences. */
  voiceover?: VoiceoverConfig;
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
  status: Record<number, "todo" | "running" | "done" | "error">;
  /** Which source was last ingested (shown in the Step 1 card). */
  scriptSource?: string;
  assets: { scriptMd: string; designDir: string; boardsDir: string; voiceoverDir: string; musicDir: string; outDir: string };
}

/** Log line streamed to the Production UI while a step runs. */
export interface ProductionEvent {
  id: string;
  message: string;
  level: "info" | "error" | "done";
}

/** API exposed to the renderer via contextBridge. */
export interface CascadeApi {
  sendMessage(sessionId: string, text: string, images?: string[]): Promise<void>;
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
  getRecentWorkspaces(): Promise<string[]>; // recent folders
  getCurrentWorkspace(): Promise<string | null>;
  getSettings(): Promise<SettingsView>;
  setApiKey(key: string): Promise<void>;
  setModel(model: string): Promise<void>;
  setAccent(color: string): Promise<void>;
  /** Fired when the user picks File → Settings… from the native menu. */
  onOpenSettings(cb: () => void): () => void;
  listModels(): Promise<ModelInfo[]>;
  getCredits(): Promise<number | null>;

  listSessions(): Promise<SessionMeta[]>;
  loadSession(id: string): Promise<unknown[]>; // display items
  /** Tell main which chat is now focused (keeps its active-chat pointer in sync). */
  activateSession(id: string): void;
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
  onAgentSwitched(cb: (e: { sessionId: string; agentId: string | null; frame: unknown }) => void): () => void;

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
  /** Native file dialog for a reference image. Returns a data URL or null. */
  pickReferenceImage(): Promise<string | null>;
  /**
   * Step 1: ingest a script. `source` is an absolute file path or a Google
   * Docs share URL. Resolves to the updated production.
   */
  ingestScript(productionId: string, source: string): Promise<Production>;
  /** Step 2 magic wand: refine the style notes via one LLM call. Returns the refined text. */
  refineStylePrompt(productionId: string, style: string): Promise<string>;
  /**
   * Step 2: generate up to 5 distinct named styles (name + generation prompt)
   * from the user's rough style notes. The renderer assigns numbers/ids and
   * persists them as the production's `styles` set.
   */
  generateStyles(productionId: string, notes: string): Promise<{ name: string; prompt: string }[]>;
  /** Insert a shot (mid-numbered) before the given position; returns updated production. */
  insertShot(productionId: string, sceneNumber: number, index: number): Promise<Production>;
  /** Remove a shot by its stable id. */
  deleteShot(productionId: string, shotId: string): Promise<Production>;
  /** Edit a shot's audio/visual text. */
  updateShot(productionId: string, shotId: string, patch: { audio?: string; visual?: string }): Promise<Production>;
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
  /** Step 4: list TTS-capable audio models for the voiceover picker. */
  listAudioModels(): Promise<AudioModelInfo[]>;
  /**
   * Step 4: synthesize one voiceover clip for the whole production (every
   * shot's dialogue joined). Writes the audio into voiceoverDir and stores
   * the relative path on the production. Resolves to the updated production.
   */
  generateVoiceover(productionId: string, opts?: { model?: string; voice?: string }): Promise<Production>;
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
  /**
   * Step 4: synthesize a background music clip from a text prompt using a
   * music-capable model. Writes the audio into musicDir and stores the
   * relative path on the production.
   */
  generateMusic(productionId: string, opts?: { model?: string; prompt?: string }): Promise<Production>;
  /** Step 4: read the imported music file as a data URL (for the inline player / animatic mixing). */
  musicFile(productionId: string): Promise<string | null>;
  /** Step 4: streamable `cascade-media://` URL for the music track. */
  musicUrl(productionId: string): Promise<string | null>;
  /** Step 4: remove the imported music file and clear musicPath. */
  removeMusic(productionId: string): Promise<Production>;
  onProductionEvent(cb: (e: ProductionEvent) => void): () => void;
}
