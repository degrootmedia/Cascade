/**
 * Cascade main process: window creation, IPC wiring, agent lifecycle.
 * All privileged work (API key, file tools, shell) stays in this process.
 */
import { app, BrowserWindow, dialog, ipcMain, session, shell, Menu, nativeImage, protocol, screen } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Agent, ChatClient, suggestChatTitle, friendlyApiError, loadWorkspaceInstructions, workspaceInstructionsFile, type ChatMessage, type AgentTool } from "@core";
import * as settings from "./settings.js";
import * as sessions from "./sessions.js";
import * as agents from "./agents.js";
import * as productions from "./productions.js";
import * as shotter from "./shotter.js";
import { ingestScript, refineStylePrompt, refineCharacterDescription, generateStyleSet, stylePromptFromImage, assetPath, scriptMarkdown, generateBoards, planAnimatic, exportBoardPrompts, importBoards, scanBoardImportFolder, effectivePrompt, shotReferences, refArtworkDataUrl, refMediaDataUrl, recordBoardArtwork, recordGraphImageGen, recordGraphVideoGen, recordGraphEditVideoGen, recordGraphEditGen, hookImageGenToOutput, hookVideoGenToOutput, applyVideoOutput, writeBoardFrame, writeStyleFrame, brandPrompt, archiveAsset, generateMagicPrompts, stripMagicLeakage, originalForJpegRel, regenerateBoardJpeg, relocateBoardsForRenumber, refreshBoardLinks, characterSheetPrompt, upsertCharacterSheetRef, recordTweenBlockGen, tweenSelectedClips, tweenClampGap, syncTweenBlocks, buildTweenConcatList, unstitchTween } from "./pipeline.js";
import { styleFramePrompt } from "../shared/look.js";
import { McpManager } from "./mcp.js";
import { resolveProductionFile } from "./media-menu.js";
import { recordBoardEdit, selectBoardFrame, syncBoardOutputToPipe, rebaseGenIndex, buildEditGenPrompt, getEditNode, newEditNode, chainSourceForEdit, editNodeSelection, shotVideoDir, shotVideoRelPath } from "./pipeline.js";
import { boardFrameHistory } from "../shared/board-frames.js";
import { createProviders, listAllModelLadders, applyKindOverrides, applyModelSurfaces, resolveProviderId, mediaForModel, getMediaCredits, PROVIDER_IDS, PROVIDER_META } from "./providers/registry.js";
import { getHiggsfieldCliStatus, resolveHiggsfieldCliBinary } from "./providers/higgsfield-cli.js";
import { getOpenArtCliStatus, resolveOpenArtCliBinary } from "./providers/openart-cli.js";
import { resolvePromptRefs } from "./providers/refs.js";
import type { MediaProvider, MediaProviderId } from "./providers/types.js";
import { ModelGenClient, modelFileName, toProductionModel } from "./modelgen.js";
import * as ledger from "./ledger.js";
import { assemble, renderAnimatic } from "./assembly.js";
import { buildStoryboardPdf, detectImageKind, loadLogoImage, loadPanelImage, sanitizeVersion, storyboardPdfFileName } from "./storyboard-pdf.js";
import { probeMedia, resolveFfmpeg, runFfmpeg } from "./ffmpeg.js";
import { loadSkills, makeReadSkillTool, ensureSkillsDir, seedSkills } from "./skills.js";
import { makeOpenArtUploadTool } from "./openart-upload.js";
import { ipcContract, TWEEN_KEY_IMGGEN, parseEditNodeKeyframe, sanitizeGenParams, sortByModelOrder, styleFrameOverride, type DisplayItem, type ChatAttachment } from "../shared/ipc.js";
import { validateIpcArgs } from "../shared/ipc-schemas.js";
import { isTrustedSender } from "./ipc/handle.js";
import { dataUrlToBytes, parsePromptBoxes, stripReferenceClause } from "../shared/prompt-grammar.js";
import { extractModelList, getProvider, normalizeModelList } from "../shared/providers.js";
import type { AgentEventIpc, ApprovalDecisionIpc, Production, ProductionEvent, ProductionShot, VideoGenOptions, VideoModelOptions, ImageModelOptions, GenerationCostRequest, GenParams, CliModelSchema, ModelParamExposure, ModelParamDefaultValue, ModelProbeResult, HiggsfieldCliStatus, OpenArtCliStatus, ReferenceImageGenOptions, CustomRef, CharacterSheetGenOptions, CharacterSheetView, CharacterSheetBuilder, LedgerView, ExpensePriceRule, Model3dGenOptions, MediaModelLadder } from "../shared/ipc.js";
import { applyOptionExposure } from "./providers/model-schema.js";

let win: BrowserWindow | null = null;
let mcp: McpManager;

/** Perf 1.3: memoized 480px board thumbnails. Keyed by
 *  productionId:shotId:framePath, validated by artworkPath:mtimeMs so a
 *  re-generated frame naturally misses. Bounded LRU (~1k entries of tens-of-KB
 *  base64) — repeat paints become string returns with no disk decode/resize. */
const BOARD_THUMB_CACHE_MAX = 1000;
const boardThumbCache = new Map<string, { key: string; dataUrl: string }>();
function boardThumbGet(cacheKey: string, fileKey: string): string | null {
  const hit = boardThumbCache.get(cacheKey);
  if (!hit || hit.key !== fileKey) return null;
  // LRU touch.
  boardThumbCache.delete(cacheKey);
  boardThumbCache.set(cacheKey, hit);
  return hit.dataUrl;
}
function boardThumbSet(cacheKey: string, fileKey: string, dataUrl: string): void {
  boardThumbCache.delete(cacheKey);
  boardThumbCache.set(cacheKey, { key: fileKey, dataUrl });
  while (boardThumbCache.size > BOARD_THUMB_CACHE_MAX) {
    const oldest = boardThumbCache.keys().next().value;
    if (oldest === undefined) break;
    boardThumbCache.delete(oldest);
  }
}
/** Resolve + validate a board frame request. Returns null for unknown shots
 *  or paths outside the shot's history (same guard as the single handler). */
