/** Types shared across main, preload, and renderer. */

import { chatChannels } from "./ipc-channels/chat.js";
import { workspaceChannels, settingsChannels } from "./ipc-channels/workspace.js";
import { sessionChannels } from "./ipc-channels/sessions.js";
import { mcpChannels } from "./ipc-channels/mcp.js";
import { agentChannels } from "./ipc-channels/agents.js";
import { productionChannels } from "./ipc-channels/production.js";
import { ledgerChannels } from "./ipc-channels/ledger.js";
import { modelCustomizerChannels } from "./ipc-channels/model-customizer.js";
import { todoChannels } from "./ipc-channels/todos.js";
import { goalChannels } from "./ipc-channels/goals.js";
import { suiteChannels } from "./ipc-channels/suite.js";
import { windowChannels } from "./ipc-channels/window.js";
import { cameraGridChannels } from "./ipc-channels/camera-grid.js";
import type {
  GenParams,
  GraphLayout,
  Graph,
  GraphEditNode,
  GraphGenItem,
  GraphSource,
  TweenBlock,
  PendingImageGen,
} from "./ipc/graph.js";
import type { SessionTasks } from "./ipc/todos.js";
import type { SessionGoal, SessionGoalPatch } from "./ipc/goal.js";
import type { SessionSearchHit } from "./ipc/search.js";
import type { LedgerView, ExpensePriceRule } from "./ipc/ledger.js";
import type {
  SuiteSession,
  SuiteGenerateRequest,
  SuiteEntry,
  SuiteExportTarget,
  SuiteExportResult,
} from "./ipc/suite.js";
import type { CanvasBusySnapshot, DetachedCanvasContext, DetachedCanvasState } from "./ipc/window.js";
import type {
  CameraGridCutoutRequest,
  CameraGridCutoutResult,
  CameraGridGenOptions,
  CameraGridImportResult,
} from "./ipc/camera-grid.js";
import type {
  ProductionMeta,
  ProductionScene,
  ProductionShot,
  ProductionStyle,
  ProductionModel,
  ProductionAssembly,
  Production,
  CharacterSheet,
  CharacterSheetBuilder,
  ProductRef,
  CustomRef,
  ReferenceCategory,
  SuggestedReference,
  OpenArtBoardConfig,
  ImageGenAspectRatio,
  ReferenceImageGenOptions,
  CharacterSheetView,
  CharacterSheetGenOptions,
  Model3dViewType,
  Model3dViewImage,
  Model3dGenOptions,
  StoryboardPdfSettings,
  StoryboardPdfExportOptions,
  StoryboardPdfExportResult,
  ProductionEvent,
} from "./ipc/production.js";
import type {
  MediaProviderId,
  MediaProviderInfo,
  HiggsfieldCliStatus,
  OpenArtCliStatus,
  ModelSurface,
  OpenArtModelChoice,
  MediaDefaultChoice,
  MediaDefaultCtx,
  ModelParamExposure,
  ModelParamDefaultValue,
  VideoGenOptions,
  GenerationCostRequest,
  VideoModelOptions,
  ImageModelOptions,
  CliModelSchema,
  MediaModelLadder,
  ModelProbeResult,
} from "./ipc/media.js";

// Domain type modules (step 06 T1). Re-exported here so every existing
// `shared/ipc.js` import path keeps working.
export * from "./ipc/goal.js";
export * from "./ipc/graph.js";
export * from "./ipc/ledger.js";
export * from "./ipc/media.js";
export * from "./ipc/production.js";
export * from "./ipc/search.js";
export * from "./ipc/suite.js";
export * from "./ipc/todos.js";
export * from "./ipc/window.js";
export * from "./ipc/camera-grid.js";


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

/** Chat-side account balance for the active provider: credits (gab) or US
 *  dollars (Cheaper Inference), tagged so the footer formats it correctly. */
export interface ChatBalance {
  amount: number;
  unit: "credits" | "usd";
}

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
  /** User overrides for the creative prompt templates (Settings → Prompts),
   *  keyed by template id. Absent id = the built-in wording. */
  getPromptTemplates(): Promise<Record<string, string>>;
  setPromptTemplates(overrides: Record<string, string>): Promise<void>;
  /** Dev Model Customizer: per-parameter placement (`modelId::flag` →
   *  core/advanced/hidden). */
  getModelOptionExposure(): Promise<Record<string, ModelParamExposure>>;
  setModelOptionExposure(key: string, placement: ModelParamExposure | null): Promise<void>;
  resetModelOptionExposure(): Promise<void>;
  /** Per-model surface assignments (which pickers a model is offered on). */
  getModelSurfaces(): Promise<Record<string, ModelSurface[]>>;
  setModelSurfaces(surfaces: Record<string, ModelSurface[]>): Promise<void>;
  resetModelSurfaces(): Promise<void>;
  /** Dev Model Customizer: per-surface parameter defaults applied when a model
   *  loads (`<modelId>::<surface>::<flag>` → value). */
  getModelParamDefaults(): Promise<Record<string, ModelParamDefaultValue>>;
  setModelParamDefault(key: string, value: ModelParamDefaultValue | null): Promise<void>;
  resetModelParamDefaults(): Promise<void>;
  /** Probe one media provider's catalog (dev Model Customizer). Read-only. */
  probeModels(providerId: MediaProviderId): Promise<ModelProbeResult>;
  /** Probe one model's full option schema from a specific provider. */
  probeModelOptions(providerId: MediaProviderId, modelId: string): Promise<CliModelSchema | null>;
  /** Drop a provider's cached probes so the next probe refetches. */
  refreshModelProbe(providerId?: MediaProviderId): Promise<void>;
  /** Dollar value of one Higgsfield credit for the Expenses total (null when
   *  unset — credit rows show their credits and contribute $0 until set).
   *  Edited in the dev Model Customizer; saving re-prices history. */
  getHiggsfieldCreditRate(): Promise<number | null>;
  setHiggsfieldCreditRate(v: number | null): Promise<number | null>;
  /** Dev Mode: verbose human-readable submission logging. */
  getDevMode(): Promise<boolean>;
  setDevMode(v: boolean): Promise<void>;
  /** Credit-free dry run: build + log the request, throw before vendor call. */
  getSubmissionDryRun(): Promise<boolean>;
  setSubmissionDryRun(v: boolean): Promise<void>;
  /** Reveal the Dev Mode submission log in the OS file manager. */
  openSubmissionLog(): Promise<void>;
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
  getCredits(): Promise<ChatBalance | null>;
  /** Remaining credit balance on the signed-in OpenArt account (null when OpenArt isn't connected). */
  getOpenArtCredits(): Promise<number | null>;

  listSessions(): Promise<SessionMeta[]>;
  /** Full-text search across every chat's transcript (read-only; no storage change). */
  searchSessions(query: string, limit?: number): Promise<SessionSearchHit[]>;
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
  /** Read a chat's durable task list (restored from disk — survives restarts). */
  getSessionTodos(sessionId: string): Promise<SessionTasks>;
  /** Fired after a chat's todo_write persists, so the panel updates live. */
  onTodosChanged(cb: (e: { sessionId: string; tasks: SessionTasks }) => void): () => void;
  /** Read a chat's durable goal (objective + status + continuation flag). */
  getSessionGoal(sessionId: string): Promise<SessionGoal>;
  /** Pause/resume/mark done the goal, or toggle opt-in auto-continuation. */
  setSessionGoal(sessionId: string, patch: SessionGoalPatch): Promise<SessionGoal>;
  /** Fired after a chat's goal changes (model tools or the UI). */
  onGoalChanged(cb: (e: { sessionId: string; goal: SessionGoal }) => void): () => void;

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
   * Step 3: a completed frame dragged onto another frame becomes a reference.
   * Copies the source frame's original file (full resolution — never the
   * resized thumbnail `boardImage` returns) into this production's
   * referencesDir and returns its workspace-relative path. The source shot may
   * live in a different production.
   */
  addBoardFrameReference(productionId: string, sourceProductionId: string, sourceShotId: string, fileName: string): Promise<{ path: string } | null>;
  /**
   * Step 2: delete a custom reference entirely — JSON entry, on-disk files,
   * and every node + connection it had across all shots (output pipe, video
   * sources, tween keyframes, edit-node sources, prompt tags, canvas
   * placement). Returns the updated production.
   */
  deleteReference(productionId: string, refId: string): Promise<Production>;
  /**
   * Step 2: rename a custom reference and rewrite its `@[name]` tags across
   * every prompt store (composer, video, edit, edit-video, edit nodes, tween
   * blocks, magic prompts) so its node graph follows the new name instead of
   * disconnecting. Returns the updated production.
   */
  renameReference(productionId: string, refId: string, name: string): Promise<Production>;
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
  styleFromImage(productionId: string, imageDataUrl: string): Promise<{ name: string; prompt: string; imagePath?: string }>;
  /**
   * Step 2: generate a style frame (look plate) for one style via the active
   * media provider — fixed neutral-subject scaffold + the style's text —
   * persist it to styles/ and point the style at it (frameSource "generated").
   * Returns the updated production.
   */
  generateStyleFrame(productionId: string, styleId: string, model?: string, resolution?: string, params?: Record<string, string | number | boolean | string[]>): Promise<Production>;
  /**
   * Step 2: attach an existing image (data URL) as one style's frame
   * (frameSource "upload"). Returns the updated production.
   */
  setStyleFrame(productionId: string, styleId: string, imageDataUrl: string): Promise<Production>;
  /** Step 3: lock the look — copy an approved shot frame to styles/ and point
   *  the shot's style (or the master) at it (frameSource "anchor"). */
  useShotAsStyleFrame(productionId: string, shotId: string, styleId?: string): Promise<Production>;
  /**
   * Step 2: reclaim a style frame from a vendor job that outlived the
   * generating call (the wait timed out or a transient error hit). Rechecks
   * the pending job and downloads/attaches the frame when it's ready.
   */
  recheckStyleFrame(productionId: string, styleId: string): Promise<Production>;
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
  /** Bring an outdated panel (preserved from a previous script re-ingest) back into the active storyboard with a fresh number; its board files relocate with it. */
  restoreOutdatedShot(productionId: string, shotId: string): Promise<Production>;
  /** Permanently delete an outdated panel and its preserved board files. */
  removeOutdatedShot(productionId: string, shotId: string): Promise<Production>;
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
  /**
   * Step 3: import one dropped file onto a single panel. The renderer reads
   * the OS file as a data URL (browser File drops carry no disk path, unlike
   * the native picker behind `pickBoardImages`), so this is the drop-target
   * sibling of `importBoards` — same frame write + history wiring, one shot.
   */
  importBoardImage(productionId: string, shotId: string, fileName: string, dataUrl: string): Promise<Production>;
  /**
   * Step 3: import one dropped video file onto a single panel. The clip is
   * saved as a reference video and piped into the frame output — the same
   * end state as a node-graph reference-node → output wiring. Bytes ride
   * raw (ArrayBuffer, like `addReferenceMedia`), never as a data URL.
   */
  importBoardVideo(productionId: string, shotId: string, fileName: string, mime: string, bytes: ArrayBuffer): Promise<Production>;
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
   * the new current frame (the old one moves into the history). `params`
   * carries the schema-driven model options (variant, seed, …); absent means
   * vendor defaults.
   */
  editBoard(productionId: string, shotId: string, model: string, prompt: string, params?: Record<string, string | number | boolean | string[]>, resolution?: string): Promise<Production>;
  /**
   * Step 3: make a stored frame primary, selecting its image/edit generation
   * and wiring that node to the output. The path stays stable as history grows.
   */
  promoteBoardHistory(productionId: string, shotId: string, framePath: string): Promise<Production>;
  /**
   * Step 3: permanently delete one stored generation (image/video/edit/
   * edit-video/in-betweener take) from a shot — removes the history entry and
   * unlinks the file. Rejected when the generation is currently feeding the
   * storyboard, the animatic, or a node pipe. Returns the updated production.
   */
  deleteGeneration(productionId: string, shotId: string, rel: string): Promise<Production>;
  /**
   * Step 3/4: save any stored generated image or clip as a new reference —
   * copy the file into referencesDir and add a `CustomRef` named "Saved Ref_00"
   * (then _01, _02, …), without tagging any prompt. Returns the updated
   * production.
   */
  saveGenerationAsReference(productionId: string, shotId: string, rel: string): Promise<Production>;
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
   * Writes the clip into the shot's board folder under `video/` and stores the
   * relative path on the shot.
   */
  generateVideo(productionId: string, shotId: string, opts: VideoGenOptions): Promise<Production>;
  /**
   * Step 3 node graph: generate one frame from a custom prompt (the prompt
   * composer's text) without touching the shot's artwork — the result is
   * stored on the image generation node. Returns the updated production.
   */
  generateFrameNode(productionId: string, shotId: string, opts: { prompt: string; model: string; resolution: string; params?: GenParams }): Promise<Production>;
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
  generateEditNode(productionId: string, shotId: string, opts: { nodeId?: string; prompt: string; model: string; resolution: string; params?: GenParams }): Promise<Production>;
  /**
   * Step 3 node graph: upscale the upscale node's source image (its source
   * pipe, falling back to the shot's current frame) and store the result on
   * the shot's upscale node. Returns the updated production.
   */
  generateUpscaleNode(productionId: string, shotId: string, opts: { model: string; resolution: string; params?: GenParams }): Promise<Production>;
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
  /** Step 3/4: the full normalized option schema for a model (from its live
   *  `model get --json` detail). Null when the model form can't be read —
   *  callers fall back to `videoModelOptions`/`imageModelOptions`. */
  modelOptions(modelId: string): Promise<CliModelSchema | null>;
  /** Step 3 in-betweener: ids of the video-capable models that accept a
   *  dedicated end-frame slot (live form/schema probe) unioned with the
   *  user's manual allowlist (Settings → Media generation). The tween model
   *  lists offer ONLY these ids. */
  videoEndFrameModels(): Promise<string[]>;
  /** Ids (namespaced) of the video models that accept a video input (the
   *  edit-video node's capability probe). Empty when none is proven. */
  videoEditModels(): Promise<string[]>;
  /** Ids (namespaced) of the image models that upscale an existing image
   *  (the upscale node + Image Suite Upscale mode capability probe), unioned
   *  with the models the user assigned to the `image:upscale` surface. */
  imageUpscaleModels(): Promise<string[]>;
  /** Step 3/4: live per-config credit quote for one generation (Higgsfield
   *  CLI `generate cost` preflight — no job submitted). Null for providers
   *  without a cost surface and whenever the quote can't be read — callers
   *  hide the quote and never block submit. Fractional credits possible. */
  generationCost(req: GenerationCostRequest): Promise<number | null>;
  /** Step 3 node graph: edit one video (mandatory video source + prompt +
   *  references) and store the result on the shot's edit-video node. */
  generateEditVideoNode(productionId: string, shotId: string, opts: { prompt: string; model: string; resolution: string; sourcePath?: string; sourceRefId?: string; refIds?: string[]; params?: GenParams }): Promise<Production>;
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
  /** Expenses: one production's ledger (entries + running total + per-kind
   *  counts). Scope is the production — the ledger is saved per project. */
  getLedger(productionId: string): Promise<LedgerView>;
  /** Expenses: the pricing rules edited from Settings. Global — pricing is
   *  per-model, not per-project. */
  getExpensePriceRules(): Promise<ExpensePriceRule[]>;
  /** Expenses: persist the pricing rules edited from Settings. Saving re-prices
   *  every existing generation against the new ranges (manual rows untouched). */
  setExpensePriceRules(rules: ExpensePriceRule[]): Promise<void>;
  /** Expenses: re-run the current rules over every production's generations and
   *  update prices (manual rows untouched). Resolves to this project's view. */
  repriceExpenses(productionId: string): Promise<LedgerView>;
  /** Expenses: save the current price rules to a user-picked CSV file.
   *  Resolves to the saved path, or null when the user cancels. */
  exportExpensePriceRules(): Promise<string | null>;
  /** Expenses: load price rules from a user-picked CSV file and apply them.
   *  Resolves to the applied rules (or null when the user cancels). */
  importExpensePriceRules(): Promise<{ path: string; rules: ExpensePriceRule[] } | null>;
  /** Expenses: add a manual "purchased asset" row to one production's ledger. */
  addManualExpense(productionId: string, label: string, amount: number): Promise<LedgerView>;
  /** Expenses: remove one row from a production's ledger. */
  removeLedgerEntry(productionId: string, id: string): Promise<LedgerView>;
  /** Expenses: open one production's human-readable CSV ledger in the OS file
   *  manager. */
  openLedgerFile(productionId: string): Promise<void>;
  /** Pre-generate the node-graph reference-thumbnail cache for every
   *  production (compressed JPEGs), reusing valid entries and pruning stale
   *  ones. Counts: newly encoded / reused from cache / could not encode. */
  regenerateThumbnails(): Promise<{ generated: number; fromDisk: number; failed: number; projects: number }>;
  onProductionEvent(cb: (e: ProductionEvent) => void): () => void;

  /* Image Generation & Editing Suite (Spec 01) */
  /** Load the persisted suite session for one production (empty when none). */
  loadSuiteSession(productionId: string): Promise<SuiteSession>;
  /** Persist one production's suite session (draft + timeline). */
  saveSuiteSession(productionId: string, session: SuiteSession): Promise<void>;
  /** Delete one suite entry (and its output file). Returns the session. */
  deleteSuiteEntry(productionId: string, entryId: string): Promise<SuiteSession>;
  /** Copy one entry's output into the production as a reference or board file. */
  exportSuiteEntry(productionId: string, entryId: string, target: SuiteExportTarget): Promise<SuiteExportResult>;
  /** Run one suite generation/edit through the active `MediaProvider`, writing
   *  the output into the production's suite folder. Vendor-blind. */
  generateSuiteImage(productionId: string, req: SuiteGenerateRequest): Promise<SuiteEntry>;

  /* Detached canvas window (Spec 03) */
  /** Open (or retarget) the single detached canvas window. Resolves to its state. */
  openDetachedCanvas(ctx: DetachedCanvasContext): Promise<DetachedCanvasState>;
  /** Close the detached canvas window. Resolves to its (cleared) state. */
  closeDetachedCanvas(): Promise<DetachedCanvasState>;
  /** Whether a detached canvas window is open and what it currently shows. */
  getDetachedCanvasState(): Promise<DetachedCanvasState>;
  /** The main window's selected storyboard frame changed (hot path — a send). */
  canvasSelectionChanged(frameId: string | null): void;
  /** Publish this window's in-flight canvas jobs; main relays to the sibling
   *  window so "Generating…" shows wherever the graph lives. */
  canvasBusyChanged(snapshot: CanvasBusySnapshot): void;
  /** Fired in the detached window with its context (also on retarget/reload). */
  onCanvasContext(cb: (ctx: DetachedCanvasContext) => void): () => void;
  /** Fired in the detached window when the main window's frame selection moves. */
  onCanvasSelectionChanged(cb: (e: { frameId: string | null }) => void): () => void;
  /** Fired with the other window's in-flight canvas jobs (main ↔ detached). */
  onCanvasBusy(cb: (snapshot: CanvasBusySnapshot) => void): () => void;
  /** Fired in the main window when the detached canvas window closes. */
  onDetachedClosed(cb: () => void): () => void;

  /* 16-panel camera grid (Spec 04) */
  /** Generate (or regenerate) a shot's camera-grid sheet in place through the
   *  active `MediaProvider`. Writes the sheet into referencesDir and returns
   *  the saved production. Vendor-blind. */
  generateCameraGrid(productionId: string, shotId: string, opts: CameraGridGenOptions): Promise<Production>;
  /** Use a wired image (e.g. a grid downloaded from OpenArt by hand) as the
   *  camera-grid sheet to cut panels out of — the manual fallback when the auto
   *  download fails. Main copies it into referencesDir and returns the copy's
   *  path; the renderer then binds it as the sheet. */
  importCameraGridImage(productionId: string, shotId: string, source: GraphSource): Promise<CameraGridImportResult>;
  /** Crop marqueed panels out of a camera-grid sheet into standalone
   *  references (one per rect), saving the production. Returns the created
   *  references + the saved production. */
  cutoutCameraGrid(req: CameraGridCutoutRequest): Promise<CameraGridCutoutResult>;
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
  ...modelCustomizerChannels,
  ...todoChannels,
  ...goalChannels,
  ...suiteChannels,
  ...windowChannels,
  ...cameraGridChannels,
} as const satisfies Record<string, IpcChannelSpec>;

/** The subscription methods on CascadeApi, which preload wires by hand. */
type SubscriptionMethod =
  | "onAgentEvent"
  | "onApprovalRequest"
  | "onMentionAdded"
  | "onOpenSettings"
  | "onZoomChanged"
  | "onSessionRenamed"
  | "onTodosChanged"
  | "onGoalChanged"
  | "onAgentSwitched"
  | "onBoardExternalUpdate"
  | "onProductionEvent"
  | "onCanvasContext"
  | "onCanvasSelectionChanged"
  | "onCanvasBusy"
  | "onDetachedClosed";

/** Every non-subscription method on CascadeApi must be wired in ipcContract,
 *  and every contract method must exist on CascadeApi — a type-level drift
 *  guard so the two can't fall out of sync without failing typecheck. */
type ContractMethod = (typeof ipcContract)[keyof typeof ipcContract]["method"];
type ExposedMethod = Exclude<keyof CascadeApi, SubscriptionMethod>;
type AssertEqual<A, B> = A extends B ? (B extends A ? true : false) : false;
const _ipcContractCoversApi: AssertEqual<ExposedMethod, ContractMethod> = true;