function resolveBoardFrame(p: productions.ProductionFile, shotId: string, framePath?: string): { rel: string; abs: string } | null {
  const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
  if (!shot) return null;
  const rel = framePath ?? shot.artwork;
  if (!rel || (rel !== shot.artwork && !boardFrameHistory(shot).includes(rel))) return null;
  return { rel, abs: assetPath(p, rel) };
}
function renderBoardThumb(abs: string): string | null {
  try {
    const image = nativeImage.createFromPath(abs).resize({ width: 480 });
    return `data:image/jpeg;base64,${image.toJPEG(72).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Custom scheme for streaming production assets (voiceover, music) to the
 * renderer. Registered privileged + streaming so <audio> can range-request
 * and play multi-MB files without base64 / data-URL length limits — the
 * previous IPC data-URL approach silently failed for 90 s+ clips.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: "cascade-media",
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      bypassCSP: false,
    },
  },
]);

import { mediaMimeForPath, parseCascadeMediaRange, CSP_PROD, cspForEnv, serveMediaFile } from "./media-protocol.js";
import { loadRefThumbnail, setThumbCacheDir, regenerateRefThumbnails } from "./thumbnails.js";
import { validateExternalEditor, openWithExternalEditor } from "./external-editor.js";
export { mediaMimeForPath, parseCascadeMediaRange, CSP_PROD, cspForEnv, validateExternalEditor, openWithExternalEditor };

function installCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [cspForEnv(!!process.env.ELECTRON_RENDERER_URL)],
      },
    });
  });
}

/**
 * Serve `cascade-media://<productionId>/<urlencoded-relpath>` from disk by
 * streaming with Range support so <audio>/<video> can seek without buffering
 * whole multi-GB files in the main process. `assetPath` confines the path to
 * the production folder (realpath-verified). A `?thumb=1` query serves a
 * small compressed JPEG instead of the full file — the node graph's reference
 * tiles use it; zoom/lightbox URLs keep the original.
 */
function registerMediaProtocol(): void {
  protocol.handle("cascade-media", async (req) => {
    let abs: string;
    let thumb = false;
    try {
      const url = new URL(req.url);
      const p = productions.loadProduction(url.hostname);
      if (!p) return new Response("Unknown production", { status: 404 });
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      abs = assetPath(p, rel);
      thumb = url.searchParams.get("thumb") === "1";
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
    if (thumb) {
      const jpeg = await loadRefThumbnail(abs);
      if (jpeg) {
        return new Response(new Uint8Array(jpeg), {
          status: 200,
          headers: { "Content-Type": "image/jpeg", "Content-Length": String(jpeg.length), "Cache-Control": "no-store" },
        });
      }
    }
    return serveMediaFile(abs, req.headers.get("range"));
  });
}

/**
 * External-edit watch: the original (high-quality) file that was handed to
 * the editor, and the JPEG preview that must be re-encoded when the original
 * is edited externally. `mtimeMs/size` are captured at open time; on window
 * focus we compare and regenerate the JPEG when the file has changed.
 */
interface ExternalEditWatch {
  productionId: string;
  jpegRel: string;
  originalRel: string;
  jpegAbs: string;
  originalAbs: string;
  mtimeMs: number;
  size: number;
}
const externalEditWatches = new Map<string, ExternalEditWatch>();

function trackExternalEdit(p: Production, jpegRel: string, originalRel: string): void {
  try {
    const originalAbs = assetPath(p, originalRel);
    const jpegAbs = assetPath(p, jpegRel);
    const st = fs.statSync(originalAbs);
    externalEditWatches.set(originalAbs, {
      productionId: p.meta.id,
      jpegRel,
      originalRel,
      jpegAbs,
      originalAbs,
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
  } catch {}
}

async function checkExternalEdits(): Promise<void> {
  for (const [key, w] of externalEditWatches) {
    let st: fs.Stats;
    try {
      st = fs.statSync(w.originalAbs);
    } catch {
      continue;
    }
    if (st.mtimeMs > w.mtimeMs + 50 || st.size !== w.size) {
      const p = productions.loadProduction(w.productionId);
      if (!p) continue;
      const ok = regenerateBoardJpeg(p, w.originalRel, w.jpegRel);
      if (ok) {
        w.mtimeMs = st.mtimeMs;
        w.size = st.size;
        win?.webContents.send("board:externalUpdate", { productionId: w.productionId, jpegRel: w.jpegRel, originalRel: w.originalRel });
        win?.webContents.send("production:event", { id: w.productionId, message: `External edit applied — refreshed preview for ${w.jpegRel}`, level: "done" } satisfies ProductionEvent);
      }
    }
  }
}

/** Open a data-URL image in the external editor via a temp file. */
async function openDataUrlExternally(win: BrowserWindow, dataUrl: string): Promise<void> {
  const bytes = dataUrlToBytes(dataUrl);
  if (!bytes || !bytes.length) throw new Error("Couldn't decode that image.");
  const comma = dataUrl.indexOf(",");
  const mime = comma !== -1 ? dataUrl.slice(5, comma).split(";")[0] : "image/png";
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";
  const tmp = path.join(os.tmpdir(), `cascade-external-${Date.now()}.${ext}`);
  fs.writeFileSync(tmp, Buffer.from(bytes));
  await openWithExternalEditor(tmp);
}

/** Reveal a production asset (image or video) in the OS file manager, selecting
 *  it when the platform supports it. No-op when it isn't a real file. */
function revealProductionFile(target: { productionId?: string; relPath?: string; src?: string }): void {
  try {
    const file = resolveProductionFile(target);
    if (!file) return;
    const p = productions.loadProduction(file.productionId);
    if (!p) return;
    const abs = assetPath(p, file.relPath);
    if (fs.existsSync(abs)) shell.showItemInFolder(abs);
  } catch { /* not a resolvable/contained production file — nothing to reveal */ }
}

/** Open an image in the external editor. Accepts an explicit production file
 *  (`productionId`+`relPath`), an inline data URL, or a raw src URL (cascade-
 *  media / data: / http). Shared by every image context menu so "Edit
 *  externally" behaves identically no matter where the image lives. */
async function openImageExternally(win: BrowserWindow, target: { productionId?: string; relPath?: string; dataUrl?: string; src?: string }): Promise<void> {
  try {
    const file = resolveProductionFile(target);
    if (file) {
      const p = productions.loadProduction(file.productionId);
      if (!p) throw new Error("Production not found.");
      // Board frames: hand the original (high-quality) file to the editor, and
      // watch it so the JPEG preview is re-encoded when the user returns.
      const originalRel = originalForJpegRel(p, file.relPath);
      if (originalRel) {
        const originalAbs = assetPath(p, originalRel);
        if (fs.existsSync(originalAbs)) {
          trackExternalEdit(p, file.relPath, originalRel);
          await openWithExternalEditor(originalAbs);
          return;
        }
      }
      const abs = assetPath(p, file.relPath);
      if (!fs.existsSync(abs)) throw new Error(`Image not found on disk: ${file.relPath}`);
      await openWithExternalEditor(abs);
      return;
    }
    if (target.dataUrl) {
      await openDataUrlExternally(win, target.dataUrl);
      return;
    }
    const src = target.src ?? "";
    if (src.startsWith("data:image/")) {
      await openDataUrlExternally(win, src);
      return;
    }
    if (/^https?:\/\//.test(src)) {
      void shell.openExternal(src);
      return;
    }
    throw new Error("No image to open — provide a production file or a data URL.");
  } catch (err) {
    void dialog.showMessageBox(win, {
      type: "error",
      title: "Couldn't open in external editor",
      message: String(err).replace(/^Error:\s*/, ""),
    });
  }
}

/** Pop the right-click menu for an image or video: Save as… / Copy image /
 *  Edit externally / Open file folder. This is the single menu builder — the
 *  native `context-menu` event and the renderer-triggered `image:showMenu` IPC
 *  both funnel through it, so every media element in the app gets the same
 *  options with the same wording. `edit` pins the full-res target when the
 *  renderer knows it; "Open file folder" only appears for real production
 *  files (not inline data URLs or remote links). */
function popMediaContextMenu(win: BrowserWindow, opts: { media: "image" | "video"; src: string; x: number; y: number; edit?: { productionId: string; relPath: string } | { dataUrl: string } }): void {
  const src = opts.src;
  const isVideo = opts.media === "video";
  const canEditExternally = !isVideo && (!!opts.edit || src.startsWith("cascade-media://") || src.startsWith("data:image/") || /^https?:\/\//.test(src));
  const editorLabel = (() => {
    const ed = settings.getExternalEditor();
    if (!ed) return "Edit externally";
    const base = path.basename(ed).replace(/\.[^.]+$/, "");
    return `Edit in ${base}`;
  })();
  const fileTarget = opts.edit && "relPath" in opts.edit
    ? { productionId: opts.edit.productionId, relPath: opts.edit.relPath }
    : resolveProductionFile({ src });
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: isVideo ? "Save video as…" : "Save image as…",
      click: () => win.webContents.downloadURL(src), // triggers the native save dialog
    },
  ];
  if (!isVideo) {
    template.push({
      label: "Copy image",
      click: () => win.webContents.copyImageAt(opts.x, opts.y),
    });
  }
  if (canEditExternally) {
    template.push({
      label: editorLabel,
      click: () => {
        void openImageExternally(win, opts.edit ?? { src });
      },
    });
  }
  if (fileTarget) {
    template.push({ type: "separator" }, {
      label: "Open file folder",
      click: () => revealProductionFile(fileTarget),
    });
  }
  Menu.buildFromTemplate(template).popup();
}

/**
 * One live chat = one in-memory session + a lazy Agent. Keeping every open/
 * background chat here (instead of a single global agent) is what lets chats
 * stream in parallel and survive being switched away from.
 */
interface LiveChat {
  session: import("./sessions.js").SessionFile;
  agent: Agent | null;
  running: boolean;
  /** Bumped on stop/new-send so a superseded in-flight send can't clobber state. */
  sendToken: number;
}
const chats = new Map<string, LiveChat>();
/** The currently-focused chat id (what the transcript sidebar shows). */
let curId: string | null = null;

/** Ensure a session id has a live entry (loading it from disk if needed). */
function live(id: string): LiveChat {
  let e = chats.get(id);
  if (!e) {
    const loaded = sessions.loadSession(id) ?? sessions.newSessionFile(settings.getWorkspace());
    e = { session: loaded, agent: null, running: false, sendToken: 0 };
    chats.set(id, e);
  }
  return e;
}

function cur(): LiveChat | null {
  return curId ? chats.get(curId) ?? null : null;
}

function broadcastSessions(): void {
  win?.webContents.send("sessions:updated", sessions.listSessions());
}

/** Working folder for a given chat: pure chat wins, then per-session, then default. */
function workspaceFor(e: LiveChat | null): string | null {
  if (e?.session.pureChat) return null;
  return e?.session.workspace ?? settings.getWorkspace();
}

// ---- approval plumbing ----------------------------------------------------
let approvalSeq = 0;
const pendingApprovals = new Map<number, (d: ApprovalDecisionIpc) => void>();

function requestApprovalFromUser(req: { tool: string; summary: string; detail: string }) {
  return new Promise<ApprovalDecisionIpc>((resolve) => {
    const id = ++approvalSeq;
    pendingApprovals.set(id, resolve);
    win?.webContents.send("approval:request", { id, ...req });
    // Flash the taskbar icon so a background approval prompt gets noticed.
    if (win && !win.isFocused()) win.flashFrame(true);
  });
}

// ---- agent lifecycle ------------------------------------------------------
/** Working folder for the current chat: per-session first, default second. */
function effectiveWorkspace(): string | null {
  return workspaceFor(cur());
}

function isToolAllowed(name: string, allowed: "all" | string[]): boolean {
  if (allowed === "all") return true;
  if (allowed.includes(name)) return true;
  for (const pat of allowed) {
    if (pat.endsWith("__*")) {
      const prefix = pat.slice(0, -1); // keep "__"
      if (name.startsWith(prefix)) return true;
    }
    if (pat.endsWith("*") && !pat.includes("__")) {
      if (name.startsWith(pat.slice(0, -1))) return true;
    }
  }
  return false;
}

function filterTools(
  tools: Record<string, AgentTool>,
  allowed: "all" | string[]
): Record<string, AgentTool> {
  if (allowed === "all") return { ...tools };
  const out: Record<string, AgentTool> = {};
  for (const [k, v] of Object.entries(tools)) {
    if (isToolAllowed(k, allowed)) out[k] = v;
  }
  return out;
}

/** Create (lazily) the Agent that streams a specific chat, bound to its entry. */
function ensureAgent(entry: LiveChat): Agent {
  const apiKey = settings.getApiKey();
  if (!apiKey) throw new Error("NO_API_KEY");
  const workspace = workspaceFor(entry);
  if (!entry.agent) {
    // Pure chat: no folder selected → web-chat-like mode with no tools at all.
    if (!workspace) {
      const pureAgent = new Agent({
        apiKey,
        model: settings.getModel(),
        baseUrl: settings.getBaseUrl(),
        helperModel: settings.getHelperModel(),
        pureChat: true,
        requestApproval: (req) => requestApprovalFromUser(req),
        onEvent: (e) => {
          if (entry.agent === pureAgent) {
            win?.webContents.send("agent:event", { sessionId: entry.session.id, event: e as AgentEventIpc });
          }
        },
      });
      if (entry.session.history.length) pureAgent.loadHistory(entry.session.history);
      entry.agent = pureAgent;
      return pureAgent;
    }
    const agentId = (entry.session.agentId as string | null) ?? null;
    const agentMeta = agentId ? agents.getAgentMeta(agentId) : null;
    const agentPrompt = agentId ? agents.getAgentPrompt(agentId) : "";
    const agentModel = agentMeta?.model;
    const allowedTools: "all" | string[] = agentMeta?.allowedTools ?? "all";
    // If agent was deleted, quietly fall back to Default for this chat.
    if (agentId && !agentMeta) {
      entry.session.agentId = null;
      sessions.saveSession(entry.session);
    }

    const skillsDir = path.join(app.getPath("userData"), "skills");
    const skillsList = loadSkills(skillsDir);
    const openArtUpload = makeOpenArtUploadTool(win, mcp, (dataUrl, filename) => {
      entry.session.mentionImages = [...(entry.session.mentionImages ?? []), dataUrl];
      win?.webContents.send("mention:added", { sessionId: entry.session.id, dataUrl, filename });
    });
    const onDemandServers = new Set(settings.getMcpOnDemand());
    let extraTools: Record<string, AgentTool> = {};
    let lazyTools: Record<string, AgentTool> = {};
    const mcpTools = mcp.getTools();
    for (const [name, tool] of Object.entries(mcpTools)) {
      const server = name.includes("__") ? name.split("__")[0] : null;
      if (server && onDemandServers.has(server)) lazyTools[name] = tool;
      else extraTools[name] = tool;
    }
    lazyTools["openart_upload_reference"] = openArtUpload;
    if (skillsList.length) extraTools["read_skill"] = makeReadSkillTool(skillsDir);
    if (mcpTools["openart__openart_upload_pick"]) {
      lazyTools["openart__openart_upload_pick"] = openArtUpload;
    }
    // Apply per-agent allowlist
    if (allowedTools !== "all") {
      // also filter built-ins: TOOLS are injected inside Agent via config.extraTools? No,
      // Agent always includes TOOLS internally; filter via extraTools would miss them.
      // So we pass an explicit extraTools that includes filtered built-ins by
      // signaling via a synthetic "builtin" filter: the Agent's TOOLS will be
      // filtered by wrapping. Simplest: pass filtered built-ins as extraTools
      // and let Agent merge — but Agent's TOOLS are always present.
      // Instead, filter after construction by removing disallowed definitions.
      // For now, filter the MCP sets; built-in filtering is applied by pruning
      // the Agent's toolDefinitions post-construction (see below).
    }
    extraTools = filterTools(extraTools, allowedTools);
    lazyTools = filterTools(lazyTools, allowedTools);

    const lazyGroupNotes = [
      ...new Set(
        Object.keys(lazyTools)
          .filter((n) => n.includes("__"))
          .map((n) => n.split("__")[0])
      ),
    ].map((name) => ({ name, hint: "Activated only on request — ask by name to use this toolset." }));

    // Filter built-in tools if agent restricts them
    const builtinAllowed = (name: string) => isToolAllowed(name, allowedTools);

    const thisAgent = new Agent({
      apiKey,
      // An empty agent model means "follow the app default".
      model: agentModel || settings.getModel(),
      baseUrl: settings.getBaseUrl(),
      helperModel: settings.getHelperModel(),
      workspaceRoot: workspace,
      agentPrompt: agentPrompt || undefined,
      skills: skillsList,
      planMode: !!entry.session.planMode,
      extraTools,
      lazyTools,
      lazyGroupNotes,
      requestApproval: (req) => requestApprovalFromUser(req),
      onEvent: (e) => {
        if (entry.agent === thisAgent) {
          win?.webContents.send("agent:event", { sessionId: entry.session.id, event: e as AgentEventIpc });
        }
      },
    });
    // Prune built-in tool definitions if agent has a restricted allowlist
    if (allowedTools !== "all") {
      // @ts-ignore — reach into private for filtering (same process)
      const t = (thisAgent as unknown as { tools: Record<string, AgentTool>; toolDefinitions: import("@core").ToolDefinition[] });
      for (const k of Object.keys(t.tools)) {
        if (!builtinAllowed(k) && !extraTools[k] && !lazyTools[k]) {
          // This is a built-in that the agent didn't allow
          if (["read_file","write_file","edit_file","list_directory","glob","grep","run_command","read_skill"].includes(k)) {
            delete t.tools[k];
          }
        }
      }
      t.toolDefinitions = Object.values(t.tools).map((tool: AgentTool) => tool.definition);
    }
    entry.agent = thisAgent;
    if (entry.session.history.length) entry.agent.loadHistory(entry.session.history);
  }
  return entry.agent;
}

/** Drop every live agent (settings/workspace/model changed); histories live in session files. */
function resetAllAgents() {
  for (const e of chats.values()) {
    e.agent?.stop();
    e.agent = null;
  }
}

/** Provider-aware prompt for a missing API key (label comes from the registry). */
function apiKeyRequired(): string {
  return `Add your ${getProvider(settings.getProviderId())?.label ?? "LLM provider"} API key in Settings first.`;
}

/** Resolve any pending approval modals as denied so an abandoned agent can't act. */
function rejectPendingApprovals() {
  for (const resolve of pendingApprovals.values()) resolve("deny" as ApprovalDecisionIpc);
  pendingApprovals.clear();
  win?.flashFrame(false);
}

/**
 * Ask the cheap model to name a conversation from its history, then persist
 * and broadcast it. `force` controls whether an already-named chat is
 * overwritten: auto-naming (force=false) only names chats that are still
 * "New chat", while the explicit right-click refresh (force=true) re-derives
 * the name unconditionally. Returns the new title, or null if nothing changed.
 */
async function applyChatTitle(history: ChatMessage[], targetId: string, force: boolean): Promise<string | null> {
  const apiKey = settings.getApiKey();
  if (!apiKey) return null;
  const client = new ChatClient(apiKey, settings.getBaseUrl());
  const title = await suggestChatTitle(history, client, settings.getHelperModel());
  if (title === "New chat") return null;
  const entry = chats.get(targetId) ?? null;
  const loaded = entry ? entry.session : sessions.loadSession(targetId);
  if (!loaded) return null;
  if (!force && loaded.title !== "New chat") return loaded.title; // auto-name: don't clobber a real name
  loaded.title = title;
  if (entry) sessions.saveSession(entry.session);
  else sessions.saveSession(loaded);
  win?.webContents.send("session:renamed", { id: targetId, title });
  return title;
}

/** Fire-and-forget auto-name right after a chat's first request. */
function autoNameSession(entry: LiveChat): Promise<string | null> {
  return applyChatTitle(entry.session.history, entry.session.id, false);
}

// ---- IPC ------------------------------------------------------------------
function registerIpc() {
  // Every successful generation feeds the expenses ledger, which prices it
  // against the user's rules and keeps the CSV tally in sync.
  // The `higgsfield` CLI binary (Higgsfield CLI transport): an explicit
  // Settings path wins; otherwise the PATH probe below (resolved once at
  // startup — a local `where`/`which`, no network). Lazy so a Settings path
  // change applies without rebuilding providers.
  let higgsCliPathCache: string | null | undefined;
  void resolveHiggsfieldCliBinary().then((p) => { higgsCliPathCache = p; }).catch(() => { higgsCliPathCache = null; });
  const higgsCliBinary = (): string | null => settings.getHiggsfieldCliBinary() ?? higgsCliPathCache ?? null;
  let openArtCliPathCache: string | null | undefined;
  void resolveOpenArtCliBinary().then((p) => { openArtCliPathCache = p; }).catch(() => { openArtCliPathCache = null; });
  const openArtCliBinary = (): string | null => settings.getOpenArtCliBinary() ?? openArtCliPathCache ?? null;
  const providers = createProviders(mcp, { onGeneration: (meta) => ledger.recordGeneration(meta, settings.getHiggsfieldCreditUsd()) }, higgsCliBinary, openArtCliBinary);
  // The active media vendor (OpenArt/Higgsfield/Higgsfield CLI) — a global setting resolved
  // per call, so every generation flow follows a Settings change immediately.
  const media = (): MediaProvider => providers[resolveProviderId(settings.getMediaProvider())];
  // Per-model routing: an explicit `higgsfield:…` pick rides Higgsfield even
  // when the global is OpenArt (and vice versa via the active fallback), so a
  // saved cross-vendor pick can't silently fall back to the active vendor's
  // first model. "auto"/empty defers to the global.
  const mediaFor = (model?: string): MediaProvider =>
    mediaForModel(providers, resolveProviderId(settings.getMediaProvider()), model);

  // 3D AI Studio REST integration (design-page model generator). The API key
  // is read from encrypted settings on demand; the client's HTTP surface is
  // testable in isolation (modelgen.ts).
  const modelgen = new ModelGenClient(() => settings.get3daiApiKey());

  // IPC channels are declared in the shared contract (shared/ipc.ts), which the
  // preload adapter also consumes — so adding a channel means editing one map,
  // not three files. These wrappers enforce the contract on the main side: an
  // undeclared channel (or a declared channel with no handler) fails loudly
  // instead of silently breaking the renderer.
  const ipcHandlers = new Set<string>();
  function handle(channel: string, listener: (event: import("electron").IpcMainInvokeEvent, ...args: any[]) => unknown): void {
    if (!(channel in ipcContract)) throw new Error(`Undeclared IPC channel "${channel}" — add it to ipcContract in shared/ipc.ts`);
    ipcHandlers.add(channel);
    ipcMain.handle(channel, async (event, ...args) => { // security-allow: sole registration point — sender + schema checked above
      if (!isTrustedSender(event)) throw new Error(`IPC ${channel}: untrusted sender`);
      validateIpcArgs(channel, args);
      return await listener(event, ...args);
    });
  }
  function on(channel: string, listener: (event: import("electron").IpcMainEvent, ...args: any[]) => void): void {
    if (!(channel in ipcContract)) throw new Error(`Undeclared IPC channel "${channel}" — add it to ipcContract in shared/ipc.ts`);
    ipcHandlers.add(channel);
    ipcMain.on(channel, (event, ...args) => {
      if (!isTrustedSender(event)) return;
      try {
        validateIpcArgs(channel, args);
      } catch {
        return;
      }
      listener(event, ...args);
    });
  }

  handle("chat:send", async (_e, sessionId: string, text: string, attachments?: ChatAttachment[]) => {
    const entry = live(sessionId);
    curId = sessionId;
    if (entry.running) throw new Error("BUSY");
    entry.running = true;
    const token = ++entry.sendToken;
    try {
      // Write the chat to disk the moment a question is asked (not only once
      // the response finishes) so it shows up in the sidebar immediately.
      sessions.saveSession(entry.session);
      broadcastSessions();
      const a = ensureAgent(entry);
      await a.send(text, attachments);
      if (token !== entry.sendToken) return; // superseded by Stop — don't clobber newer state
      entry.session.history = a.getHistory();
      if (entry.session.title === "New chat") {
        // Auto-name the chat from its first request using the cheap model.
        // Fire-and-forget: never block the send or fail the message on a bad call.
        void autoNameSession(entry);
      }
      sessions.saveSession(entry.session);
      broadcastSessions();
    } finally {
      if (token === entry.sendToken) entry.running = false;
    }
  });

  on("chat:stop", (_e, sessionId: string) => {
    const entry = chats.get(sessionId);
    if (!entry) return;
    entry.agent?.stop(); // abort the in-flight request for THIS chat
    entry.agent = null; // next prompt in this chat starts a clean loop
    rejectPendingApprovals(); // don't let an abandoned agent act on a pending modal
    entry.sendToken++; // invalidate the in-flight handler so it can't overwrite newer state
    entry.running = false; // unblock THIS chat's composer immediately
    // Clear the streaming cursor in that chat's transcript.
    win?.webContents.send("agent:event", {
      sessionId,
      event: { type: "error", message: "Stopped by user." },
    });
  });

  // Turn plan mode on/off for a chat. Persists per session and rebuilds that
  // chat's agent so the gate + system-prompt directive take effect immediately.
  handle("chat:setPlanMode", (_e, sessionId: string, on: boolean) => {
    const entry = chats.get(sessionId);
    if (!entry) return;
    entry.session.planMode = !!on;
    sessions.saveSession(entry.session);
    entry.agent?.stop();
    entry.agent = null; // rebuild with the new plan-mode flag next message
    win?.webContents.send("agent:event", {
      sessionId,
      event: {
        type: "notice",
        text: entry.session.planMode
          ? "Plan mode ON — Cascade will research and write a plan first; file edits and commands are gated until you approve it."
          : "Plan mode OFF.",
      },
    });
  });

  handle("chat:getPlanMode", (_e, sessionId: string) => {
    return chats.get(sessionId)?.session.planMode ?? false;
  });

  // Undo the file changes made by a chat's most recent agent turn.
  handle("chat:undo", (_e, sessionId: string) => {
    const entry = chats.get(sessionId);
    if (!entry || !entry.agent) return { restored: 0, files: [] };
    const workspace = workspaceFor(entry);
    const outcome = entry.agent.undoLastTurn();
    const rel = (p: string) => (workspace ? path.relative(workspace, p) : p);
    return { restored: outcome.restored, files: outcome.files.map(rel) };
  });

  on("approval:response", (_e, id: number, decision: ApprovalDecisionIpc) => {
    pendingApprovals.get(id)?.(decision);
    pendingApprovals.delete(id);
    if (pendingApprovals.size === 0) win?.flashFrame(false); // nothing left awaiting input
  });

  on("display:sync", (_e, sessionId: string, display: DisplayItem[]) => {
    // Renderer owns display items; mirror them into that chat's session file.
    const entry = chats.get(sessionId);
    if (!entry) return;
    entry.session.display = display;
    sessions.saveSession(entry.session);
  });

  // Default folder for new chats (Settings).
  handle("workspace:pick", async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    if (res.canceled || !res.filePaths[0]) return null;
    settings.setWorkspace(res.filePaths[0]);
    settings.addRecentWorkspace(res.filePaths[0]);
    resetAllAgents();
    return res.filePaths[0];
  });

  // Working folder for the CURRENT chat (header chip).
  handle("workspace:pickSession", async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    if (res.canceled || !res.filePaths[0]) return null;
    const entry = cur();
    const dir = res.filePaths[0];
    if (entry) {
      entry.session.workspace = dir;
      entry.session.pureChat = false;
    }
    settings.addRecentWorkspace(dir);
    if (entry?.session.history.length) sessions.saveSession(entry.session);
    if (!settings.getWorkspace()) settings.setWorkspace(dir); // first folder becomes the default
    if (entry) {
      entry.agent?.stop();
      entry.agent = null; // workspace changed → rebuild this chat's agent
    }
    return dir;
  });

  // Set the current chat's folder to a recent one without opening a dialog.
  handle("workspace:setSession", (_e, dir: string) => {
    if (typeof dir !== "string" || !dir) return;
    const entry = cur();
    if (entry) {
      entry.session.workspace = dir;
      entry.session.pureChat = false;
    }
    settings.addRecentWorkspace(dir);
    if (entry?.session.history.length) sessions.saveSession(entry.session);
    if (!settings.getWorkspace()) settings.setWorkspace(dir);
    if (entry) {
      entry.agent?.stop();
      entry.agent = null;
    }
  });

  // Switch the current chat to pure-chat mode (no folder, no tools).
  handle("workspace:setSessionNone", () => {
    const entry = cur();
    if (!entry) return;
    entry.session.workspace = null;
    entry.session.pureChat = true;
    entry.session.agentId = null; // agents require a workspace — drop the binding
    sessions.saveSession(entry.session);
    entry.agent?.stop();
    entry.agent = null; // rebuild as a pure-chat agent next message
  });

  // Clear the default folder for new chats (Settings → None).
  handle("settings:clearWorkspace", () => {
    settings.setWorkspace(null);
    resetAllAgents();
  });

  // Recent folders for the header dropdown.
  handle("workspace:recent", () => settings.getRecentWorkspaces());

  handle("workspace:current", () => effectiveWorkspace());

  handle("settings:get", () => ({
    provider: settings.getProviderId(),
    hasApiKey: settings.hasApiKey(),
    model: settings.getModel(),
    workspace: settings.getWorkspace(),
    accent: settings.getAccent(),
    externalEditor: settings.getExternalEditor(),
    has3daiApiKey: settings.has3daiApiKey(),
  }));

  handle("settings:setApiKey", (_e, key: string) => {
    settings.setApiKey(key.trim());
    resetAllAgents();
  });

  handle("settings:set3daiApiKey", (_e, key: string) => {
    if (typeof key !== "string") return;
    settings.set3daiApiKey(key.trim());
  });

  handle("settings:getHiddenMediaModels", () => settings.getHiddenMediaModels());

  handle("settings:setHiddenMediaModels", (_e, ids: string[]) => {
    settings.setHiddenMediaModels(Array.isArray(ids) ? ids.map(String) : []);
  });

  handle("settings:getModelKindOverrides", () => settings.getModelKindOverrides());

  handle("settings:setModelKindOverrides", (_e, overrides: Record<string, "image" | "video">) => {
    settings.setModelKindOverrides(overrides ?? {});
  });

  // The generation dropdowns' remembered last choices (context → model +
  // settings). Each dropdown seeds from its context and writes back on change.
  handle("settings:getMediaDefaults", () => settings.getMediaDefaults());

  handle("settings:setMediaDefault", (_e, ctx: string, patch: Record<string, unknown>) => {
    settings.setMediaDefault(ctx, patch ?? {});
  });

  handle("settings:getMediaModelOrder", () => settings.getMediaModelOrder());

  handle("settings:setMediaModelOrder", (_e, ids: string[]) => {
    settings.setMediaModelOrder(Array.isArray(ids) ? ids.map(String) : []);
  });

  // Dev Model Customizer: per-parameter placement (modelId::flag → placement).
  handle("modelCustomizer:getExposure", () => settings.getModelOptionExposure());

  handle("modelCustomizer:setExposure", (_e, key: string, placement: ModelParamExposure | null) => {
    settings.setModelOptionExposure(String(key ?? ""), placement ?? null);
  });

  handle("modelCustomizer:resetExposure", () => {
    settings.resetModelOptionExposure();
  });

  handle("modelCustomizer:getSurfaces", () => settings.getModelSurfaces());

  handle("modelCustomizer:setSurfaces", (_e, surfaces: Record<string, string[]>) => {
    settings.setModelSurfaces(surfaces ?? {});
  });

  handle("modelCustomizer:resetSurfaces", () => {
    settings.resetModelSurfaces();
  });

  // Dev Model Customizer: per-surface parameter defaults
  // (`<modelId>::<surface>::<flag>` → value).
  handle("modelCustomizer:getParamDefaults", () => settings.getModelParamDefaults());

  handle("modelCustomizer:setParamDefault", (_e, key: string, value: ModelParamDefaultValue | null) => {
    settings.setModelParamDefault(String(key ?? ""), value ?? null);
  });

  handle("modelCustomizer:resetParamDefaults", () => {
    settings.resetModelParamDefaults();
  });

  handle("settings:getDevMode", () => settings.getDevMode());

  handle("settings:setDevMode", (_e, v: boolean) => {
    settings.setDevMode(v === true);
  });

  handle("settings:getSubmissionDryRun", () => settings.getSubmissionDryRun());

  handle("settings:setSubmissionDryRun", (_e, v: boolean) => {
    settings.setSubmissionDryRun(v === true);
  });

  handle("settings:openSubmissionLog", () => {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "submissions.md");
    if (!fs.existsSync(file)) fs.writeFileSync(file, "# Cascade submissions\n", "utf8");
    void shell.openPath(file);
  });

  handle("settings:setModel", (_e, model: string) => {
    settings.setModel(model);
    resetAllAgents();
  });

  handle("settings:setProvider", (_e, id: string) => {
    settings.setProvider(id);
    resetAllAgents();
  });

  handle("settings:setAccent", (_e, color: string) => {
    if (typeof color === "string") settings.setAccent(color);
  });

  handle("settings:pickExternalEditor", async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: "Choose external image editor",
      properties: ["openFile"],
      filters: [
        { name: "Executables", extensions: ["exe", "app", "*"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const validated = await validateExternalEditor(res.filePaths[0]);
    settings.setExternalEditor(validated);
    return validated;
  });

  handle("settings:setExternalEditor", async (_e, p: string | null) => {
    if (p === null || (typeof p === "string" && p.trim() === "")) {
      settings.setExternalEditor(null);
      return { ok: true };
    }
    if (typeof p !== "string") throw new Error("Invalid external editor value.");
    const validated = await validateExternalEditor(p.trim());
    settings.setExternalEditor(validated);
    return { ok: true, path: validated };
  });

  handle("image:showMenu", (_e, opts: { src?: string; x?: number; y?: number; media?: "image" | "video"; productionId?: string; relPath?: string; dataUrl?: string }) => {
    if (!win || typeof opts?.src !== "string" || !opts.src) return;
    const edit = opts.productionId && opts.relPath
      ? { productionId: String(opts.productionId), relPath: String(opts.relPath) }
      : opts.dataUrl
        ? { dataUrl: String(opts.dataUrl) }
        : undefined;
    popMediaContextMenu(win, { media: opts.media === "video" ? "video" : "image", src: opts.src, x: Number(opts.x) || 0, y: Number(opts.y) || 0, edit });
  });

  // Direct image actions for the storyboard panel's single custom menu (same
  // behaviors as the native menu items, without popping a second menu).
  handle("image:save", (_e, src: string) => {
    if (!win || typeof src !== "string" || !src) return;
    win.webContents.downloadURL(src);
  });

  handle("image:copy", (_e, x: number, y: number) => {
    if (!win) return;
    win.webContents.copyImageAt(Number(x) || 0, Number(y) || 0);
  });

  handle("image:editExternally", (_e, opts: { src?: string; productionId?: string; relPath?: string; dataUrl?: string }) => {
    if (!win) return;
    void openImageExternally(win, {
      src: typeof opts?.src === "string" ? opts.src : undefined,
      productionId: typeof opts?.productionId === "string" ? opts.productionId : undefined,
      relPath: typeof opts?.relPath === "string" ? opts.relPath : undefined,
      dataUrl: typeof opts?.dataUrl === "string" ? opts.dataUrl : undefined,
    });
  });

  handle("image:showInFolder", (_e, opts: { productionId?: string; relPath?: string; src?: string }) => {
    revealProductionFile({
      productionId: typeof opts?.productionId === "string" ? opts.productionId : undefined,
      relPath: typeof opts?.relPath === "string" ? opts.relPath : undefined,
      src: typeof opts?.src === "string" ? opts.src : undefined,
    });
  });

  handle("models:list", async (): Promise<import("../shared/ipc.js").ModelListResult> => {
    const apiKey = settings.getApiKey();
    if (!apiKey) return { ok: false, error: "No API key saved for this provider." };
    try {
      const res = await fetch(`${settings.getBaseUrl()}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, error: `Non-JSON response from ${settings.getBaseUrl()}/models: ${text.slice(0, 200)}` };
      }
      const models = normalizeModelList(extractModelList(json));
      if (models.length === 0) {
        // An unrecognized /models shape silently hiding models is worse than
        // showing the raw reply so the schema can be fixed.
        return { ok: false, error: `No usable models in response: ${JSON.stringify(json).slice(0, 200)}` };
      }
      // Remember the cheapest usable model as this provider's background
      // model (compaction, chat titles). When no pricing is advertised
      // (baseCost unknown across the list), the first listed model serves.
      const ranked = [...models].sort((a, b) => a.baseCost - b.baseCost || a.id.localeCompare(b.id));
      settings.setHelperModel(ranked[0].id);
      return { ok: true, models };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  handle("credits:get", async () => {
    const apiKey = settings.getApiKey();
    // Only providers that declare a balance endpoint get a request — the
    // shape (path + field + unit) is provider data in shared/providers.ts.
    const provider = getProvider(settings.getProviderId());
    if (!apiKey || !provider?.balance) return null;
    try {
      const amount = await new ChatClient(apiKey, settings.getBaseUrl()).balance(provider.balance);
      return amount === null ? null : { amount, unit: provider.balance.unit };
    } catch (e) {
      // The footer hides the line on failure, so leave a breadcrumb for the
      // operator — a rejected/scope-limited key otherwise looks like "no balance".
      const hint = provider.balance.errorHint ? ` (${provider.balance.errorHint})` : "";
      console.warn(`[credits] ${provider.id} balance fetch failed: ${String(e)}${hint}`);
      return null;
    }
  });

  handle("sessions:list", () => sessions.listSessions());

  handle("sessions:load", (_e, id: string) => {
    const entry = live(id);
    curId = id;
    const s = entry.session;
    if (!Array.isArray(s.mentionImages)) s.mentionImages = [];
    // Older sessions saved mention images only in `mentionImages` (not in the
    // display list). Rehydrate any that are missing into the transcript.
    const display = s.display ?? [];
    for (const dataUrl of s.mentionImages) {
      const alreadyShown = display.some((it) => it.kind === "mention" && it.image === dataUrl);
      if (!alreadyShown) {
        display.push({
          kind: "mention",
          filename: "OpenArt reference",
          image: dataUrl,
        });
      }
    }
    s.display = display;
    return display;
  });

  // Renderer focus changed to another chat — keep main's active-chat pointer
  // in sync without reloading from disk (the transcript stays in memory).
  on("sessions:activate", (_e, id: string) => {
    if (typeof id === "string" && id) curId = id;
  });

  handle("sessions:new", () => {
    const s = sessions.newSessionFile(settings.getWorkspace());
    sessions.saveSession(s); // persist so it's visible in the sidebar immediately
    const entry: LiveChat = { session: s, agent: null, running: false, sendToken: 0 };
    chats.set(s.id, entry);
    curId = s.id;
    return s.id;
  });

  handle("sessions:current", () => curId);

  handle("sessions:remove", (_e, id: string, mode: "delete" | "archive") => {
    chats.delete(id);
    const ok = mode === "archive" ? sessions.archiveSession(id) : sessions.deleteSession(id);
    // If the removed chat was the one open, start a fresh one so the live
    // session object doesn't point at a deleted/dead file.
    if (ok && id === curId) {
      const s = sessions.newSessionFile(settings.getWorkspace());
      chats.set(s.id, { session: s, agent: null, running: false, sendToken: 0 });
      curId = s.id;
    }
    return ok;
  });

  // Re-derive a chat's name from its full (condensed) context using Arya.
  handle("sessions:rename", async (_e, id: string) => {
    if (typeof id !== "string" || !id) return null;
    const loaded = sessions.loadSession(id);
    if (!loaded) return null;
    return applyChatTitle(loaded.history ?? [], id, true);
  });

  // ---- skills ----
  handle("skills:list", () => loadSkills(path.join(app.getPath("userData"), "skills")));

  handle("skills:openFolder", () => {
    const dir = path.join(app.getPath("userData"), "skills");
    ensureSkillsDir(dir);
    void shell.openPath(dir);
    resetAllAgents(); // reload skill list next message (cheap; also picks up edits)
  });

  // ---- reference thumbnails ----
  // Pre-generate the compressed node-graph thumbnails for every production's
  // reference images (Settings → Regenerate thumbnail cache), so older/larger
  // projects don't pay the first-open decode cost. Idempotent + prunes stale
  // entries whose source file is gone.
  handle("settings:regenerateThumbnails", async () => {
    const paths: string[] = [];
    const projects = new Set<string>();
    for (const meta of productions.listProductions()) {
      const p = productions.loadProduction(meta.id);
      if (!p) continue;
      projects.add(p.meta.id);
      paths.push(...productions.referenceImagePaths(p));
    }
    const counts = await regenerateRefThumbnails(paths);
    return { ...counts, projects: projects.size };
  });

  // ---- per-directory instructions (CASCADE.md) ----
  handle("workspace:instructions", () => {
    const ws = effectiveWorkspace();
    if (!ws) return { workspace: null, active: false, file: null };
    const active = loadWorkspaceInstructions(ws).length > 0;
    const file = workspaceInstructionsFile(ws);
    return { workspace: ws, active, file: file ?? ws };
  });

  handle("workspace:openInstructions", () => {
    const ws = effectiveWorkspace();
    if (!ws) return;
    const file = workspaceInstructionsFile(ws);
    void shell.openPath(file ?? ws); // open the file, or reveal the folder so the user can add one
    resetAllAgents(); // pick up any edited/added instructions on the next message
  });

  // ---- MCP ----
  handle("mcp:getConfig", () => mcp.readConfigText());

  handle("mcp:setConfig", async (_e, text: string) => {
    mcp.writeConfigText(text); // throws on invalid JSON; surfaces to renderer
    const statuses = await mcp.reload();
    resetAllAgents(); // next agent picks up the new tool set
    return statuses;
  });

  handle("mcp:status", () => mcp.getStatuses());

  handle("mcp:reload", async () => {
    const statuses = await mcp.reload();
    resetAllAgents();
    return statuses;
  });

  handle("mcp:onDemand", () => settings.getMcpOnDemand());

  handle("mcp:setOnDemand", (_e, names: string[]) => {
    settings.setMcpOnDemand(Array.isArray(names) ? names : []);
    resetAllAgents();
  });

  handle("media:listProviders", () =>
    PROVIDER_IDS.map((id) => ({ id, displayName: PROVIDER_META[id].displayName, available: providers[id].isAvailable() }))
  );

  handle("media:getProvider", (): MediaProviderId => resolveProviderId(settings.getMediaProvider()));

  handle("media:setProvider", (_e, id: MediaProviderId) => {
    settings.setMediaProvider(id);
  });

  // Top-bar dial: every vendor's balance at once (each isolated — one vendor
  // down or unconnected resolves to null without blanking the others).
  handle("media:getCredits", async (): Promise<Record<MediaProviderId, number | null>> =>
    getMediaCredits(providers)
  );

  // Higgsfield CLI transport config: custom binary path + read-only status
  // (resolved binary, version, auth). The status probe is read-only and
  // never spends credits.
  handle("media:getHiggsCliBinary", async (): Promise<string | null> => settings.getHiggsfieldCliBinary());
  handle("media:setHiggsCliBinary", (_e, p: string | null) => {
    settings.setHiggsfieldCliBinary(typeof p === "string" ? p : null);
  });
  handle("media:getHiggsCliStatus", async (): Promise<HiggsfieldCliStatus> =>
    getHiggsfieldCliStatus(higgsCliBinary())
  );

  // OpenArt CLI transport config: custom binary path + read-only status.
  handle("media:getOpenArtCliBinary", async (): Promise<string | null> => settings.getOpenArtCliBinary());
  handle("media:setOpenArtCliBinary", (_e, p: string | null) => {
    settings.setOpenArtCliBinary(typeof p === "string" ? p : null);
  });
  handle("media:getOpenArtCliStatus", async (): Promise<OpenArtCliStatus> =>
    getOpenArtCliStatus(openArtCliBinary())
  );

  // ---- agents ----
  handle("agents:list", () => agents.listAgents());
  handle("agents:get", (_e, id: string) => {
    const r = agents.getAgent(id);
    if (!r) return null;
    const avatarDataUrl = r.meta.avatar?.kind === "image" ? agents.getAvatarDataUrl(id, r.meta.avatar) : null;
    return { meta: r.meta, prompt: r.prompt, avatarDataUrl };
  });
  handle("agents:create", (_e, data: { name: string; description?: string; avatar?: unknown; model?: string; allowedTools?: "all" | string[]; prompt?: string }) => {
    const id = agents.createAgent(data as never);
    return id;
  });
  handle("agents:update", (_e, id: string, patch: Record<string, unknown>) => {
    agents.updateAgent(id, patch as never);
  });
  handle("agents:uploadAvatar", async (_e, id: string, dataUrl: string) => {
    const filename = agents.saveAgentAvatar(id, dataUrl);
    agents.updateAgent(id, { avatar: { kind: "image", path: filename } } as never);
    return filename;
  });
  handle("agents:duplicate", (_e, id: string) => agents.duplicateAgent(id));
  handle("agents:remove", (_e, id: string, mode: "delete" | "archive") => {
    const ok = mode === "archive" ? agents.archiveAgent(id) : agents.deleteAgent(id);
    if (ok) {
      // chats bound to this agent revert to Default
      for (const e of chats.values()) {
        if (e.session.agentId === id) {
          e.session.agentId = null;
          sessions.saveSession(e.session);
          e.agent?.stop();
          e.agent = null;
        }
      }
    }
    return ok;
  });
  handle("agents:export", (_e, id: string) => {
    const r = agents.getAgent(id);
    if (!r) return null;
    return { json: JSON.stringify(r.meta, null, 2), md: r.prompt };
  });
  handle("agents:import", (_e, json: string, md: string) => agents.importAgent(json, md));

  // ---- productions (Production Assistant) ----
  /** Stream a log line to the Production UI. */
  const productionEmit = (id: string, message: string, level: ProductionEvent["level"] = "info") => {
    win?.webContents.send("production:event", { id, message, level } satisfies ProductionEvent);
  };

  handle("production:list", () => productions.listProductions());

  handle("production:pickFolder", async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
  });

  handle("production:create", (_e, name: string, folder: string) => {
    if (typeof folder !== "string" || !folder || typeof name !== "string") throw new Error("BAD_ARGS");
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch {
      throw new Error(`Can't create or open that folder: ${folder}`);
    }
    // `folder` is the parent the user picked; newProduction creates a
    // subfolder named after the production inside it.
    const p = productions.newProduction(name, folder);
    settings.addRecentProduction(p.meta.folder);
    return p;
  });

  handle("production:import", (_e, folder: string) => {
    if (typeof folder !== "string" || !folder) throw new Error("BAD_ARGS");
    try {
      fs.statSync(folder);
    } catch {
      throw new Error(`That folder doesn't exist: ${folder}`);
    }
    // The picked folder IS the production folder (no subfolder is created —
    // its boards/, script.md, … are adopted as-is).
    const p = productions.importProduction(folder);
    settings.addRecentProduction(p.meta.folder);
    return p;
  });

  handle("production:load", (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (p) settings.addRecentProduction(p.meta.folder);
    return p;
  });

  handle("production:save", (_e, p: Production) => {
    // Persist renderer-owned state (edited shots, step focus, style…). The id
    // must exist already; new productions go through production:create. The
    // field-whitelist merge lives in the productions module (applyRendererState)
    // so the document's shape rules stay in one place, next to normalize.
    const existing = productions.loadProduction(p?.meta?.id);
    if (!existing) throw new Error("Production not found — it may have been deleted.");
    const next = productions.applyRendererState(existing, p);
    productions.saveProduction(next);
    // Keep script.md in sync (renames and renderer-side edits land here too).
    if (next.scenes.some((s) => s.shots.length)) {
      try {
        fs.writeFileSync(assetPath(next, next.assets.scriptMd), scriptMarkdown(next.meta.name, next.scenes), "utf8");
      } catch {
        /* non-fatal */
      }
    }
    return next;
  });

  handle("production:remove", (_e, id: string, mode: "delete" | "archive") => {
    const ok = mode === "archive" ? productions.archiveProduction(id) : productions.deleteProduction(id);
    // The production's expense ledger is per-project; follow the same lifecycle.
    if (ok) {
      if (mode === "archive") ledger.archiveProject(id);
      else ledger.removeProject(id);
    }
    return ok;
  });

  handle("production:pickScriptFile", async () => {
    const res = await dialog.showOpenDialog(win!, {
      properties: ["openFile"],
      filters: [
        { name: "Scripts", extensions: ["pdf", "docx", "doc", "txt", "md", "markdown", "fountain"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
  });

  handle("production:pickReferenceImage", async () => {
    const res = await dialog.showOpenDialog(win!, {
      properties: ["openFile"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    const file = res.canceled ? null : res.filePaths[0];
    if (!file) return null;
    try {
      const buf = fs.readFileSync(file);
      if (buf.length > 15 * 1024 * 1024) throw new Error("Image is larger than 15 MB.");
      const ext = path.extname(file).slice(1).toLowerCase().replace("jpg", "jpeg") || "png";
      return `data:image/${ext};base64,${buf.toString("base64")}`;
    } catch (e) {
      throw new Error(`Couldn't read that image: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  handle("production:ingest", async (_e, id: string, source: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (typeof source !== "string" || !source.trim()) throw new Error("Pick a script file or paste a Google Docs link first.");
    const apiKey = settings.getApiKey();
    if (!apiKey) throw new Error(apiKeyRequired());
    p.status[1] = "running";
    productions.saveProduction(p);
    productionEmit(id, `Step 1 started: ${source}`);
    try {
      await ingestScript(p, source, apiKey, settings.getModel(), (m, level) => productionEmit(id, m, level), settings.getBaseUrl());
      p.status[1] = "done";
    } catch (e) {
      p.status[1] = "error";
      productionEmit(id, friendlyApiError(e), "error");
      productions.saveProduction(p); // persist the error status
      throw new Error(friendlyApiError(e));
    }
    productions.saveProduction(p);
    return p;
  });

  // Step 2 magic wand: refine the style notes via one bounded LLM call.
  // Returns the refined string; the renderer keeps it in the draft until the
  // user saves (same flow as typing it by hand).
  handle("production:refineStyle", async (_e, id: string, style: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (typeof style !== "string" || !style.trim()) throw new Error("Write some style notes first, then refine them.");
    const apiKey = settings.getApiKey();
    if (!apiKey) throw new Error(apiKeyRequired());
    productionEmit(id, "Refining the master style prompt…");
    try {
      // A short excerpt of the first scene's visuals gives tone context.
      const excerpt = (p.scenes[0]?.shots ?? []).slice(0, 5).map((s) => s.visual).join(" ").slice(0, 800);
      const refined = await refineStylePrompt(style.trim(), excerpt, apiKey, settings.getModel(), settings.getBaseUrl());
      productionEmit(id, "Style prompt refined.", "done");
      return refined;
    } catch (e) {
      const msg = friendlyApiError(e);
      productionEmit(id, msg, "error");
      throw new Error(msg);
    }
  });

  // Step 2 character builder: refine the character description via one LLM
  // call. Returns the refined text; the renderer keeps it in the description
  // box until the user generates (same flow as typing it by hand).
  handle("production:refineCharacterDescription", async (_e, id: string, description: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (typeof description !== "string" || !description.trim()) throw new Error("Describe the character first, then refine it.");
    const apiKey = settings.getApiKey();
    if (!apiKey) throw new Error(apiKeyRequired());
    productionEmit(id, "Refining the character description…");
    try {
      const excerpt = (p.scenes[0]?.shots ?? []).slice(0, 5).map((s) => s.visual).join(" ").slice(0, 800);
      const refined = await refineCharacterDescription(description.trim(), excerpt, apiKey, settings.getModel(), settings.getBaseUrl());
      productionEmit(id, "Character description refined.", "done");
      return refined;
    } catch (e) {
      const msg = friendlyApiError(e);
      productionEmit(id, msg, "error");
      throw new Error(msg);
    }
  });

  // Step 2: fan rough style notes out into up to 5 distinct named styles.
  // Returns the list; the renderer numbers, ids, and persists them as the
  // production's `styles` set (which drives the Step 3 style dropdown).
  handle("production:generateStyles", async (_e, id: string, notes: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (typeof notes !== "string" || !notes.trim()) throw new Error("Write some style notes first, then generate styles.");
    const apiKey = settings.getApiKey();
    if (!apiKey) throw new Error(apiKeyRequired());
    productionEmit(id, "Generating up to 5 named visual styles…");
    try {
      const excerpt = (p.scenes[0]?.shots ?? []).slice(0, 5).map((s) => s.visual).join(" ").slice(0, 800);
      const styles = await generateStyleSet(notes.trim(), excerpt, apiKey, settings.getModel(), undefined, settings.getBaseUrl());
      productionEmit(id, `Generated ${styles.length} style${styles.length === 1 ? "" : "s"}.`, "done");
      return styles;
    } catch (e) {
      const msg = friendlyApiError(e);
      productionEmit(id, msg, "error");
      throw new Error(msg);
    }
  });

  // Step 2: look at a reference image and distill one named style from it.
  // Keeps the input image as the style's frame (the look anchor) instead of
  // discarding it — the distilled text stays for text-only compatibility.
  handle("production:styleFromImage", async (_e, id: string, imageDataUrl: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
      throw new Error("Pick or paste an image first.");
    }
    const apiKey = settings.getApiKey();
    if (!apiKey) throw new Error(apiKeyRequired());
    productionEmit(id, "Generating a style prompt from the image…");
    try {
      const excerpt = (p.scenes[0]?.shots ?? []).slice(0, 5).map((s) => s.visual).join(" ").slice(0, 800);
      const style = await stylePromptFromImage(imageDataUrl, excerpt, apiKey, settings.getModel(), settings.getBaseUrl());
      // Persist the source image as the style frame (frameSource "reference").
      let imagePath: string | undefined;
      try {
        imagePath = writeStyleFrame(p, `style-${Date.now().toString(36)}`, imageDataUrl);
        productions.saveProduction(p);
      } catch {
        imagePath = undefined;
      }
      productionEmit(id, `Style "${style.name}" generated from the image.`, "done");
      return { ...style, ...(imagePath ? { imagePath } : {}) };
    } catch (e) {
      const msg = friendlyApiError(e);
      productionEmit(id, msg, "error");
      throw new Error(msg);
    }
  });

  // Step 2: generate a style frame (look plate) for one style via the active
  // media provider — fixed neutral-subject scaffold + style text + brand.
  handle("production:generateStyleFrame", (_e, id: string, styleId: string, model?: string, resolution?: string, params?: Record<string, string | number | boolean | string[]>) =>
    runProductionJob(id, "generating a style frame", async (p, emit) => {
      const style = (p.styles ?? []).find((s) => s.id === styleId);
      if (!style) throw new Error("Style not found.");
      if (!style.prompt.trim() && !style.name.trim()) throw new Error("Write the style prompt first.");
      const refMedia = mediaFor(undefined);
      // Per-style overrides ride straight through; "auto"/blank means the
      // production default (the provider treats undefined and "auto" alike).
      const modelOverride = styleFrameOverride(model);
      const resolutionOverride = styleFrameOverride(resolution);
      const gen = refMedia.imageGenFn(p, modelOverride, resolutionOverride, (m) => emit(m, "info"), "16:9");
      if (!gen) throw new Error(`${refMedia.displayName} isn't connected, so style frames can't be generated in-app.`);
      const prompt = styleFramePrompt(style.prompt || style.name, brandPrompt(p));
      emit(`Generating a style frame for "${style.name || `Style ${style.index}`}” (16:9)…`);
      const buf = await gen(prompt, [], undefined, sanitizeGenParams(params));
      const ext = buf[0] === 0xff && buf[1] === 0xd8 ? "jpg" : "png";
      const rel = writeStyleFrame(p, style.id, `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${buf.toString("base64")}`);
      style.imagePath = rel;
      style.frameSource = "generated";
    })
  );

  // Step 2: attach an uploaded/pasted image as one style's frame.
  handle("production:setStyleFrame", (_e, id: string, styleId: string, imageDataUrl: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const style = (p.styles ?? []).find((s) => s.id === styleId);
    if (!style) throw new Error("Style not found.");
    if (typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
      throw new Error("Pick or paste an image first.");
    }
    const rel = writeStyleFrame(p, style.id, imageDataUrl);
    if (style.imagePath && style.imagePath !== rel) {
      try { fs.unlinkSync(assetPath(p, style.imagePath)); } catch { /* old frame already gone */ }
    }
    style.imagePath = rel;
    style.frameSource = "upload";
    productions.saveProduction(p);
    productionEmit(id, `Style frame set for "${style.name || `Style ${style.index}`}".`, "done");
    return p;
  });

  // Step 3: lock the look — copy an approved shot frame to styles/ and point
  // the shot's style (or the master) at it.
  handle("production:useShotAsStyleFrame", (_e, id: string, shotId: string, styleId?: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
    if (!shot) throw new Error("Shot not found.");
    const srcRel = shot.artwork;
    if (!srcRel) throw new Error("That shot has no frame yet — generate it first.");
    const target = (p.styles ?? []).find((s) => s.id === (styleId || shot.style)) ?? p.styles?.[0];
    if (!target) throw new Error("No style to attach the frame to.");
    const buf = fs.readFileSync(assetPath(p, srcRel));
    const ext = path.extname(srcRel).slice(1).toLowerCase() || "jpg";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "png" ? "image/png" : "image/jpeg";
    const rel = writeStyleFrame(p, target.id, `data:${mime};base64,${buf.toString("base64")}`);
    if (target.imagePath && target.imagePath !== rel) {
      try { fs.unlinkSync(assetPath(p, target.imagePath)); } catch { /* old frame already gone */ }
    }
    target.imagePath = rel;
    target.frameSource = "anchor";
    p.anchorShotId = shot.id;
    productions.saveProduction(p);
    productionEmit(id, `Locked the look to shot ${shot.number} for "${target.name || `Style ${target.index}`}".`, "done");
    return p;
  });

  const mutateShots = (
    id: string,
    mutate: (p: Production) => void
  ): Production => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    mutate(p);
    // Keep the human-readable two-column markdown in sync with every edit.
    if (p.scenes.some((s) => s.shots.length)) {
      try {
        fs.writeFileSync(assetPath(p, p.assets.scriptMd), scriptMarkdown(p.meta.name, p.scenes), "utf8");
      } catch {
        /* folder may have been moved — non-fatal for an in-app edit */
      }
    }
    productions.saveProduction(p);
    return p;
  };

  handle("production:insertShot", (_e, id: string, sceneNumber: number, index: number) =>
    // Serialized per production (Fix B): insert/delete/prompt saves each
    // return whole-Production snapshots, so production order must match
    // request order — otherwise a prompt-save response produced before a
    // structural edit can resolve after it and overwrite newer state.
    enqueueProduction(id, async () =>
      mutateShots(id, (p) => {
        const oldNumbers = new Map<string, string>();
        for (const scene of p.scenes) for (const shot of scene.shots) oldNumbers.set(shot.id, shot.number);
        shotter.insertShotAt(p.scenes, sceneNumber, index);
        // A front insert (or an exhausted mid-number gap) re-derives the whole
        // 100-grid; relocate board folders so files follow their shots.
        relocateBoardsForRenumber(p, oldNumbers);
      })
    )
  );

  handle("production:deleteShot", (_e, id: string, shotId: string) =>
    enqueueProduction(id, async () =>
      mutateShots(id, (p) => {
        for (const scene of p.scenes) {
          const i = scene.shots.findIndex((s) => s.id === shotId);
          if (i !== -1) {
            scene.shots.splice(i, 1); // numbers keep their gaps — standard practice
            return;
          }
        }
        throw new Error("Shot not found.");
      })
    )
  );

  handle("production:updateShot", (_e, id: string, shotId: string, patch: { audio?: string; visual?: string }) =>
    mutateShots(id, (p) => {
      for (const scene of p.scenes) {
        const shot = scene.shots.find((s) => s.id === shotId);
        if (shot) {
          if (typeof patch.audio === "string") shot.audio = patch.audio;
          if (typeof patch.visual === "string") shot.visual = patch.visual;
          return;
        }
      }
      throw new Error("Shot not found.");
    })
  );

  handle("production:setShotNumber", (_e, id: string, shotId: string, number: string) =>
    mutateShots(id, (p) => {
      const { oldNumbers } = shotter.setShotNumber(p.scenes, shotId, number);
      relocateBoardsForRenumber(p, oldNumbers);
    })
  );

  handle("production:reorderShot", (_e, id: string, shotId: string, beforeShotId: string | null, endSceneNumber?: number) =>
    mutateShots(id, (p) => {
      const { oldNumbers } = shotter.reorderShot(p.scenes, shotId, beforeShotId, endSceneNumber);
      relocateBoardsForRenumber(p, oldNumbers);
    })
  );

  handle("production:startBlank", (_e, id: string) =>
    mutateShots(id, (p) => {
      if (p.scenes.length) throw new Error("This production already has scenes — re-ingest or edit instead.");
      p.scenes = shotter.blankScenes();
      p.scriptSource = "Blank start";
      p.status[1] = "done";
    })
  );

  handle("production:addScene", (_e, id: string, afterSceneNumber: number | null) =>
    mutateShots(id, (p) => {
      shotter.insertScene(p.scenes, afterSceneNumber);
    })
  );

  /** Per-production FIFO so concurrent Step-3 jobs (batch generation + AI
   *  edits) don't hold stale copies of the production and overwrite each
   *  other's saved frames. Later submissions queue behind running ones. */
  const productionQueues = new Map<string, Promise<unknown>>();
  function enqueueProduction<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = productionQueues.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    productionQueues.set(id, next.catch(() => {}));
    return next;
  }

  /** Rebase a finished generation onto the latest on-disk production. Long
   *  jobs (board generation, board edits) hold their own copy of the
   *  production for minutes; meanwhile the user may edit prompts, switch the
   *  model, etc. (each persisted immediately by the renderer). Saving the job's
   *  stale copy would silently revert those edits. Instead: reload the current
   *  production and copy over ONLY the fields this job actually changed,
   *  so concurrent user edits survive. */
  function rebaseProduction(before: Production, after: Production): Production {
    const fresh = productions.loadProduction(after.meta.id);
    if (!fresh) return after;
    // Top-level fields the pipeline owns (step status markers + magic prompt
    // state + Step 5 assembly bookkeeping). `assembly` is included so an
    // assemble()/renderAnimatic() run persists its assembledAt/renderPath.
    // `characters`/`references`/`referenceCategories` are included so the
    // runProductionJob-based generators (reference-image gen, character
    // builder) persist their new/updated entries — without them those changes
    // were silently dropped on save.
    for (const k of ["status", "currentStep", "magicEnabled", "magicPrompts", "assembly", "characters", "references", "referenceCategories"] as const) {
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
        (fresh as unknown as Record<string, unknown>)[k] = after[k];
      }
    }
    const flat = (p: Production) => p.scenes.flatMap((s) => s.shots);
    const prevById = new Map(flat(before).map((s) => [s.id, s]));
    const nextById = new Map(flat(after).map((s) => [s.id, s]));
    for (const shot of flat(fresh)) {
      const prev = prevById.get(shot.id);
      const next = nextById.get(shot.id);
      if (!prev || !next) continue;
      // Copy every shot field the job mutated (artwork, artworkHistory,
      // durationSec/transition for timing, …) but leave untouched fields —
      // e.g. prompt / style / ref overrides edited mid-run — at their
      // fresher on-disk values.
      for (const key of Object.keys(next) as (keyof ProductionShot)[]) {
        if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
          (shot as unknown as Record<string, unknown>)[key] = next[key];
        }
      }
      // A mid-job selection change (Make Primary / node cycling) must survive
      // the job's copied generation arrays — re-anchor at the user's path.
      const genPairs = [
        ["graphImageGens", "graphImageGenIndex"],
        ["graphVideoGens", "graphVideoGenIndex"],
      ] as const;
      for (const [arrKey, idxKey] of genPairs) {
        if (JSON.stringify(prev[arrKey]) === JSON.stringify(next[arrKey])) continue;
        (shot as unknown as Record<string, unknown>)[idxKey] = rebaseGenIndex(
          prev[arrKey], prev[idxKey], shot[arrKey], shot[idxKey], next[arrKey], next[idxKey],
        );
      }
      // Edit nodes own per-node histories; re-anchor each node's selection.
      for (const node of shot.graphEditNodes ?? []) {
        const prevNode = prev.graphEditNodes?.find((n) => n.id === node.id);
        const nextNode = next.graphEditNodes?.find((n) => n.id === node.id);
        if (!prevNode || !nextNode) continue;
        if (JSON.stringify(prevNode.gens) === JSON.stringify(nextNode.gens)) continue;
        node.genIndex = rebaseGenIndex(prevNode.gens, prevNode.genIndex, node.gens, node.genIndex, nextNode.gens, nextNode.genIndex);
      }
    }
    return fresh;
  }

  /** Shared runner for the LLM/image-driven steps (3 & 4): status + log + persist. */
  async function runProductionStep(
    id: string,
    step: 3 | 4 | 5,
    label: string,
    fn: (p: Production, emit: (m: string, l?: ProductionEvent["level"]) => void) => Promise<void>,
    opts: { needsApiKey?: boolean } = {}
  ): Promise<Production> {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (!p.scenes.some((s) => s.shots.length)) throw new Error("No shots yet — ingest a script in Step 1 first.");
    if (opts.needsApiKey !== false && !settings.getApiKey()) {
      throw new Error(apiKeyRequired());
    }
    p.status[step] = "running";
    productions.saveProduction(p);
    productionEmit(id, `Step ${step} started: ${label}`);
    try {
      // Load the production INSIDE the queue so this job sees every frame
      // recorded by earlier jobs, and its save can't clobber them.
      await enqueueProduction(id, async () => {
        const pq = productions.loadProduction(id);
        if (!pq) throw new Error("Production not found.");
        pq.status[step] = "running";
        const before = structuredClone(pq);
        await fn(pq, (m, l) => productionEmit(id, m, l));
        productions.saveProduction(rebaseProduction(before, pq));
      });
    } catch (e) {
      const pErr = productions.loadProduction(id);
      if (pErr) { pErr.status[step] = "error"; productions.saveProduction(pErr); }
      productionEmit(id, friendlyApiError(e), "error");
      throw new Error(friendlyApiError(e));
    }
    return productions.loadProduction(id) ?? p;
  }

  /** Background job runner for per-shot work that isn't tied to a pipeline step
   *  (video generation, removal) — serialized per production, rebased onto the
   *  freshest on-disk state before saving, logged via productionEmit. */
  async function runProductionJob(
    id: string,
    label: string,
    fn: (p: Production, emit: (m: string, l?: ProductionEvent["level"]) => void) => Promise<void>
  ): Promise<Production> {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    productionEmit(id, `${label}…`);
    try {
      await enqueueProduction(id, async () => {
        const pq = productions.loadProduction(id);
        if (!pq) throw new Error("Production not found.");
        const before = structuredClone(pq);
        await fn(pq, (m, l) => productionEmit(id, m, l));
        productions.saveProduction(rebaseProduction(before, pq));
      });
    } catch (e) {
      productionEmit(id, friendlyApiError(e), "error");
      throw new Error(friendlyApiError(e));
    }
    return productions.loadProduction(id) ?? p;
  }

  /** Video-job runner: generations run CONCURRENTLY (submit + 20-min poll off
   *  the queue) so N shots/blocks can render at once; only the short
   *  load→rebase→save commit rides the per-production FIFO. Each job mutates
   *  its own loaded copy, so concurrent jobs never share objects — the commit
   *  replays only that job's field diffs onto the freshest disk state. */
  async function runVideoJob(
    id: string,
    label: string,
    fn: (p: Production, emit: (m: string, l?: ProductionEvent["level"]) => void) => Promise<void>
  ): Promise<Production> {
    const snap = productions.loadProduction(id);
    if (!snap) throw new Error("Production not found.");
    productionEmit(id, `${label}…`);
    const before = structuredClone(snap);
    try {
      await fn(snap, (m, l) => productionEmit(id, m, l));
    } catch (e) {
      productionEmit(id, friendlyApiError(e), "error");
      throw new Error(friendlyApiError(e));
    }
    await enqueueProduction(id, async () => {
      productions.saveProduction(rebaseProduction(before, snap));
    });
    return productions.loadProduction(id) ?? snap;
  }

  // Step 3: storyboard frame generation (batched or single-shot). In-app
  // generation goes through the active media provider; when that isn't
  // connected we export per-shot prompts instead so the user can generate
  // the frames elsewhere and import them (production:importBoards).
  const boardsOrPrompts = async (
    p: Production,
    emit: (m: string, l?: ProductionEvent["level"]) => void,
    genOpts: { maxShots?: number; regenerateAll?: boolean; onlyShotId?: string; shotIds?: string[] }
  ): Promise<void> => {
    // Route by the production's stored pick, not the global vendor: an
    // explicit `higgsfield-cli:…` (or legacy `higgsfield:…`) pick rides
    // Higgsfield even when the global is OpenArt (mirrors the video-node
    // path via mediaFor). "auto"/empty defers to the global.
    const routed = mediaFor(p.openArt?.model);
    const gen = routed.imageGenFn(p, undefined, undefined, (m) => emit(m, "info"));
    if (!gen) {
      emit(`${routed.displayName} isn't connected (no image-generation tool found), so frames can't be generated in-app.`, "error");
      exportBoardPrompts(p, emit);
      emit("Generate the frames with those prompts, then use “Import frames…” (name each file with its shot number, e.g. 0100.png).", "info");
      p.status[3] = "todo";
      return;
    }
    emit(`Using ${routed.displayName} for image generation.`);
    await generateBoards(p, gen, emit, { ...genOpts, providerName: routed.displayName });
  };

  handle("production:generateBoards", (_e, id: string, opts?: { maxShots?: number; regenerateAll?: boolean }) =>
    runProductionStep(id, 3, opts?.regenerateAll ? "regenerating all storyboards" : "storyboard generation", async (p, emit) => {
      await boardsOrPrompts(p, emit, opts ?? {});
    }, { needsApiKey: false })
  );

  handle("production:regenerateBoard", (_e, id: string, shotId: string) =>
    runProductionStep(id, 3, `regenerating one board`, async (p, emit) => {
      await boardsOrPrompts(p, emit, { onlyShotId: shotId });
    }, { needsApiKey: false })
  );

  // Step 3: regenerate several frames in parallel within ONE shared production
  // (single load + save, concurrency handled inside generateBoards — avoids
  // the clobber that parallel per-frame saves would cause).
  handle("production:regenerateBoards", (_e, id: string, shotIds: string[]) =>
    runProductionStep(id, 3, `regenerating ${(shotIds ?? []).length} boards`, async (p, emit) => {
      await boardsOrPrompts(p, emit, { shotIds: Array.isArray(shotIds) ? shotIds : [shotIds] });
    }, { needsApiKey: false })
  );

  // Step 3: reclaim a frame whose async vendor job outlived the generating
  // call — the active provider re-polls it via recheckPendingImage.
  // the wait timed out or the finished image couldn't be downloaded. The job
  // keeps rendering server-side, so a recheck re-polls it and downloads the
  // image when ready, recovering the frame without a second generation.
  handle("production:recheckBoard", (_e, id: string, shotId: string) =>
    runProductionJob(id, "rechecking a pending frame", async (p, emit) => {
      const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
      if (!shot) throw new Error("Shot not found.");
      const pending = shot.pendingImageGen;
      if (!pending) {
        emit(`Shot ${shot.number}: nothing pending to recheck.`, "info");
        return;
      }
      emit(`Shot ${shot.number}: rechecking the pending generation job…`, "info");
      let buf: Buffer;
      try {
        const got = await mediaFor(pending.model).recheckPendingImage(pending);
        if (!got) {
          emit(`Shot ${shot.number}: the frame is still rendering — check again in a minute.`, "info");
          return;
        }
        buf = got;
      } catch (e) {
        // The job is dead (FAILED/CANCELLED) — drop the stale pending record so
        // the shot stops showing as pending; the user regenerates instead.
        delete shot.pendingImageGen;
        throw e;
      }
      const { jpegRel } = writeBoardFrame(p, shot, buf, "png");
      recordGraphImageGen(shot, jpegRel, pending.prompt, pending.model);
      hookImageGenToOutput(shot);
      // The original submit never reached its generation recorder (the wait
      // timed out), so the cost was unbilled. Bill it now, once, using the
      // submit-time resolution/aspect kept on the pending record. Higgsfield
      // rows re-quote their credits from the kept config (best-effort).
      let reclaimCredits: number | undefined;
      try {
        reclaimCredits = await mediaFor(pending.model).getGenerationCost?.({
          model: pending.model, kind: "image",
          ...(pending.resolution ? { resolution: pending.resolution } : {}),
          ...(pending.aspectRatio ? { aspectRatio: pending.aspectRatio } : {}),
          ...(pending.quality ? { quality: pending.quality } : {}),
          ...(pending.params && Object.keys(pending.params).length ? { params: { ...pending.params } } : {}),
        }) ?? undefined;
      } catch {
        reclaimCredits = undefined;
      }
      ledger.recordGeneration({
        kind: "image",
        model: pending.model,
        resolution: pending.resolution ?? "",
        aspectRatio: pending.aspectRatio,
        credits: reclaimCredits,
        at: Date.now(),
        productionId: p.meta.id,
        shotId: shot.id,
      }, settings.getHiggsfieldCreditUsd());
      delete shot.pendingImageGen;
      emit(`Shot ${shot.number}: frame recovered from the pending generation job.`, "done");
    })
  );

  // Step 3 fallback: write boards/prompts.md for manual generation.
  handle("production:boardPrompts", (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (!p.scenes.some((s) => s.shots.length)) throw new Error("No shots yet — ingest a script in Step 1 first.");
    productionEmit(id, "Exporting storyboard prompts…");
    exportBoardPrompts(p, (m, l) => productionEmit(id, m, l));
    productions.saveProduction(p);
    return p;
  });

  // Step 3: storyboard PDF — landscape pages (1 or 3 panels per page), each
  // panel a still frame (or placeholder) over Audio:/Visual: boxes, with the
  // production name + version lower-left and the stored logo lower-right.
  handle("production:exportStoryboardPdf", async (_e, id: string, opts?: { panelsPerPage?: 1 | 3; version?: string }) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const shots = p.scenes.flatMap((s) => s.shots);
    if (!shots.length) throw new Error("No shots yet — ingest a script in Step 1 first.");
    const panelsPerPage = opts?.panelsPerPage === 3 ? 3 : 1;
    const version = sanitizeVersion(opts?.version ?? p.storyboardPdf?.version ?? "v1");
    const readFile = (abs: string): Uint8Array | null => {
      try {
        return new Uint8Array(fs.readFileSync(abs));
      } catch {
        return null;
      }
    };
    const panels = shots.map((shot) => ({
      number: shot.number,
      audio: shot.audio,
      visual: shot.visual,
      image: loadPanelImage(p, shot, readFile),
    }));
    const pdfBytes = await buildStoryboardPdf(panels, {
      productionName: p.meta.name,
      version,
      panelsPerPage,
      logo: loadLogoImage(p, readFile),
    });
    const res = await dialog.showSaveDialog(win!, {
      title: "Export storyboard PDF",
      defaultPath: path.join(p.meta.folder, p.assets.outDir, storyboardPdfFileName(p.meta.name, version)),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (res.canceled || !res.filePath) return { filePath: null as string | null, production: p };
    p.storyboardPdf = { ...p.storyboardPdf, version, panelsPerPage };
    productions.saveProduction(p);
    fs.mkdirSync(path.dirname(res.filePath), { recursive: true });
    fs.writeFileSync(res.filePath, Buffer.from(pdfBytes));
    productionEmit(id, `Storyboard PDF exported: ${res.filePath}`, "done");
    return { filePath: res.filePath as string | null, production: p };
  });

  // Step 3: pick the storyboard-PDF logo (PNG/JPG) — copied into the
  // production folder and printed in the lower-right corner of every page.
  handle("production:pickStoryboardLogo", async (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const res = await dialog.showOpenDialog(win!, {
      title: "Choose storyboard logo",
      properties: ["openFile"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    const file = res.canceled ? null : res.filePaths[0];
    if (!file) return null;
    const buf = fs.readFileSync(file);
    if (buf.length > 15 * 1024 * 1024) throw new Error("Image is larger than 15 MB.");
    const kind = detectImageKind(new Uint8Array(buf));
    if (!kind) throw new Error("That file isn't a PNG or JPEG image.");
    const rel = `${p.assets.boardsDir}/storyboard-logo.${kind === "png" ? "png" : "jpg"}`;
    const prev = p.storyboardPdf?.logoRel;
    if (prev && prev !== rel) archiveAsset(p, prev);
    fs.mkdirSync(path.dirname(assetPath(p, rel)), { recursive: true });
    fs.writeFileSync(assetPath(p, rel), buf);
    p.storyboardPdf = { ...p.storyboardPdf, logoRel: rel };
    productions.saveProduction(p);
    return p;
  });

  // Step 3: remove the stored storyboard-PDF logo (file + setting).
  handle("production:clearStoryboardLogo", (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (p.storyboardPdf?.logoRel) {
      try {
        fs.unlinkSync(assetPath(p, p.storyboardPdf.logoRel));
      } catch { /* missing file is already removed */ }
      delete p.storyboardPdf.logoRel;
      productions.saveProduction(p);
    }
    return p;
  });

  // Step 3: data URL of the stored storyboard-PDF logo for the export dialog
  // preview (null when none is attached).
  handle("production:storyboardLogoImage", (_e, id: string) => {
    const p = productions.loadProduction(id);
    const rel = p?.storyboardPdf?.logoRel;
    if (!p || !rel) return null;
    try {
      const buf = fs.readFileSync(assetPath(p, rel));
      const mime = rel.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      return null;
    }
  });

  // Step 3: per-frame copy — return the effective prompt (same source the export uses).
  handle("production:boardPrompt", (_e, id: string, shotId: string) => {
    const p = productions.loadProduction(id);
    if (!p) return null;
    const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
    // Keep human @[name] tags in the editor; transport conversion happens only
    // inside the active provider's imageGenFn immediately before MCP submission.
    return shot ? stripReferenceClause(effectivePrompt(p, shot)) : null;
  });

  // Step 3: persist a shot's editable board-prompt override (empty clears it).
  // When Magic Prompt is enabled, edits target the magicPrompts map (content-only)
  // instead of the normal shot.prompt field; the original prompts stay untouched.
  handle("production:updateBoardPrompt", (_e, id: string, shotId: string, prompt: string) =>
    // Serialized per production (Fix B): see insertShot/deleteShot above.
    enqueueProduction(id, async () => {
      const p = productions.loadProduction(id);
      if (!p) throw new Error("Production not found.");
      const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
      if (!shot) throw new Error("Shot not found.");
      const text = typeof prompt === "string" ? prompt.trim() : "";
      const clean = text ? stripReferenceClause(text) : "";
      if (p.magicEnabled) {
        p.magicPrompts ??= {};
        if (clean) {
          // Persist only the content box — Style/Brand stay derived from the style system
          const content = parsePromptBoxes(clean).content.trim() || stripMagicLeakage(clean);
          if (content) p.magicPrompts[shotId] = content.slice(0, 2000);
          else delete p.magicPrompts[shotId];
        } else if (text && !clean) {
          delete p.magicPrompts[shotId];
        } else {
          delete p.magicPrompts[shotId];
        }
        productions.saveProduction(p);
        return p;
      }
      if (clean) {
        shot.prompt = clean;
        shot.promptManual = true; // manual: survives re-ingestion & design changes
      } else if (text && !clean) {
        // User erased everything except the auto-appended clause — treat as cleared.
        delete shot.prompt;
        shot.promptManual = false;
      } else {
        delete shot.prompt;
        shot.promptManual = false; // cleared → auto-derived prompt applies again
      }
      productions.saveProduction(p);
      return p;
    })
  );

  // Step 3: refresh — discard a shot's manual prompt and re-derive it from the
  // current design (style, brand, references) + script text.
  // When Magic Prompt is enabled, clears the magic content for that shot so
  // it falls back to the normal derived prompt until Magic is regenerated.
  handle("production:refreshBoardPrompt", (_e, id: string, shotId: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
    if (!shot) throw new Error("Shot not found.");
    if (p.magicEnabled && p.magicPrompts?.[shotId]) {
      delete p.magicPrompts[shotId];
      productions.saveProduction(p);
      productionEmit(id, `Shot ${shot.number}: magic prompt cleared — showing original prompt.`);
      return p;
    }
    delete shot.prompt;
    shot.promptManual = false;
    if (p.promptOverrides) delete p.promptOverrides[shot.number];
    productions.saveProduction(p);
    productionEmit(id, `Shot ${shot.number}: prompt refreshed from the current design.`);
    return p;
  });

  // Step 3: Magic Prompt — generate content-only prompts for the full storyboard (enables magic toggle).
  handle("production:generateMagicPrompts", async (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (!p.scenes.some((s) => s.shots.length)) throw new Error("No shots yet — ingest a script in Step 1 first.");
    const apiKey = settings.getApiKey();
    if (!apiKey) throw new Error(apiKeyRequired());
    productionEmit(id, "Magic Prompt: generating content prompts for all shots…");
    try {
      await enqueueProduction(id, async () => {
        const pq = productions.loadProduction(id);
        if (!pq) throw new Error("Production not found.");
        const before = structuredClone(pq);
        await generateMagicPrompts(pq, apiKey, settings.getModel(), (m, l) => productionEmit(id, m, l), settings.getBaseUrl());
        productions.saveProduction(rebaseProduction(before, pq));
      });
    } catch (e) {
      productionEmit(id, friendlyApiError(e), "error");
      throw new Error(friendlyApiError(e));
    }
    return productions.loadProduction(id) ?? p;
  });

  handle("production:setMagicEnabled", (_e, id: string, enabled: boolean) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const next = !!enabled;
    p.magicEnabled = next;
    // If enabling but nothing generated yet, keep it off and warn via log
    if (next && (!p.magicPrompts || !Object.keys(p.magicPrompts).length)) {
      p.magicEnabled = false;
      productions.saveProduction(p);
      productionEmit(id, "No Magic Prompts yet — generate them first.", "error");
      throw new Error("No Magic Prompts yet — generate them first.");
    }
    productions.saveProduction(p);
    productionEmit(id, next ? "Magic Prompt enabled — showing AI-generated content prompts." : "Magic Prompt disabled — restored original prompts.", "done");
    return p;
  });

  handle("production:checkExternalEdits", async () => {
    await checkExternalEdits();
  });

  // Step 3: image/video-capable models for the model dropdowns. Empty on
  // failure — the renderer shows the empty state instead of a synthetic pick.
  // Models the user hides (Settings → Models & expenses) are filtered out here
  // and manual kind assignments are applied, so every generation dropdown
  // respects the list without renderer changes. The list is then sorted into
  // the user's saved drag-to-reorder arrangement (same tab) — every dropdown
  // follows it.
  handle("production:openArtModels", async () => {
    try {
      const hidden = new Set(settings.getHiddenMediaModels());
      const choices = applyKindOverrides(await media().listModelChoices(), settings.getModelKindOverrides());
      // Prefetch the video models' resolution/length options in the background
      // so the video modal and node graph populate instantly on first open.
      media().prewarm?.(choices);
      const visible = hidden.size ? choices.filter((c) => !hidden.has(c.id)) : choices;
      // Tag each model with the surfaces it's allowed on so every picker can
      // filter by its own surface key.
      const surfaced = applyModelSurfaces(visible, settings.getModelSurfaces());
      return sortByModelOrder(surfaced, settings.getMediaModelOrder(), (c) => c.id);
    } catch {
      return [];
    }
  });

  // Settings → Models & expenses: probe both vendors and bake every model's
  // pricing ladder (resolution ladder + video length range).
  handle("media:listAllModels", async (): Promise<MediaModelLadder[]> => {
    return listAllModelLadders(providers, settings.getModelKindOverrides());
  });

  // Step 3: the signed-in OpenArt account's remaining credit balance (shown
  // in the video-generation dialog). Null when OpenArt isn't connected or the
  // account lookup fails.
  handle("production:openArtCredits", async (): Promise<number | null> => media().getCredits());

  // Step 2: the 3D AI Studio account's remaining credit balance (shown in the
  // design-page 3D model panel). Null when no key is stored.
  handle("production:3daiCredits", async (): Promise<number | null> => modelgen.getCredits());

  // Step 2: generate a 3D model via 3D AI Studio (Tencent Hunyuan Pro). The
  // finished GLB is downloaded into the production's models folder and the
  // record is appended to prod.models3d. The renderer resolves reference
  // images / multi-view angles to data URLs before calling.
  handle("production:generate3dModel", async (_e, id: string, opts: Model3dGenOptions) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (!settings.get3daiApiKey()) throw new Error("Add your 3D AI Studio API key in Settings first.");
    return runProductionJob(id, "3D model: submitting Tencent Hunyuan Pro generation", async (pq, emit) => {
      const at = Date.now();
      const bytes = await modelgen.generate(opts, (status, progress) => {
        emit(`3D model: ${status}${typeof progress === "number" ? ` (${progress}%)` : ""}…`);
      });
      const rel = `${pq.assets.modelsDir}/${modelFileName(opts, at)}`;
      const abs = assetPath(pq, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
      pq.models3d = [toProductionModel(rel, opts, at), ...(pq.models3d ?? [])];
      emit(`3D model: saved ${rel}.`, "done");
    });
  });

  // Step 2: delete a generated 3D model (removes the .glb file + record).
  handle("production:delete3dModel", (_e, id: string, modelId: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const m = (p.models3d ?? []).find((m) => m.id === modelId);
    if (m) {
      try {
        fs.unlinkSync(assetPath(p, m.glbPath));
      } catch {
        /* file already gone */
      }
      p.models3d = (p.models3d ?? []).filter((x) => x.id !== modelId);
    }
    productions.saveProduction(p);
    return p;
  });

  // Step 2: copy a generated GLB to a user-chosen location via the native
  // Save As dialog. Resolves to the saved path, or null when cancelled.
  handle("production:save3dModel", async (_e, id: string, modelId: string): Promise<string | null> => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const m = (p.models3d ?? []).find((m) => m.id === modelId);
    if (!m) throw new Error("Model not found.");
    const src = assetPath(p, m.glbPath);
    if (!fs.existsSync(src)) throw new Error("Model file is missing on disk.");
    const res = await dialog.showSaveDialog(win!, {
      title: "Save 3D model",
      defaultPath: path.join(app.getPath("downloads"), path.basename(m.glbPath)),
      filters: [{ name: "GLB 3D model", extensions: ["glb"] }],
    });
    if (res.canceled || !res.filePath) return null;
    fs.copyFileSync(src, res.filePath);
    return res.filePath;
  });

  // Step 3 manual workflow: pick generated frames anywhere on disk.
  handle("production:pickBoardImages", async () => {
    const res = await dialog.showOpenDialog(win!, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    return res.canceled ? [] : res.filePaths;
  });

  // Step 3 manual workflow: import frames. Without explicit files, scans
  // <boards>/import/; with `shotId`, the first file goes to that shot;
  // otherwise files are matched by the 4-digit shot number in the filename.
  handle("production:importBoards", (_e, id: string, files?: string[], shotId?: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (!p.scenes.some((s) => s.shots.length)) throw new Error("No shots yet — ingest a script in Step 1 first.");
    const useFiles = Array.isArray(files) && files.length ? files : scanBoardImportFolder(p);
    if (!useFiles.length) {
      productionEmit(id, `No images found. Pick files with “Import frames…”, or drop shot-numbered images (e.g. 0100.png) into ${p.assets.boardsDir}/import/ and click “Scan import folder”.`, "error");
      return p;
    }
    productionEmit(id, `Importing ${useFiles.length} frame(s)…`);
    importBoards(p, useFiles, (m, l) => productionEmit(id, m, l), { shotId: typeof shotId === "string" ? shotId : undefined });
    productions.saveProduction(p);
    return p;
  });

  // Board thumbnails for the contact sheet — the PNGs live in the production
  // folder; the renderer gets a small data URL (like chat image thumbs).
  handle("production:boardImage", (_e, id: string, shotId: string, framePath?: string) => {
    const p = productions.loadProduction(id);
    if (!p) return null;
    const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
    if (!shot) return null;
    const rel = framePath ?? shot.artwork;
    if (!rel || (rel !== shot.artwork && !boardFrameHistory(shot).includes(rel))) return null;
    try {
      const buf = fs.readFileSync(assetPath(p, rel));
      const img = nativeImage.createFromBuffer(buf);
      const thumb = img && !img.isEmpty() && img.getSize().width > 640 ? img.resize({ width: 640 }) : img;
      return thumb && !thumb.isEmpty() ? thumb.toDataURL() : null;
    } catch {
      return null;
    }
  });

  // Full-resolution board frame for the zoom lightbox. Perf 2.5: returns a
  // cascade-media:// URL (streamed + range-capable by media-protocol.ts),
  // not a re-encoded base64 blob — no synchronous file read, no ~33% base64
  // inflation, no giant IPC payload. The renderer uses it directly as <img>
  // src. Base64 stays only for the tiny 480px thumbnails where the round-trip
  // cost dominates.
  handle("production:boardImageFull", (_e, id: string, shotId: string, framePath?: string) => {
    const p = productions.loadProduction(id);
    if (!p) return null;
    const resolved = resolveBoardFrame(p, shotId, framePath);
    if (!resolved) return null;
    try {
      if (!fs.statSync(resolved.abs).isFile()) return null;
    } catch {
      return null;
    }
    return `cascade-media://${id}/${encodeURIComponent(resolved.rel)}`;
  });

handle("production:boardThumbnail", (_e, id: string, shotId: string, framePath?: string) => {
    const p = productions.loadProduction(id);
    if (!p) return null;
    const resolved = resolveBoardFrame(p, shotId, framePath);
    if (!resolved) return null;
    const cacheKey = `${id}:${shotId}:${framePath ?? ""}`;
    try {
      const mtimeMs = fs.statSync(resolved.abs).mtimeMs;
      const hit = boardThumbGet(cacheKey, `${resolved.abs}:${mtimeMs}`);
      if (hit) return hit;
      const dataUrl = renderBoardThumb(resolved.abs);
      if (dataUrl) boardThumbSet(cacheKey, `${resolved.abs}:${mtimeMs}`, dataUrl);
      return dataUrl;
    } catch { return null; }
  });

  // Perf 1.4: batch thumbnails — one loadProduction + one pass for N shots.
  // The scheduler calls this in MAX_CONCURRENT_THUMBS-sized chunks, turning
  // ~100 IPC round-trips into a handful. Per-shot handler stays for single
  // refresh paths.
  handle("production:boardThumbnails", (_e, id: string, shotIds: string[]) => {
    const p = productions.loadProduction(id);
    if (!p) return {};
    const out: Record<string, string> = {};
    const ids = Array.isArray(shotIds) ? shotIds.slice(0, 200) : [];
    for (const shotId of ids) {
      if (typeof shotId !== "string" || !shotId) continue;
      const resolved = resolveBoardFrame(p, shotId);
      if (!resolved) continue;
      const cacheKey = `${id}:${shotId}:`;
      try {
        const mtimeMs = fs.statSync(resolved.abs).mtimeMs;
        const hit = boardThumbGet(cacheKey, `${resolved.abs}:${mtimeMs}`);
        if (hit) { out[shotId] = hit; continue; }
        const dataUrl = renderBoardThumb(resolved.abs);
        if (dataUrl) { boardThumbSet(cacheKey, `${resolved.abs}:${mtimeMs}`, dataUrl); out[shotId] = dataUrl; }
      } catch { /* skip missing frames */ }
    }
    return out;
  });

  // Step 3: re-link broken storyboard image paths — after board files were
  // moved/renamed externally (or a production folder was re-registered), a
  // shot's artwork/history/node-graph generation paths can point at files that
  // no longer exist. Repoints every broken path to the newest frame present in
  // that shot's board folder; valid paths are untouched.
  handle("production:refreshBoardLinks", (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const repaired = refreshBoardLinks(p);
    if (repaired > 0) {
      productions.saveProduction(p);
      productionEmit(id, `Refresh storyboard images: re-linked ${repaired} broken frame path(s) to files on disk.`, "done");
    } else {
      productionEmit(id, "Refresh storyboard images: no broken links — every frame path already resolves.", "info");
    }
    return p;
  });

  handle("production:deleteBoardImage", (_e, id: string, shotId: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
    if (!shot) throw new Error("Shot not found.");
    if (shot.artwork) {
      try { fs.unlinkSync(assetPath(p, shot.artwork)); } catch { /* missing file is already removed */ }
      delete shot.artwork;
    }
    productions.saveProduction(p);
    return p;
  });

  // Select the owning generation and output pipe together, using a stable
  // path so a completed generation cannot shift the frame being promoted.
  handle("production:promoteBoardHistory", (_e, id: string, shotId: string, framePath: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
    if (!shot) throw new Error("Shot not found.");
    selectBoardFrame(shot, framePath);
    productions.saveProduction(p);
    productionEmit(id, `Shot ${shot.number}: history frame restored as the primary frame.`);
    return p;
  });

  // Per-shot video generation: the shot's current frame (full resolution) plus
  // any @[name] references in the prompt are uploaded to the active provider
  // as visual references; the finished clip is stored in the shot's board
  // folder under video/ and played by the animatic timeline for this shot's
  // duration window.
  handle("production:generateVideo", (_e, id: string, shotId: string, opts: VideoGenOptions) =>
    runVideoJob(id, `Generating a video for a shot`, async (p, emit) => {
      const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
      if (!shot) throw new Error("Shot not found.");
      if (!shot.artwork) throw new Error("Generate or import a frame for this shot first — the frame is the video's source.");
      const clean: VideoGenOptions = {
        model: typeof opts?.model === "string" && opts.model.trim() ? opts.model.trim() : "auto",
        resolution: typeof opts?.resolution === "string" && opts.resolution.trim() ? opts.resolution.trim() : "1080p",
        durationSec: Number(opts?.durationSec) > 0 ? Number(opts.durationSec) : 5,
        prompt: typeof opts?.prompt === "string" ? opts.prompt.trim() : "",
        // Schema-driven extras ride through opaquely; the provider's arg
        // builder drops anything the active model's schema doesn't allow.
        ...(opts?.params && typeof opts.params === "object" ? { params: opts.params } : {}),
      };
      if (!clean.prompt) throw new Error("Describe the motion first (e.g. \"camera pans left, leaves drift\").");
      emit(`Shot ${shot.number}: generating a ${clean.durationSec}s video${clean.model !== "auto" ? ` via ${clean.model}` : ""}…`);
      const { rel } = await mediaFor(clean.model).generateVideoClip(p, shot, clean, emit);
      if (shot.videoPath) { try { fs.unlinkSync(assetPath(p, shot.videoPath)); } catch { /* old file already gone */ } }
      shot.videoPath = rel;
      recordGraphVideoGen(shot, rel, clean.prompt, clean.model);
      hookVideoGenToOutput(shot);
      emit(`Shot ${shot.number}: video ready — it will play for the shot's ${shot.durationSec ?? 3}s window in the animatic.`, "done");
    })
  );

  handle("production:videoUrl", (_e, id: string, shotId: string): string | null => {
    const p = productions.loadProduction(id);
    if (!p) return null;
    const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
    if (!shot?.videoPath) return null;
    return `cascade-media://${p.meta.id}/${encodeURIComponent(shot.videoPath)}`;
  });

  // Step 3 node graph: generate one frame from a custom prompt (the prompt
  // composer's text) without touching the shot's artwork — the result is
  // stored on the image generation node and cycled/applied from there.
  handle("production:generateFrameNode", (_e, id: string, shotId: string, opts: { prompt?: string; model?: string; resolution?: string; params?: Record<string, string | number | boolean | string[]> }) =>
    runProductionStep(id, 3, "generating a frame (node graph)", async (p, emit) => {
      const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
      if (!shot) throw new Error("Shot not found.");
      const prompt = typeof opts?.prompt === "string" ? opts.prompt.trim() : "";
      if (!prompt) throw new Error("The prompt is empty — write something in the prompt node first.");
      const frameModel = typeof opts?.model === "string" && opts.model.trim() ? opts.model.trim() : undefined;
      const frameResolution = typeof opts?.resolution === "string" && opts.resolution.trim() ? opts.resolution.trim() : undefined;
      const frameMedia = mediaFor(frameModel);
      const gen = frameMedia.imageGenFn(p, frameModel, frameResolution, (m) => emit(m, "info"));
      if (!gen) throw new Error(`${frameMedia.displayName} MCP isn't connected, so frames can't be generated in-app.`);
      // References: the @[name] tags the composer prompt actually cites.
      const { resolved, extras } = resolvePromptRefs(p, prompt, 0);
      emit(`Shot ${shot.number}: generating a node-graph frame…`);
      const png = await gen(resolved, extras, shot, opts?.params);
      const { jpegRel } = writeBoardFrame(p, shot, png, "png");
      recordGraphImageGen(shot, jpegRel, prompt, typeof opts?.model === "string" && opts.model.trim() ? opts.model.trim() : "auto");
      syncBoardOutputToPipe(shot);
      emit(`Shot ${shot.number}: node frame ready.`, "done");
    }, { needsApiKey: false })
  );

  // Step 3 node graph: generate one video clip for the video generation node.
  // The animated source frame comes from the node's image pipe when one is
  // connected, otherwise the shot's current frame. The clip is stored on the
  // node; it becomes shot.videoPath only when the node is piped to the output.
  handle("production:generateVideoNode", (_e, id: string, shotId: string, opts: { prompt?: string; model?: string; resolution?: string; durationSec?: number; sourcePath?: string; refIds?: string[]; params?: Record<string, string | number | boolean | string[]> }) =>
    runVideoJob(id, "generating a video (node graph)", async (p, emit) => {
      const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
      if (!shot) throw new Error("Shot not found.");
      const clean: VideoGenOptions = {
        model: typeof opts?.model === "string" && opts.model.trim() ? opts.model.trim() : "auto",
        resolution: typeof opts?.resolution === "string" && opts.resolution.trim() ? opts.resolution.trim() : "1080p",
        durationSec: Number(opts?.durationSec) > 0 ? Number(opts.durationSec) : 5,
        prompt: typeof opts?.prompt === "string" ? opts.prompt.trim() : "",
        ...(opts?.params && typeof opts.params === "object" ? { params: opts.params } : {}),
      };
      if (!clean.prompt) throw new Error("Describe the motion first (e.g. \"camera pans left, leaves drift\").");
      // Additional references plugged into the video node's open sockets. Both
      // image artwork and dropped video clips upload as visual references.
      const extraRefs: { name: string; dataUrl: string }[] = [];
      if (Array.isArray(opts?.refIds)) {
        const pool = [
          ...p.characters.map((c) => ({ id: c.id, name: c.name, data: refArtworkDataUrl(p, c) })),
          ...p.products.map((pr) => ({ id: pr.id, name: pr.name, data: refArtworkDataUrl(p, pr) })),
          ...(p.references ?? []).map((r) => ({
            id: r.id,
            name: r.name,
            data: r.media === "video" ? refMediaDataUrl(p, r) : refArtworkDataUrl(p, r),
          })),
        ];
        for (const rid of opts.refIds) {
          const ref = pool.find((r) => r.id === rid && r.data);
          if (ref?.data) extraRefs.push({ name: ref.name, dataUrl: ref.data });
        }
      }
      const sourcePath = typeof opts?.sourcePath === "string" && opts.sourcePath.trim() ? opts.sourcePath.trim() : undefined;
      emit(`Shot ${shot.number}: generating a ${clean.durationSec}s video${clean.model !== "auto" ? ` via ${clean.model}` : ""}${extraRefs.length ? ` (${extraRefs.length} reference${extraRefs.length === 1 ? "" : "s"})` : ""}…`);
      const { rel } = await mediaFor(clean.model).generateVideoClip(p, shot, clean, emit, sourcePath, extraRefs);
      recordGraphVideoGen(shot, rel, clean.prompt, clean.model);
      if (shot.graphOutputSource === "videogen") applyVideoOutput(shot, rel, sourcePath);
      emit(`Shot ${shot.number}: node video ready.`, "done");
    })
  );

  // Step 3 node graph: edit one video (mandatory source clip + prompt +
  // references). The source may be an explicit path (piped from the video
  // node or a generated clip), a video reference id, or the shot's current
  // video. Only providers with a video-edit path (Higgsfield CLI) can run it.
  handle("production:generateEditVideoNode", (_e, id: string, shotId: string, opts: { prompt?: string; model?: string; resolution?: string; sourcePath?: string; sourceRefId?: string; refIds?: string[]; params?: Record<string, string | number | boolean | string[]> }) =>
    runVideoJob(id, "editing a video (node graph)", async (p, emit) => {
      const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
      if (!shot) throw new Error("Shot not found.");
      const clean: VideoGenOptions = {
        model: typeof opts?.model === "string" && opts.model.trim() ? opts.model.trim() : "auto",
        resolution: typeof opts?.resolution === "string" && opts.resolution.trim() ? opts.resolution.trim() : "",
        durationSec: 0,
        prompt: typeof opts?.prompt === "string" ? opts.prompt.trim() : "",
        ...(opts?.params && typeof opts.params === "object" ? { params: opts.params } : {}),
      };
      if (!clean.prompt) throw new Error("Describe the edit first (e.g. \"replace the sky with a sunset\").");
      let sourcePath = typeof opts?.sourcePath === "string" && opts.sourcePath.trim() ? opts.sourcePath.trim() : undefined;
      if (!sourcePath && typeof opts?.sourceRefId === "string" && opts.sourceRefId) {
        const ref = (p.references ?? []).find((r) => r.id === opts.sourceRefId && r.media === "video");
        if (ref?.mediaPath) sourcePath = ref.mediaPath;
      }
      if (!sourcePath) sourcePath = shot.videoPath;
      if (!sourcePath) throw new Error("The edit-video node needs a source video — pipe a clip in, pick a video reference, or generate a clip first. Nothing was submitted.");
      const provider = mediaFor(clean.model);
      if (!provider.generateVideoEdit) {
        throw new Error(`${provider.displayName} can't edit videos yet — switch to a provider with a video-edit path (Higgsfield CLI).`);
      }
      // References ride the prompt node's @[name] tags and are resolved inside
      // the provider (like the video node) — no separate refIds arg.
      emit(`Shot ${shot.number}: editing the video${clean.model !== "auto" ? ` via ${clean.model}` : ""}…`);
      const { rel } = await provider.generateVideoEdit(p, shot, clean, emit, sourcePath);
      recordGraphEditVideoGen(shot, rel, clean.prompt, clean.model);
      if (shot.graphOutputSource === "editvideo") applyVideoOutput(shot, rel, sourcePath);
      emit(`Shot ${shot.number}: edited video ready.`, "done");
    })
  );

  /** Read a workspace-relative asset as an uploadable data URL (JPEG/PNG/WebP
   *  by extension), for feeding stored generations into image-input models. */
  function fileDataUrl(p: Production, rel: string): string | null {
    try {
      const buf = fs.readFileSync(assetPath(p, rel));
      const ext = (path.extname(rel).slice(1).toLowerCase() || "jpg").replace("jpeg", "jpg");
      const mime =
        ext === "jpg" ? "image/jpeg"
        : ext === "webp" ? "image/webp"
        : ext === "gif" ? "image/gif"
        : ext === "mp4" ? "video/mp4"
        : ext === "webm" ? "video/webm"
        : ext === "mov" ? "video/quicktime"
        : ext === "m4v" ? "video/x-m4v"
        : "image/png";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      return null;
    }
  }

  /** Resolve an in-betweener keyframe source id to its display name + image
   *  data URL. A generation-node sentinel resolves to that node's selected
   *  generation (`@imagegen` → the image node's selected frame, `@editgen` →
   *  the edit node's selected edit); anything else is a reference id looked
   *  up in characters, products, and custom image references — only entries
   *  with artwork can be keyframes. Returns null when the source is
   *  unresolvable. */
  function tweenKeyframeArtwork(p: Production, shot: ProductionShot, sourceId: string): { name: string; dataUrl: string } | null {
    if (sourceId === TWEEN_KEY_IMGGEN) {
      const g = shot.graphImageGens?.[shot.graphImageGenIndex ?? 0];
      const dataUrl = g?.path ? fileDataUrl(p, g.path) : null;
      return dataUrl ? { name: "Image-gen frame", dataUrl } : null;
    }
    const editNodeId = parseEditNodeKeyframe(sourceId);
    if (editNodeId) {
      const g = editNodeSelection(shot, editNodeId);
      const dataUrl = g?.path ? fileDataUrl(p, g.path) : null;
      return dataUrl ? { name: "Edit frame", dataUrl } : null;
    }
    const pool = [
      ...p.characters.map((c) => ({ id: c.id, name: c.name, artwork: refArtworkDataUrl(p, c) })),
      ...p.products.map((pr) => ({ id: pr.id, name: pr.name, artwork: refArtworkDataUrl(p, pr) })),
      ...(p.references ?? []).map((r) => ({ id: r.id, name: r.name, artwork: refArtworkDataUrl(p, r) })),
    ];
    const ref = pool.find((r) => r.id === sourceId);
    return ref?.artwork ? { name: ref.name, dataUrl: ref.artwork } : null;
  }

  // Step 3 in-betweener node: generate one action block's clip — a start→end
  // keyframe interpolation driven by the block's action prompt. Blocks are
  // re-derived from the wired keyframes on every call so a stale renderer save
  // can't submit phantom blocks; prompts and history survive via the pair-key
  // match in deriveTweenBlocks. The clip lands on the block's history — it
  // joins the continuous output only through production:stitchTween.
  handle("production:generateTweenBlock", (_e, id: string, shotId: string, blockId: string, opts: { model?: string; resolution?: string; durationSec?: number; params?: Record<string, string | number | boolean | string[]> }) =>
    runVideoJob(id, "generating an in-between", async (p, emit) => {
      const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
      if (!shot) throw new Error("Shot not found.");
      syncTweenBlocks(p, shot);
      const block = (shot.graphTweenBlocks ?? []).find((b) => b.id === blockId);
      if (!block) throw new Error("Action block not found — reconnect the keyframes and try again.");
      const prompt = block.prompt.trim();
      if (!prompt) throw new Error("Describe the action first (e.g. \"she turns toward the window, coat trailing\").");
      const start = tweenKeyframeArtwork(p, shot, block.startRefId);
      const end = tweenKeyframeArtwork(p, shot, block.endRefId);
      if (!start || !end) {
        const missing = !start && !end ? "start and end frames" : !start ? "start frame" : "end frame";
        throw new Error(`Block ${block.id}: missing ${missing} — pick references with artwork or generate a frame first. Nothing was submitted.`);
      }
      const clean: VideoGenOptions = {
        model: typeof opts?.model === "string" && opts.model.trim() ? opts.model.trim() : "auto",
        resolution: typeof opts?.resolution === "string" && opts.resolution.trim() ? opts.resolution.trim() : "1080p",
        durationSec: tweenClampGap(Number(opts?.durationSec) > 0 ? Number(opts.durationSec) : block.durationSec),
        prompt,
        ...(opts?.params && typeof opts.params === "object" ? { params: opts.params } : {}),
      };
      emit(`Shot ${shot.number}: in-betweening ${start.name} → ${end.name} (${clean.durationSec}s)${clean.model !== "auto" ? ` via ${clean.model}` : ""}…`);
      const { rel } = await mediaFor(clean.model).generateVideoClip(p, shot, clean, emit, undefined, [], { start, end });
      recordTweenBlockGen(block, rel, prompt, clean.model);
      emit(`Shot ${shot.number}: in-between ready — pick it in the block's dropdown to preview.`, "done");
    })
  );

  // Step 3 in-betweener node: stitch every action block's selected clip (in
  // timeline order) into one continuous clip for the frame output node and the
  // animatic. The concat demuxer with `-c copy` is lossless (no recompression)
  // when all block clips share a codec; when they differ the copy fails and we
  // fall back to a re-encoded preview stitch — flagged on
  // `graphTweenReencoded` — while the assembly package (Step 5) always lays
  // the ORIGINAL per-block clips back-to-back instead (see assemblyPlan).
  handle("production:stitchTween", (_e, id: string, shotId: string) =>
    runProductionJob(id, "stitching the in-between", async (p, emit) => {
      const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
      if (!shot) throw new Error("Shot not found.");
      syncTweenBlocks(p, shot);
      const blocks = shot.graphTweenBlocks ?? [];
      if (!blocks.length) throw new Error("Wire at least two keyframes into the in-betweener first.");
      const clips = tweenSelectedClips(blocks);
      if (clips.length < blocks.length) {
        const missing = blocks.filter((b) => !clips.some((c) => c.blockId === b.id)).map((b) => b.id).join(", ");
        throw new Error(`Generate every action block first — still missing: ${missing}.`);
      }
      const absPaths = clips.map((c) => assetPath(p, c.path));
      for (const [i, abs] of absPaths.entries()) {
        if (!fs.existsSync(abs)) throw new Error(`Block ${clips[i].blockId}: clip file is gone — regenerate it.`);
      }
      const bin = await resolveFfmpeg();
      if (!bin) throw new Error("No ffmpeg found — install it or keep previewing the per-block clips.");
      const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const rel = shotVideoRelPath(p, shot, "mp4", "tween");
      const absOut = assetPath(p, rel);
      fs.mkdirSync(assetPath(p, shotVideoDir(p, shot)), { recursive: true });
      const listPath = path.join(os.tmpdir(), `cascade-tween-${tag}.txt`);
      fs.writeFileSync(listPath, buildTweenConcatList(absPaths));
      try {
        try {
          await runFfmpeg(bin, ["-hide_banner", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", absOut], (m) => emit(m, "info"));
          shot.graphTweenReencoded = undefined;
          emit(`Shot ${shot.number}: stitched ${clips.length} blocks losslessly (no recompression).`, "info");
        } catch {
          emit("Block codecs differ — re-encoding the preview stitch (the assembly package still uses the original clips).", "info");
          await runFfmpeg(bin, ["-hide_banner", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", absOut], (m) => emit(m, "info"));
          shot.graphTweenReencoded = true;
        }
      } finally {
        try { fs.unlinkSync(listPath); } catch { /* temp file already gone */ }
      }
      if (shot.graphTweenOutput && shot.graphTweenOutput !== rel) {
        try { fs.unlinkSync(assetPath(p, shot.graphTweenOutput)); } catch { /* old stitch already gone */ }
      }
      shot.graphTweenOutput = rel;
      if (shot.graphOutputSource === "tween") applyVideoOutput(shot, rel);
      emit(`Shot ${shot.number}: continuous shot ready.`, "done");
    })
  );

  // Step 3 in-betweener node: undo a stitch — drop the continuous clip and,
  // when the tween feeds the output, unbind the feed. The per-block clips and
  // the timeline stay intact, so the user can view/edit and re-stitch.
  handle("production:unstitchTween", (_e, id: string, shotId: string): Production => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
    if (!shot) throw new Error("Shot not found.");
    const { changed, outputRel } = unstitchTween(shot);
    if (!changed) throw new Error("This shot isn't stitched — nothing to revert.");
    if (outputRel) {
      try { fs.unlinkSync(assetPath(p, outputRel)); } catch { /* old stitch already gone */ }
    }
    productions.saveProduction(p);
    productionEmit(id, `Shot ${shot.number}: stitch undone — back to the individual block clips.`, "done");
    return p;
  });

  // Step 3 node graph: AI-edit one image for a specific edit-image node. The
  // source image is that node's source pipe — a parent edit node's selection,
  // the image node's selection, or a reference's artwork — falling back to the
  // shot's current frame. The result is stored on the node; it becomes the
  // shot's artwork only when the node is piped to the output.
  handle("production:generateEditNode", (_e, id: string, shotId: string, opts: { nodeId?: string; prompt?: string; model?: string; resolution?: string; params?: Record<string, string | number | boolean | string[]> }) =>
    runProductionStep(id, 3, "editing an image (node graph)", async (p, emit) => {
      const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
      if (!shot) throw new Error("Shot not found.");
      const node = getEditNode(shot, opts?.nodeId);
      if (!node) throw new Error("Edit-image node not found — drag one onto the canvas first.");
      const text = typeof opts?.prompt === "string" ? opts.prompt.trim() : "";
      if (!text) throw new Error('Describe the edit first (e.g. "make it night, add rain").');
      const modelId = typeof opts?.model === "string" && opts.model.trim() && opts.model !== "auto" ? opts.model.trim() : undefined;
      const resolution = typeof opts?.resolution === "string" && opts.resolution.trim() ? opts.resolution.trim() : undefined;
      const editMedia = mediaFor(modelId);
      const gen = editMedia.imageGenFn(p, modelId, resolution, (m) => emit(m, "info"));
      if (!gen) throw new Error(`${editMedia.displayName} MCP isn't connected, so frames can't be edited in-app.`);
      // Source: the node's own pipe (parent edit / image node / reference),
      // then the shot's current frame.
      const source = node.source;
      let dataUrl: string | undefined;
      let sourceName = `Shot ${shot.number} frame`;
      if (source?.kind === "imagegen") {
        const src = shot.graphImageGens?.[shot.graphImageGenIndex ?? 0]?.path;
        if (src) {
          dataUrl = fileDataUrl(p, src) ?? undefined;
          if (dataUrl) sourceName = "Piped frame";
        }
      } else if (source?.kind === "editgen") {
        const sel = editNodeSelection(shot, source.nodeId);
        if (sel?.path) {
          dataUrl = fileDataUrl(p, sel.path) ?? undefined;
          if (dataUrl) sourceName = "Piped edit";
        }
      } else if (source?.kind === "ref") {
        const pool = [
          ...p.characters.map((c) => ({ id: c.id, name: c.name, artwork: refArtworkDataUrl(p, c) })),
          ...p.products.map((pr) => ({ id: pr.id, name: pr.name, artwork: refArtworkDataUrl(p, pr) })),
          ...(p.references ?? []).map((r) => ({ id: r.id, name: r.name, artwork: refArtworkDataUrl(p, r) })),
        ];
        const ref = pool.find((r) => r.id === source.refId);
        if (ref?.artwork) {
          dataUrl = ref.artwork;
          sourceName = ref.name;
        }
      }
      if (!dataUrl && shot.artwork) {
        dataUrl = fileDataUrl(p, shot.artwork) ?? undefined;
      }
      if (!dataUrl) throw new Error("No source image — pipe a frame or reference into the edit node, or generate a frame first.");
      // Resolve @[name] tags in the edit text against the production's artwork,
      // so the references cited in the edit-prompt node are uploaded alongside
      // the source. The source occupies @image1 (token 0), so tags start at 1.
      const { resolved: editText, extras } = resolvePromptRefs(p, text, 1);
      emit(`Shot ${shot.number}: editing ${sourceName}${modelId ? ` via ${modelId}` : ""}${extras.length ? ` (+${extras.length} reference${extras.length === 1 ? "" : "s"})` : ""}…`);
      const png = await gen(
        buildEditGenPrompt(editText),
        [{ name: sourceName, dataUrl }, ...extras],
        shot,
        opts?.params
      );
      const { jpegRel } = writeBoardFrame(p, shot, png, "png");
      node.prompt = text;
      recordGraphEditGen(shot, node.id, jpegRel, text, modelId ?? "auto");
      syncBoardOutputToPipe(shot);
      emit(`Shot ${shot.number}: node edit ready.`, "done");
    }, { needsApiKey: false })
  );

  // Step 3 node graph: make a generation node's selected output the shot's
  // primary output — artwork for frames, videoPath for clips.
  handle("production:applyGraphOutput", (_e, id: string, shotId: string, opts: { kind?: string; path?: string }): Production => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
    if (!shot) throw new Error("Shot not found.");
    const rel = typeof opts?.path === "string" ? opts.path.trim() : "";
    if (!rel) throw new Error("No output selected — generate something first.");
    if (opts?.kind === "video") applyVideoOutput(shot, rel);
    else selectBoardFrame(shot, rel);
    productions.saveProduction(p);
    productionEmit(id, `Shot ${shot.number}: node output applied (${opts?.kind === "video" ? "video" : "frame"}).`);
    return p;
  });

  /** Decode a `data:<mime>;base64,<payload>` URL into raw bytes. */
  function dataUrlToBuffer(dataUrl: string): Buffer | null {
    const bytes = dataUrlToBytes(dataUrl);
    return bytes ? Buffer.from(bytes) : null;
  }

  // Step 3 node graph: apply a reference piped into the frame output as the
  // shot's primary output. Image refs (inline data-URL artwork) are written to
  // the boards dir like any other frame; video refs become the shot's videoPath.
  handle("production:applyGraphRefOutput", (_e, id: string, shotId: string, refId: string): Production => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
    if (!shot) throw new Error("Shot not found.");
    const ref = [
      ...p.characters.map((c) => ({ id: c.id, imagePath: c.imagePath, artwork: c.artwork, media: undefined as string | undefined, mediaPath: undefined as string | undefined })),
      ...p.products.map((pr) => ({ id: pr.id, imagePath: pr.imagePath, artwork: pr.artwork, media: undefined as string | undefined, mediaPath: undefined as string | undefined })),
      ...(p.references ?? []).map((r) => ({ id: r.id, imagePath: r.imagePath, artwork: r.artwork, media: r.media, mediaPath: r.mediaPath })),
    ].find((r) => r.id === refId);
    if (!ref) throw new Error("Reference not found.");
    if (ref.media === "video" && ref.mediaPath) {
      shot.videoPath = ref.mediaPath;
      productions.saveProduction(p);
      productionEmit(id, `Shot ${shot.number}: reference video applied to the output.`, "done");
      return p;
    }
    // Image refs live on disk (imagePath) — read the bytes (legacy inline data
    // URLs fall back).
    const bytes = ref.imagePath ? (() => { try { return fs.readFileSync(assetPath(p, ref.imagePath!)); } catch { return null; } })() : ref.artwork ? dataUrlToBuffer(ref.artwork) : null;
    if (!bytes || !bytes.length) throw new Error("This reference has no usable image — only image and video references can feed the output.");
    const { jpegRel } = writeBoardFrame(p, shot, bytes, "png");
    recordBoardArtwork(shot, jpegRel);
    productions.saveProduction(p);
    productionEmit(id, `Shot ${shot.number}: reference image applied to the output.`, "done");
    return p;
  });


  handle("production:removeVideo", (_e, id: string, shotId: string): Production => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
    if (!shot) throw new Error("Shot not found.");
    if (shot.videoPath) {
      try { fs.unlinkSync(assetPath(p, shot.videoPath)); } catch { /* missing file is already removed */ }
      delete shot.videoPath;
      productions.saveProduction(p);
      productionEmit(id, `Shot ${shot.number}: video removed.`);
    }
    return p;
  });

  // Per-model video options for the generation modal/node: read the model's
  // live form schema and pull out the resolution / duration choices it
  // actually accepts. Mode-aware — image-to-video and text-to-video forms
  // declare different option sets, so the caller says which one it needs.
  // Cached per model+mode (warmed when the OpenArt models are listed) so
  // repeated lookups are instant. Null when the form can't be read — the
  // caller falls back to a generic set.
  handle("production:videoModelOptions", async (_e, modelId: string, withImage?: boolean): Promise<VideoModelOptions | null> => {
    return mediaFor(String(modelId ?? "")).videoModelOptions(String(modelId ?? ""), withImage === true);
  });

  handle("production:imageModelOptions", async (_e, modelId: string): Promise<ImageModelOptions | null> => {
    return mediaFor(String(modelId ?? "")).imageModelOptions(String(modelId ?? ""));
  });

  // Live per-config credit quote (Higgsfield CLI `generate cost` preflight).
  // Providers without a cost surface resolve null with zero spawns; every
  // failure is swallowed to null — the quote is advisory and never blocks
  // submit.
  handle("production:generationCost", async (_e, req: GenerationCostRequest): Promise<number | null> => {
    try {
      const model = String(req?.model ?? "");
      return (await mediaFor(model).getGenerationCost?.(req)) ?? null;
    } catch {
      return null;
    }
  });

  // Full normalized option schema for a model (live `model get` detail).
  // Optional provider capability — providers without a schema surface
  // resolve null and the renderer falls back to the ladder channels above.
  handle("production:modelOptions", async (_e, modelId: string): Promise<CliModelSchema | null> => {
    const id = String(modelId ?? "");
    const schema = (await mediaFor(id).modelOptions?.(id)) ?? null;
    // Apply the dev Model Customizer's per-parameter placements so every
    // options form follows the user (dedicated/media fields are locked).
    return schema ? applyOptionExposure(schema, id, settings.getModelOptionExposure()) : null;
  });

  // Dev Model Customizer: probe one provider's catalog (read-only). Returns
  // the namespaced choices plus the user's hidden/kind/end-frame state; each
  // model's option schema is fetched lazily by `modelCustomizer:probeOptions`.
  handle("modelCustomizer:probeModels", async (_e, providerId: string): Promise<ModelProbeResult> => {
    const id = resolveProviderId(providerId);
    const provider = providers[id];
    const base: ModelProbeResult = {
      provider: id,
      displayName: PROVIDER_META[id].displayName,
      available: false,
      models: [],
    };
    try {
      base.available = provider.isAvailable();
    } catch {
      base.available = false;
    }
    if (!base.available) {
      base.error = `${PROVIDER_META[id].displayName} isn't available (not connected / not installed).`;
      return base;
    }
    try {
      const overrides = settings.getModelKindOverrides();
      const choices = applyKindOverrides(await provider.listModelChoices(), overrides);
      const hidden = new Set(settings.getHiddenMediaModels());
      const sorted = sortByModelOrder(choices, settings.getMediaModelOrder(), (c) => c.id);
      base.models = sorted.map((choice) => ({
        choice,
        hidden: hidden.has(choice.id),
        kindOverride: overrides[choice.id],
      }));
    } catch (e) {
      base.error = String(e).replace(/^Error:\s*/, "");
    }
    return base;
  });

  handle("modelCustomizer:probeOptions", async (_e, providerId: string, modelId: string): Promise<CliModelSchema | null> => {
    const id = resolveProviderId(providerId);
    const provider = providers[id];
    return (await provider.modelOptions?.(String(modelId ?? ""))) ?? null;
  });

  handle("modelCustomizer:refresh", (_e, providerId?: string) => {
    if (providerId) {
      providers[resolveProviderId(providerId)].refreshProbes?.();
      return;
    }
    for (const pid of PROVIDER_IDS) providers[pid].refreshProbes?.();
  });

  // Higgsfield credit value ($/credit) for the Expenses total. Saving
  // re-prices history so the total follows the rate (credit rows keep their
  // credits — the rate is recomputable, like the $ rules).
  handle("modelCustomizer:getCreditRate", async (): Promise<number | null> => settings.getHiggsfieldCreditUsd());
  handle("modelCustomizer:setCreditRate", async (_e, v: number | null): Promise<number | null> => {
    const rate = settings.setHiggsfieldCreditUsd(v);
    ledger.repriceAll(rate);
    return rate;
  });

  // Step 3 in-betweener: which video models accept a dedicated end-frame
  // slot. The live probe is unioned with the models the user explicitly
  // assigned to the in-betweener surface (that assignment IS their capability
  // declaration). Hidden models and models classified as image are excluded.
  handle("production:videoEndFrameModels", async (): Promise<string[]> => {
    let proven: string[] = [];
    try {
      proven = await media().videoEndFrameModels();
    } catch {
      proven = [];
    }
    const hidden = new Set(settings.getHiddenMediaModels());
    const kinds = settings.getModelKindOverrides();
    const declared = Object.entries(settings.getModelSurfaces())
      .filter(([, list]) => list.includes("video:tween"))
      .map(([id]) => id);
    const out = [...new Set([...proven, ...declared])];
    return out.filter((id) => !hidden.has(id) && kinds[id] !== "image");
  });

  // Step 3 edit-video node: which video models accept a video input. Empty
  // for providers with no video-edit path (the node then offers nothing).
  handle("production:videoEditModels", async (): Promise<string[]> => {
    try {
      const proven = await media().videoEditModels?.();
      if (!proven) return [];
      const hidden = new Set(settings.getHiddenMediaModels());
      const kinds = settings.getModelKindOverrides();
      return proven.filter((id) => !hidden.has(id) && kinds[id] !== "image");
    } catch {
      return [];
    }
  });

  // Step 3 per-frame edit (classic storyboard view): appends a new edit-image
  // node to the shot's graph, chained from whatever currently feeds the output
  // (the previous edit node, the image node, or a reference), then pipes the
  // result to the output — so the node view shows the full daisy chain
  // afterwards. The previous frame moves into the shot's history (arrows).
  handle("production:editBoard", (_e, id: string, shotId: string, model: string, prompt: string, params?: Record<string, string | number | boolean | string[]>, resolution?: string) =>
    runProductionStep(id, 3, "editing one board", async (p, emit) => {
      const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
      if (!shot) throw new Error("Shot not found.");
      const text = typeof prompt === "string" ? prompt.trim() : "";
      if (!text) throw new Error('Describe the edit first (e.g. "make it night, add rain").');
      const modelId = typeof model === "string" && model.trim() && model !== "auto" ? model.trim() : undefined;
      const resolutionOverride = typeof resolution === "string" && resolution.trim() ? resolution.trim() : undefined;
      // Schema-driven model options from the classic dialog (variant, seed,
      // …). Sanitized to scalars — the provider ignores unknown keys for the
      // active model, so a stale pick never leaks into another model's submit.
      const editParams = sanitizeGenParams(params) as GenParams | undefined;
      const editMedia = mediaFor(modelId);
      const gen = editMedia.imageGenFn(p, modelId, resolutionOverride, (m) => emit(m, "info"));
      if (!gen) throw new Error(`${editMedia.displayName} MCP isn't connected (no image-generation tool found), so frames can't be edited in-app.`);
      // Create the node up front so the generation rides the same pipe the node
      // view will show: chained from the output edit node / image node / ref.
      const node = newEditNode(shot, text, chainSourceForEdit(shot));
      const source = node.source;
      let dataUrl: string | undefined;
      let sourceName = `Shot ${shot.number} frame`;
      if (source?.kind === "imagegen") {
        const src = shot.graphImageGens?.[shot.graphImageGenIndex ?? 0]?.path;
        if (src) {
          dataUrl = fileDataUrl(p, src) ?? undefined;
          if (dataUrl) sourceName = "Piped frame";
        }
      } else if (source?.kind === "editgen") {
        const sel = editNodeSelection(shot, source.nodeId);
        if (sel?.path) {
          dataUrl = fileDataUrl(p, sel.path) ?? undefined;
          if (dataUrl) sourceName = "Piped edit";
        }
      } else if (source?.kind === "ref") {
        const pool = [
          ...p.characters.map((c) => ({ id: c.id, name: c.name, artwork: refArtworkDataUrl(p, c) })),
          ...p.products.map((pr) => ({ id: pr.id, name: pr.name, artwork: refArtworkDataUrl(p, pr) })),
          ...(p.references ?? []).map((r) => ({ id: r.id, name: r.name, artwork: refArtworkDataUrl(p, r) })),
        ];
        const ref = pool.find((r) => r.id === source.refId);
        if (ref?.artwork) {
          dataUrl = ref.artwork;
          sourceName = ref.name;
        }
      }
      if (!dataUrl && shot.artwork) {
        dataUrl = fileDataUrl(p, shot.artwork) ?? undefined;
      }
      if (!dataUrl) throw new Error("Generate or import a frame for this shot first - there's nothing to edit.");
      emit(`Shot ${shot.number}: editing ${sourceName}${modelId ? ` via ${modelId}` : ""}...`);
      // Resolve @[name] tags in the edit text against the production's artwork
      // so the cited references are uploaded alongside the frame. The frame
      // occupies @image1 (token 0), so tags start at 1.
      const { resolved: editText, extras } = resolvePromptRefs(p, text, 1);
      const png = await gen(
        buildEditGenPrompt(editText),
        [{ name: sourceName, dataUrl }, ...extras],
        shot,
        editParams
      );
      const { jpegRel } = writeBoardFrame(p, shot, png, "png");
      recordBoardEdit(shot, jpegRel, text, modelId ?? "auto", node, editParams, resolutionOverride);
      productionEmit(id, `Shot ${shot.number}: frame edited.`);
    }, { needsApiKey: false })
  );

  // Step 4: animatic timing (one bounded LLM call).
  handle("production:planAnimatic", (_e, id: string) =>
    runProductionStep(id, 4, "animatic timing", async (p, emit) => {
      await planAnimatic(p, settings.getApiKey()!, settings.getModel(), emit, settings.getBaseUrl());
    })
  );

  // Step 4: native voiceover picker. Copies the chosen file into
  // voiceoverDir and stores the relative path on the production.
  handle("production:importVoiceover", async (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (!p) return null;
    const res = await dialog.showOpenDialog(win!, {
      title: "Choose a voiceover clip",
      properties: ["openFile"],
      filters: [
        { name: "Audio", extensions: ["mp3", "wav", "m4a", "aac", "ogg", "flac"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const src = res.filePaths[0];
    const ext = (path.extname(src).slice(1).toLowerCase() || "mp3").replace("mpeg", "mp3");
    if (!["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) {
      throw new Error(`Unsupported audio format: .${ext}`);
    }
    fs.mkdirSync(assetPath(p, p.assets.voiceoverDir), { recursive: true });
    // Preserve the original filename (unlike the generated clip, which uses a
    // stable voiceover.mp3 name). Renaming imports is surprising — keep the
    // user's file as-is inside the voiceover folder.
    let rel = `${p.assets.voiceoverDir}/${path.basename(src)}`;
    if (fs.existsSync(assetPath(p, rel)) && p.voiceoverPath !== rel) {
      const parsed = path.parse(path.basename(src));
      let i = 2;
      while (fs.existsSync(assetPath(p, `${p.assets.voiceoverDir}/${parsed.name} (${i})${parsed.ext}`))) i++;
      rel = `${p.assets.voiceoverDir}/${parsed.name} (${i})${parsed.ext}`;
    }
    // Replace: archive the previous clip before it gets replaced. Unconditional
    // because the new file may land on the same path as the current clip
    // (e.g. re-importing a file whose name matches the generated voiceover.mp3).
    if (p.voiceoverPath) {
      archiveAsset(p, p.voiceoverPath);
    }
    fs.copyFileSync(src, assetPath(p, rel));
    p.voiceoverPath = rel;
    if (typeof p.voiceoverVolume !== "number") p.voiceoverVolume = 1;
    productions.saveProduction(p);
    productionEmit(id, `Imported voiceover → ${rel}.`);
    return p;
  });

  // Step 4: read the production's voiceover clip as a data URL (used by the
  // inline <audio>, the waveform, and the AudioContext playback source).
  handle("production:voiceoverFile", (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (!p?.voiceoverPath) return null;
    try {
      const buf = fs.readFileSync(assetPath(p, p.voiceoverPath));
      const ext = (path.extname(p.voiceoverPath).slice(1).toLowerCase() || "mp3").replace("mpeg", "mp3");
      const mime = ext === "wav" ? "audio/wav" : ext === "m4a" || ext === "aac" ? "audio/mp4" : ext === "ogg" ? "audio/ogg" : ext === "flac" ? "audio/flac" : "audio/mpeg";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      return null;
    }
  });

  // Step 4: streamable protocol URL for the voiceover clip. The renderer
  // prefers this over the base64 data URL — it bypasses data-URL length
  // limits and lets <audio>/AudioContext fetch real bytes with range support.
  handle("production:voiceoverUrl", (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (!p?.voiceoverPath) return null;
    return `cascade-media://${p.meta.id}/${encodeURIComponent(p.voiceoverPath)}`;
  });

  // Step 4: remove the imported/generated voiceover (archive the file + clear path).
  handle("production:removeVoiceover", (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (p.voiceoverPath) {
      archiveAsset(p, p.voiceoverPath);
      p.voiceoverPath = undefined;
      productions.saveProduction(p);
      productionEmit(id, "Removed voiceover (kept in archive).");
    }
    return p;
  });

  // Step 4: native music picker. Copies the chosen file into the production's
  // musicDir and stores the relative path on the production.
  handle("production:importMusic", async (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (!p) return null;
    const res = await dialog.showOpenDialog(win!, {
      title: "Choose a music track",
      properties: ["openFile"],
      filters: [
        { name: "Audio", extensions: ["mp3", "wav", "m4a", "aac", "ogg", "flac"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const src = res.filePaths[0];
    const ext = (path.extname(src).slice(1).toLowerCase() || "mp3").replace("mpeg", "mp3");
    if (!["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) {
      throw new Error(`Unsupported audio format: .${ext}`);
    }
    fs.mkdirSync(assetPath(p, p.assets.musicDir), { recursive: true });
    // Preserve the original filename — don't rename imported music.
    let rel = `${p.assets.musicDir}/${path.basename(src)}`;
    if (fs.existsSync(assetPath(p, rel)) && p.musicPath !== rel) {
      const parsed = path.parse(path.basename(src));
      let i = 2;
      while (fs.existsSync(assetPath(p, `${p.assets.musicDir}/${parsed.name} (${i})${parsed.ext}`))) i++;
      rel = `${p.assets.musicDir}/${parsed.name} (${i})${parsed.ext}`;
    }
    // Replace: archive the previous track before it gets replaced (also covers
    // an import landing on the current clip's path).
    if (p.musicPath) {
      archiveAsset(p, p.musicPath);
    }
    fs.copyFileSync(src, assetPath(p, rel));
    p.musicPath = rel;
    if (typeof p.musicVolume !== "number") p.musicVolume = 0.5;
    productions.saveProduction(p);
    productionEmit(id, `Imported music → ${rel}.`);
    return p;
  });

  // Step 3 node graph: save a dropped video/audio file into the production's
  // referencesDir (on disk — media never rides the JSON as a data URL).
  // Preserves the original filename; collision-handled like the music import.
  handle("production:addReferenceMedia", (_e, id: string, fileName: string, mime: string, bytes: ArrayBuffer) => {
    const p = productions.loadProduction(id);
    if (!p) return null;
    const kind = mime.startsWith("video/") ? "video" as const : mime.startsWith("audio/") ? "audio" as const : null;
    if (!kind) throw new Error(`Unsupported reference media type: ${mime || "unknown"}`);
    const base = path.basename(String(fileName || "clip")).trim() || "clip";
    const parsed = path.parse(base);
    const dir = p.assets.referencesDir;
    fs.mkdirSync(assetPath(p, dir), { recursive: true });
    let rel = `${dir}/${base}`;
    let i = 2;
    while (fs.existsSync(assetPath(p, rel))) {
      rel = `${dir}/${parsed.name} (${i})${parsed.ext}`;
      i++;
    }
    fs.writeFileSync(assetPath(p, rel), Buffer.from(bytes));
    productionEmit(id, `Added ${kind} reference → ${rel}.`);
    return { path: rel, kind };
  });

  // Step 2/3: save a reference image (inline data URL) into the production's
  // referencesDir on disk and return its workspace-relative path. Image
  // references stop riding the JSON as data URLs; the file keeps the original
  // extension (derived from the MIME) and is collision-handled like media.
  handle("production:addReferenceImage", (_e, id: string, fileName: string, dataUrl: string): { path: string } | null => {
    const p = productions.loadProduction(id);
    if (!p) return null;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) throw new Error("Not a data-URL image.");
    const comma = dataUrl.indexOf(",");
    if (comma === -1) throw new Error("Not a data-URL image.");
    const mime = dataUrl.slice(5, comma).split(";")[0];
    const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";
    let buf: Buffer;
    try { buf = Buffer.from(dataUrl.slice(comma + 1), "base64"); } catch { throw new Error("Couldn't decode the image."); }
    if (!buf.length) throw new Error("The image is empty.");
    const base = path.basename(String(fileName ?? "reference")).replace(/\.[^.]+$/, "").trim() || "reference";
    const dir = p.assets.referencesDir;
    fs.mkdirSync(assetPath(p, dir), { recursive: true });
    let rel = `${dir}/${base}.${ext}`;
    let i = 2;
    while (fs.existsSync(assetPath(p, rel))) {
      rel = `${dir}/${base} (${i}).${ext}`;
      i++;
    }
    fs.writeFileSync(assetPath(p, rel), buf);
    productionEmit(id, `Added image reference → ${rel}.`);
    return { path: rel };
  });

  // Step 2: generate (or AI-edit) a reference image via OpenArt. Generation
  // adds a brand-new reference (named by opts.name) into the given category;
  // editing (opts.sourceRefId) replaces that reference's image in place. The
  // finished image is written into referencesDir and the reference points at
  // the on-disk file — references never ride the JSON as data URLs.
  handle("production:generateReferenceImage", (_e, id: string, opts: ReferenceImageGenOptions) =>
    runProductionJob(id, "generating a reference image", async (p, emit) => {
      const text = typeof opts?.prompt === "string" ? opts.prompt.trim() : "";
      if (!text) throw new Error('Describe what to generate or edit first (e.g. "a red gondola interior, moody light").');
      const modelId = typeof opts?.model === "string" && opts.model.trim() && opts.model !== "auto" ? opts.model.trim() : undefined;
      const resolution = typeof opts?.resolution === "string" && opts.resolution.trim() ? opts.resolution.trim() : undefined;
      const aspectRatio: ReferenceImageGenOptions["aspectRatio"] = opts?.aspectRatio === "1:1" || opts?.aspectRatio === "4:3" ? opts.aspectRatio : "16:9";
      const refMedia = mediaFor(modelId);
      const gen = refMedia.imageGenFn(p, modelId, resolution, (m) => emit(m, "info"), aspectRatio);
      if (!gen) throw new Error(`${refMedia.displayName} MCP isn't connected (no image-generation tool found), so references can't be generated in-app.`);

      // Editing: the source reference's current image is uploaded as the
      // visual reference (occupies @image1); @[name] tags in the edit text add
      // more, so tags start at token 1. Generation has no fixed source.
      let sourceRef: CustomRef | undefined;
      if (typeof opts?.sourceRefId === "string" && opts.sourceRefId) {
        sourceRef = (p.references ?? []).find((r) => r.id === opts.sourceRefId);
        if (!sourceRef) throw new Error("The reference to edit wasn't found.");
      }
      const sourceDataUrl = sourceRef ? refArtworkDataUrl(p, sourceRef) : undefined;
      if (sourceRef && !sourceDataUrl) throw new Error("This reference has no image to edit — attach or generate one first.");

      let promptText: string;
      let refs: { name: string; dataUrl: string }[];
      if (sourceRef) {
        const { resolved, extras } = resolvePromptRefs(p, text, 1);
        promptText = buildEditGenPrompt(resolved);
        refs = [{ name: sourceRef.name, dataUrl: sourceDataUrl! }, ...extras];
      } else {
        const { resolved, extras } = resolvePromptRefs(p, text, 0);
        promptText = resolved;
        refs = extras;
      }

      emit(`${sourceRef ? `Editing reference "${sourceRef.name}"` : "Generating a reference image"}${modelId ? ` via ${modelId}` : ""} (${aspectRatio})…`);
      const buf = await gen(promptText, refs, undefined, opts?.params);

      const base = (sourceRef?.name ?? (typeof opts?.name === "string" && opts.name.trim() ? opts.name.trim() : "Generated reference"))
        .replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "reference";
      const dir = p.assets.referencesDir;
      fs.mkdirSync(assetPath(p, dir), { recursive: true });
      const ext = buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP" ? "webp"
        : buf[0] === 0xff && buf[1] === 0xd8 ? "jpg"
        : "png";
      let rel = `${dir}/${base}.${ext}`;
      let i = 2;
      while (fs.existsSync(assetPath(p, rel))) {
        rel = `${dir}/${base} (${i}).${ext}`;
        i++;
      }
      fs.writeFileSync(assetPath(p, rel), buf);

      if (sourceRef) {
        if (sourceRef.imagePath && sourceRef.imagePath !== rel) {
          try { fs.unlinkSync(assetPath(p, sourceRef.imagePath)); } catch { /* old file already gone */ }
        }
        sourceRef.imagePath = rel;
        sourceRef.artwork = undefined;
        emit(`Reference "${sourceRef.name}" edited → ${rel}.`, "done");
      } else {
        p.references = [...(p.references ?? []), {
          id: `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          name: base,
          imagePath: rel,
          categoryId: typeof opts?.categoryId === "string" && opts.categoryId ? opts.categoryId : undefined,
          shotIds: [],
        }];
        emit(`Added reference "${base}" → ${rel}.`, "done");
      }
    })
  );

  // Step 2 character builder: generate a character-sheet reference image via
  // OpenArt and attach it to a character reference — creating the character
  // when one with that name doesn't exist yet. The prompt is the user's
  // description wrapped in the always-on character-sheet framing (full body
  // shot + face-closeup inset, front or front + back view, neutral pose /
  // expression / lighting on a plain gray background) built by
  // characterSheetPrompt() in pipeline.ts. The finished sheet is written into
  // referencesDir and the character points at the on-disk file.
  handle("production:generateCharacterSheet", (_e, id: string, opts: CharacterSheetGenOptions) =>
    runProductionJob(id, "generating a character reference", async (p, emit) => {
      const name = typeof opts?.name === "string" ? opts.name.trim() : "";
      const description = typeof opts?.description === "string" ? opts.description.trim() : "";
      if (!name) throw new Error('Give the character a name first (e.g. "Captain Mara").');
      if (!description) throw new Error('Describe the character first (e.g. "a scarred space smuggler in a worn leather jacket").');
      const view: CharacterSheetView = opts?.view === "front-back" ? "front-back" : "front";
      const modelId = typeof opts?.model === "string" && opts.model.trim() && opts.model !== "auto" ? opts.model.trim() : undefined;
      const resolution = typeof opts?.resolution === "string" && opts.resolution.trim() ? opts.resolution.trim() : undefined;
      // Character sheets are always 16:9, whatever the view layout.
      const sheetMedia = mediaFor(modelId);
      const gen = sheetMedia.imageGenFn(p, modelId, resolution, (m) => emit(m, "info"), "16:9");
      if (!gen) throw new Error(`${sheetMedia.displayName} MCP isn't connected (no image-generation tool found), so character sheets can't be generated in-app.`);

      const promptText = characterSheetPrompt(description, view);
      emit(`Generating character "${name}" (${view === "front-back" ? "front + back + inset" : "front + inset"}, 16:9)${modelId ? ` via ${modelId}` : ""}…`);
      const buf = await gen(promptText, [], undefined, sanitizeGenParams(opts?.params));

      const base = name.replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "character";
      const dir = p.assets.referencesDir;
      fs.mkdirSync(assetPath(p, dir), { recursive: true });
      const ext = buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP" ? "webp"
        : buf[0] === 0xff && buf[1] === 0xd8 ? "jpg"
        : "png";
      let rel = `${dir}/${base}.${ext}`;
      let i = 2;
      while (fs.existsSync(assetPath(p, rel))) {
        rel = `${dir}/${base} (${i}).${ext}`;
        i++;
      }
      fs.writeFileSync(assetPath(p, rel), buf);

      const existing = p.characters.find((c) => c.name.toLowerCase() === name.toLowerCase());
      const sheetParams = sanitizeGenParams(opts?.params);
      const builder: CharacterSheetBuilder = {
        description,
        view,
        model: typeof opts?.model === "string" && opts.model ? opts.model : "auto",
        resolution: typeof opts?.resolution === "string" && opts.resolution ? opts.resolution : "1k",
        ...(sheetParams ? { params: sheetParams } : {}),
      };
      // Old files replaced by this generation (the character and its mirrored
      // reference usually share one file) — deleted after both point at rel.
      const stale: string[] = [];
      if (existing?.imagePath && existing.imagePath !== rel) stale.push(existing.imagePath);
      const oldRef = (p.references ?? []).find((r) => r.name.toLowerCase() === name.toLowerCase());
      if (oldRef?.imagePath && oldRef.imagePath !== rel) stale.push(oldRef.imagePath);
      if (existing) {
        existing.imagePath = rel;
        existing.artwork = undefined;
        existing.builder = builder;
        emit(`Character "${name}" reference sheet ready → ${rel}.`, "done");
      } else {
        p.characters = [...p.characters, {
          id: `char-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          name,
          key: "",
          imagePath: rel,
          builder,
        }];
        emit(`Added character "${name}" → ${rel}.`, "done");
      }
      // Mirror the sheet into the references panel's "Characters" category so
      // it's manageable there and citable as @[name]. The character and its
      // reference point at the same on-disk file.
      upsertCharacterSheetRef(p, name, rel);
      for (const oldRel of new Set(stale)) {
        try { fs.unlinkSync(assetPath(p, oldRel)); } catch { /* old file already gone */ }
      }
    })
  );

  // Delete a reference's on-disk file (image or media) when the reference is
  // removed, so referencesDir doesn't accumulate orphans.
  handle("production:removeReferenceFile", (_e, id: string, rel: string): void => {
    const p = productions.loadProduction(id);
    if (!p) return;
    if (typeof rel !== "string" || !rel) return;
    try { fs.unlinkSync(assetPath(p, rel)); } catch { /* missing file is already gone */ }
  });

  // Step 2: rescan referencesDir — adopt images the user dropped into the
  // folder externally. Every image file no reference/character/product claims
  // becomes a reference (name from the filename); a same-name reference with
  // no image is filled in instead of duplicated.
  handle("production:scanReferencesFolder", (_e, id: string): Production | null => {
    const p = productions.loadProduction(id);
    if (!p) return null;
    const dir = p.assets.referencesDir;
    const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;
    let rels: string[] = [];
    try {
      rels = fs.readdirSync(assetPath(p, dir))
        .filter((f) => IMAGE_FILE.test(f))
        .map((f) => `${dir}/${f}`);
    } catch { /* missing folder — nothing to adopt */ }
    const orphans = productions.unclaimedReferenceFiles(rels, p);
    for (const rel of orphans) {
      const name = path.basename(rel).replace(/\.[^.]+$/, "").replace(/\s+/g, " ").trim() || "Reference";
      const empty = (p.references ?? []).find((r) => !r.imagePath && r.name.trim().toLowerCase() === name.toLowerCase());
      if (empty) {
        empty.imagePath = rel;
        empty.artwork = undefined;
      } else {
        p.references = [...(p.references ?? []), {
          id: `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          name,
          imagePath: rel,
          shotIds: [],
        }];
      }
    }
    if (orphans.length > 0) {
      productions.saveProduction(p);
      productionEmit(id, `Rescanned ${dir}/ — adopted ${orphans.length} reference image${orphans.length === 1 ? "" : "s"}.`, "done");
    } else {
      productionEmit(id, `Rescanned ${dir}/ — no new reference images.`);
    }
    return p;
  });

  // Step 4: read the imported music file as a data URL (for the inline
  // player and the animatic AudioContext source).
  handle("production:musicFile", (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (!p?.musicPath) return null;
    try {
      const buf = fs.readFileSync(assetPath(p, p.musicPath));
      const ext = (path.extname(p.musicPath).slice(1).toLowerCase() || "mp3").replace("mpeg", "mp3");
      const mime = ext === "wav" ? "audio/wav" : ext === "m4a" || ext === "aac" ? "audio/mp4" : ext === "ogg" ? "audio/ogg" : ext === "flac" ? "audio/flac" : "audio/mpeg";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      return null;
    }
  });

  handle("production:musicUrl", (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (!p?.musicPath) return null;
    return `cascade-media://${p.meta.id}/${encodeURIComponent(p.musicPath)}`;
  });

  // Step 4: remove the imported music (archive the file + clears musicPath).
  handle("production:removeMusic", (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (p.musicPath) {
      archiveAsset(p, p.musicPath);
      p.musicPath = undefined;
      productions.saveProduction(p);
      productionEmit(id, "Removed music (kept in archive).");
    }
    return p;
  });

  // Step 5: gather all full-res frames + clips + audio into the export folder
  // and write the EDL / After Effects script / manifest. Fast (no render);
  // marks the Assembly step done.
  handle("production:assemblyBuild", (_e, id: string, cfg?: { fps?: number; width?: number; height?: number }) => {
    return runProductionStep(
      id,
      5,
      "Build assembly package",
      async (p, emit) => {
        await assemble(p, cfg, emit, { ffmpegBin: await resolveFfmpeg(), probe: probeMedia });
        p.status[5] = "done";
      },
      { needsApiKey: false }
    );
  });

  // Step 5: render the assembled timeline to render.mp4 via the 3-pass ffmpeg
  // pipeline. Requires an ffmpeg binary (bundled ffmpeg-static, else PATH).
  handle("production:assemblyRender", (_e, id: string) => {
    return runProductionJob(id, "Render animatic to MP4", async (p, emit) => {
      const bin = await resolveFfmpeg();
      if (!bin) {
        throw new Error(
          "No ffmpeg available. Install ffmpeg on your system (or bundle ffmpeg-static) to render the animatic to MP4."
        );
      }
      p.status[5] = "running";
      try {
        const renderRel = await renderAnimatic(p, undefined, emit, { bin, runFfmpeg, probe: probeMedia });
        p.assembly ??= { fps: 24, width: 1920, height: 1080, exportDir: `${p.assets.outDir}/${p.assets.assemblyDir}` };
        p.assembly.renderPath = renderRel;
        p.assembly.renderedAt = new Date().toISOString();
        p.status[5] = "done";
      } catch (e) {
        p.status[5] = "error";
        throw e;
      }
    });
  });

  // Step 5: open the export folder in the OS file manager.
  handle("production:assemblyOpenFolder", (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    void shell.openPath(assetPath(p, p.assembly?.exportDir ?? `${p.assets.outDir}/${p.assets.assemblyDir}`));
  });

  // Expenses: per-production AI-generation ledgers (and manual purchased-asset
  // rows), plus the global pricing rules edited from Settings. Higgsfield
  // rows track credits, converted at the credit rate for the $ total.
  handle("ledger:get", async (_e, productionId: string): Promise<LedgerView> => ledger.view(productionId, settings.getHiggsfieldCreditUsd()));
  handle("ledger:getPriceRules", async (): Promise<ExpensePriceRule[]> => ledger.getPriceRules());
  handle("ledger:setPriceRules", async (_e, rules: ExpensePriceRule[]): Promise<void> => {
    ledger.setPriceRules(rules, settings.getHiggsfieldCreditUsd());
  });
  handle("ledger:reprice", async (_e, productionId: string): Promise<LedgerView> => {
    ledger.repriceAll(settings.getHiggsfieldCreditUsd());
    return ledger.view(productionId, settings.getHiggsfieldCreditUsd());
  });
  handle("ledger:addManual", async (_e, productionId: string, label: string, amount: number): Promise<LedgerView> => {
    return ledger.addManualEntry(productionId, label, amount, settings.getHiggsfieldCreditUsd());
  });
  handle("ledger:removeEntry", async (_e, productionId: string, id: string): Promise<LedgerView> => {
    return ledger.removeEntry(productionId, id, settings.getHiggsfieldCreditUsd());
  });
  handle("ledger:openFile", async (_e, productionId: string): Promise<void> => {
    await ledger.openLedgerFile(productionId);
  });
  handle("ledger:exportRules", async (): Promise<string | null> => {
    const res = await dialog.showSaveDialog(win!, {
      title: "Export expense price rules",
      defaultPath: path.join(app.getPath("documents"), "cascade-expense-prices.csv"),
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (res.canceled || !res.filePath) return null;
    ledger.writePriceRulesFile(res.filePath, ledger.getPriceRules());
    return res.filePath;
  });
  handle("ledger:importRules", async (): Promise<{ path: string; rules: ExpensePriceRule[] } | null> => {
    const res = await dialog.showOpenDialog(win!, {
      title: "Import expense price rules",
      properties: ["openFile"],
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    const filePath = res.filePaths[0];
    if (res.canceled || !filePath) return null;
    const rules = await ledger.applyModelOptions(
      ledger.parsePriceRulesCsv(fs.readFileSync(filePath, "utf8")),
      async (modelId) => (await mediaFor(modelId).videoModelOptions(modelId, true)) ?? null
    );
    ledger.setPriceRules(rules, settings.getHiggsfieldCreditUsd());
    return { path: filePath, rules: ledger.getPriceRules() };
  });

  handle("agents:getSessionAgent", (_e, sessionId: string) => {

    const entry = chats.get(sessionId) ?? (sessions.loadSession(sessionId) ? live(sessionId) : null);
    return entry?.session.agentId ?? null;
  });
  handle("agents:setSessionAgent", (_e, sessionId: string, agentId: string | null) => {
    const entry = live(sessionId);
    curId = sessionId;
    const prev = entry.session.agentId ?? null;
    const next = agentId ?? null;
    if (prev === next) return;
    entry.session.agentId = next;
    // Insert a prominent switch frame into the transcript
    const display: DisplayItem[] = entry.session.display ?? [];
    let switchName = "Default";
    let switchAvatar: { kind: "emoji"; value: string } | { kind: "image"; path: string } | null = null;
    let switchDescription = "";
    let switchModel = "";
    if (next) {
      const m = agents.getAgentMeta(next);
      if (m) { switchName = m.name; switchAvatar = m.avatar; switchDescription = m.description ?? ""; switchModel = m.model ?? ""; }
    }
    const frame: DisplayItem = {
      kind: "agent-switch",
      agentId: next,
      name: switchName,
      description: switchDescription,
      model: switchModel,
      avatar: switchAvatar,
      at: new Date().toISOString(),
    };
    // attach avatar data url for rendering if image
    if (switchAvatar && switchAvatar.kind === "image" && next) {
      (frame as { avatarDataUrl?: string | null }).avatarDataUrl = agents.getAvatarDataUrl(next, switchAvatar as never);
    }
    display.push(frame);
    entry.session.display = display;
    sessions.saveSession(entry.session);
    entry.agent?.stop();
    entry.agent = null;
    win?.webContents.send("agents:switched", { sessionId, agentId: next, frame });
  });

  // Every declared channel must be handled — catches contract drift.
  for (const channel of Object.keys(ipcContract)) {
    if (!ipcHandlers.has(channel)) {
      throw new Error(`IPC channel "${channel}" is declared in the contract but has no handler`);
    }
  }
}

// ---- window ---------------------------------------------------------------
// Window title-bar / taskbar icon. In dev it's read straight from the build
// resource; when packaged it's copied into resources/ by extraResources.
function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(__dirname, "../../build/icon.png");
}

/** Application menu (File → Settings…, standard Edit/View/Window roles). The
 *  app keeps its own Ctrl+= / Ctrl+- / Ctrl+0 zoom handling in
 *  before-input-event, so the View menu intentionally omits the zoom roles. */
function installApplicationMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => win?.webContents.send("menu:openSettings"),
        },
        { type: "separator" },
        { role: "quit", label: "Quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo", label: "Undo" },
        { role: "redo", label: "Redo" },
        { type: "separator" },
        { role: "cut", label: "Cut" },
        { role: "copy", label: "Copy" },
        { role: "paste", label: "Paste" },
        { role: "selectAll", label: "Select All" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload", label: "Reload" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Toggle Full Screen" },
      ],
    },
    {
      role: "window",
      label: "Window",
      submenu: [{ role: "minimize", label: "Minimize" }, { role: "close", label: "Close" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Whether saved bounds overlap any connected display. Guards against
 * restoring an off-screen window after a monitor was unplugged.
 */
function isBoundsVisible(x: number, y: number, width: number, height: number): boolean {
  try {
    const centerX = Math.floor(x + width / 2);
    const centerY = Math.floor(y + height / 2);
    return screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return centerX >= b.x && centerX < b.x + b.width && centerY >= b.y && centerY < b.y + b.height;
    });
  } catch {
    return true; // screen not ready in tests — don't block restore
  }
}

/** Persist the current window geometry. While maximized/fullscreen only the
 *  flag is stored so the previous normal bounds survive for un-maximize. */
function saveWindowState(): void {
  if (!win || win.isDestroyed()) return;
  try {
    const maximized = win.isMaximized() || win.isFullScreen();
    if (maximized) {
      const prev = settings.getWindowState();
      settings.setWindowState({
        x: prev?.x ?? null,
        y: prev?.y ?? null,
        width: prev?.width ?? 1100,
        height: prev?.height ?? 780,
        isMaximized: true,
      });
      return;
    }
    const b = win.getNormalBounds?.() ?? win.getBounds();
    settings.setWindowState({ x: b.x, y: b.y, width: b.width, height: b.height, isMaximized: false });
  } catch {
    /* non-fatal — window metrics must never break quit */
  }
}

function createWindow() {
  const saved = settings.getWindowState();
  const restored = saved && saved.x !== null && saved.y !== null
    && isBoundsVisible(saved.x, saved.y, saved.width, saved.height)
    ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
    : saved
      ? { width: saved.width, height: saved.height }
      : { width: 1100, height: 780 };
  win = new BrowserWindow({
    ...restored,
    minWidth: 720,
    minHeight: 500,
    title: "Cascade",
    icon: appIconPath(),
    backgroundColor: "#111417",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (saved?.isMaximized) win.maximize();

  installApplicationMenu();

  // Remember size/position across restarts. Resize/move fire continuously,
  // so debounce to a single write shortly after the user settles; close
  // saves synchronously as a final guarantee.
  let saveTimer: NodeJS.Timeout | null = null;
  const saveSoon = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveWindowState(); }, 500);
  };
  win.on("resize", saveSoon);
  win.on("move", saveSoon);
  win.on("maximize", saveSoon);
  win.on("unmaximize", saveSoon);
  win.on("close", () => saveWindowState());

  // Zoom shortcuts. Chromium's built-in binding misses Ctrl+= / Ctrl++ on
  // some layouts, so handle the whole family explicitly (and swallow the key
  // so it doesn't double-zoom).
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !input.control || input.alt || !win) return;
    const wc = win.webContents;
    const level = wc.getZoomLevel();
    const zoomTo = (next: number) => {
      wc.setZoomLevel(next);
      // Chromium doesn't fire a DOM resize for zoom changes, so tell the
      // renderer to re-rasterize (canvas backing stores) at the new factor.
      wc.send("zoom:changed");
    };
    if (input.key === "=" || input.key === "+") {
      event.preventDefault();
      zoomTo(Math.min(level + 0.5, 5));
    } else if (input.key === "-" || input.key === "_") {
      event.preventDefault();
      zoomTo(Math.max(level - 0.5, -5));
    } else if (input.key === "0") {
      event.preventDefault();
      zoomTo(0);
    }
  });
  // Pinch / Ctrl+wheel zoom also changes the zoom level; notify for those too.
  win.webContents.on("zoom-changed", () => win?.webContents.send("zoom:changed"));

  // Bringing the window forward cancels any attention flash and checks
  // whether an externally edited original was saved while the app was
  // backgrounded — if so the JPEG preview is re-encoded before the user
  // sees stale pixels.
  win.on("focus", () => {
    win?.flashFrame(false);
    void checkExternalEdits();
  });

  // External links open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    const trusted = devUrl ? url.startsWith(devUrl) : url.startsWith("file://");
    if (!trusted) e.preventDefault();
  });

  // Right-click context menu: native edit menu for inputs/textareas (Cut/Copy/
  // Paste/Select All), and a save/copy/edit-externally menu for images.
  win.webContents.on("context-menu", (_e, params) => {
    if ((params.mediaType === "image" || params.mediaType === "video") && params.srcURL) {
      popMediaContextMenu(win!, { media: params.mediaType, src: params.srcURL, x: params.x, y: params.y });
      return;
    }
    if (params.isEditable) {
      Menu.buildFromTemplate([
        { role: "cut", label: "Cut", enabled: params.editFlags.canCut },
        { role: "copy", label: "Copy", enabled: params.editFlags.canCopy },
        { role: "paste", label: "Paste", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll", label: "Select All", enabled: params.editFlags.canSelectAll },
      ]).popup();
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  // First chat inherits the default folder.
  const s = sessions.newSessionFile(settings.getWorkspace());
  sessions.saveSession(s); // persist so the active chat shows in the sidebar
  chats.set(s.id, { session: s, agent: null, running: false, sendToken: 0 });
  curId = s.id;
  mcp = new McpManager(path.join(app.getPath("userData"), "mcp.json"));
  // Seed the bundled harness skills (spec/oracle/code) into the user skills
  // folder the first time, so the RPI workflow works out of the box and the
  // user can edit or delete them. In dev the bundled dir is app/skills; when
  // packaged it's resources/skills (extraResources).
  const bundledSkillsDir = app.isPackaged
    ? path.join(process.resourcesPath, "skills")
    : path.join(app.getAppPath(), "skills");
  seedSkills(path.join(app.getPath("userData"), "skills"), bundledSkillsDir);
  setThumbCacheDir(path.join(app.getPath("userData"), "thumb-cache"));
  registerMediaProtocol();
  registerIpc();
  installCsp();
  createWindow();
  // Connect MCP servers in the background; don't block window startup.
  void mcp.reload().catch(() => {});
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void mcp?.shutdown();
});
