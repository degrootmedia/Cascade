/**
 * Cascade main process: window creation, IPC wiring, agent lifecycle.
 * All privileged work (API key, file tools, shell) stays in this process.
 */
import { app, BrowserWindow, dialog, ipcMain, shell, Menu, nativeImage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, GabClient, suggestChatTitle, friendlyApiError, loadWorkspaceInstructions, workspaceInstructionsFile, type ChatMessage, type AgentTool } from "@core";
import * as settings from "./settings.js";
import * as sessions from "./sessions.js";
import * as agents from "./agents.js";
import * as productions from "./productions.js";
import * as shotter from "./shotter.js";
import { ingestScript, refineStylePrompt, generateStyleSet, assetPath, scriptMarkdown, generateBoards, planAnimatic, exportBoardPrompts, importBoards, scanBoardImportFolder, openArtPrompt, stripReferenceClause, shotReferences, refToken, recordBoardArtwork, type ImageGenFn, type GenerationRef } from "./pipeline.js";
import { McpManager } from "./mcp.js";
import { loadSkills, makeReadSkillTool, ensureSkillsDir } from "./skills.js";
import { makeOpenArtUploadTool, uploadDataUrlReference } from "./openart-upload.js";
import type { AgentEventIpc, ApprovalDecisionIpc, Production, ProductionEvent, OpenArtModelChoice, OpenArtBoardConfig } from "../shared/ipc.js";

let win: BrowserWindow | null = null;
let mcp: McpManager;

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

/** Working folder for a given chat: per-session first, default second. */
function workspaceFor(e: LiveChat | null): string | null {
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
  const workspace = workspaceFor(entry);
  if (!apiKey) throw new Error("NO_API_KEY");
  if (!workspace) throw new Error("NO_WORKSPACE");
  if (!entry.agent) {
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
      model: agentModel ?? settings.getModel(),
      workspaceRoot: workspace,
      agentPrompt: agentPrompt || undefined,
      skills: skillsList,
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
    if (entry.session.history.length) entry.agent.loadHistory(entry.session.history as ChatMessage[]);
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
  const title = await suggestChatTitle(history, apiKey);
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
  return applyChatTitle(entry.session.history as ChatMessage[], entry.session.id, false);
}

// ---- IPC ------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle("chat:send", async (_e, sessionId: string, text: string, images?: string[]) => {
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
      await a.send(text, images);
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

  ipcMain.on("chat:stop", (_e, sessionId: string) => {
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

  // Undo the file changes made by a chat's most recent agent turn.
  ipcMain.handle("chat:undo", (_e, sessionId: string) => {
    const entry = chats.get(sessionId);
    if (!entry || !entry.agent) return { restored: 0, files: [] };
    const workspace = workspaceFor(entry);
    const outcome = entry.agent.undoLastTurn();
    const rel = (p: string) => (workspace ? path.relative(workspace, p) : p);
    return { restored: outcome.restored, files: outcome.files.map(rel) };
  });

  ipcMain.on("approval:response", (_e, id: number, decision: ApprovalDecisionIpc) => {
    pendingApprovals.get(id)?.(decision);
    pendingApprovals.delete(id);
    if (pendingApprovals.size === 0) win?.flashFrame(false); // nothing left awaiting input
  });

  ipcMain.on("display:sync", (_e, sessionId: string, display: unknown[]) => {
    // Renderer owns display items; mirror them into that chat's session file.
    const entry = chats.get(sessionId);
    if (!entry) return;
    entry.session.display = display;
    sessions.saveSession(entry.session);
  });

  // Default folder for new chats (Settings).
  ipcMain.handle("workspace:pick", async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    if (res.canceled || !res.filePaths[0]) return null;
    settings.setWorkspace(res.filePaths[0]);
    settings.addRecentWorkspace(res.filePaths[0]);
    resetAllAgents();
    return res.filePaths[0];
  });

  // Working folder for the CURRENT chat (header chip).
  ipcMain.handle("workspace:pickSession", async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    if (res.canceled || !res.filePaths[0]) return null;
    const entry = cur();
    const dir = res.filePaths[0];
    if (entry) entry.session.workspace = dir;
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
  ipcMain.handle("workspace:setSession", (_e, dir: string) => {
    if (typeof dir !== "string" || !dir) return;
    const entry = cur();
    if (entry) entry.session.workspace = dir;
    settings.addRecentWorkspace(dir);
    if (entry?.session.history.length) sessions.saveSession(entry.session);
    if (!settings.getWorkspace()) settings.setWorkspace(dir);
    if (entry) {
      entry.agent?.stop();
      entry.agent = null;
    }
  });

  // Recent folders for the header dropdown.
  ipcMain.handle("workspace:recent", () => settings.getRecentWorkspaces());

  ipcMain.handle("workspace:current", () => effectiveWorkspace());

  ipcMain.handle("settings:get", () => ({
    hasApiKey: settings.getApiKey() !== null,
    model: settings.getModel(),
    workspace: settings.getWorkspace(),
    accent: settings.getAccent(),
  }));

  ipcMain.handle("settings:setApiKey", (_e, key: string) => {
    settings.setApiKey(key.trim());
    resetAllAgents();
  });

  ipcMain.handle("settings:setModel", (_e, model: string) => {
    settings.setModel(model);
    resetAllAgents();
  });

  ipcMain.handle("settings:setAccent", (_e, color: string) => {
    if (typeof color === "string") settings.setAccent(color);
  });

  ipcMain.handle("models:list", async () => {
    const apiKey = settings.getApiKey();
    if (!apiKey) return [];
    const res = await fetch("https://gab.ai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const json = (await res.json()) as {
      data?: Array<{
        id: string;
        capabilities?: Record<string, boolean>;
        credit_cost?: { base_cost?: number } | null;
      }>;
    };
    return (json.data ?? [])
      .filter((m) => m.capabilities?.text && m.capabilities?.function_calling && m.capabilities?.streaming)
      .map((m) => ({
        id: m.id,
        thinking: !!m.capabilities?.thinking,
        vision: !!m.capabilities?.image_input,
        baseCost: m.credit_cost?.base_cost ?? 1, // null/absent = cheapest tier (arya)
      }));
  });

  ipcMain.handle("credits:get", async () => {
    const apiKey = settings.getApiKey();
    if (!apiKey) return null;
    try {
      const c = (await new GabClient(apiKey).credits()) as { total_available?: number };
      return c.total_available ?? null;
    } catch {
      return null;
    }
  });

  ipcMain.handle("sessions:list", () => sessions.listSessions());

  ipcMain.handle("sessions:load", (_e, id: string) => {
    const entry = live(id);
    curId = id;
    const s = entry.session;
    if (!Array.isArray(s.mentionImages)) s.mentionImages = [];
    // Older sessions saved mention images only in `mentionImages` (not in the
    // display list). Rehydrate any that are missing into the transcript.
    const display = (s.display as Array<Record<string, unknown>>) ?? [];
    for (const dataUrl of s.mentionImages) {
      const alreadyShown = display.some((it) => it.kind === "mention" && (it as { image?: string }).image === dataUrl);
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
  ipcMain.on("sessions:activate", (_e, id: string) => {
    if (typeof id === "string" && id) curId = id;
  });

  ipcMain.handle("sessions:new", () => {
    const s = sessions.newSessionFile(settings.getWorkspace());
    sessions.saveSession(s); // persist so it's visible in the sidebar immediately
    const entry: LiveChat = { session: s, agent: null, running: false, sendToken: 0 };
    chats.set(s.id, entry);
    curId = s.id;
    return s.id;
  });

  ipcMain.handle("sessions:current", () => curId);

  ipcMain.handle("sessions:remove", (_e, id: string, mode: "delete" | "archive") => {
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
  ipcMain.handle("sessions:rename", async (_e, id: string) => {
    if (typeof id !== "string" || !id) return null;
    const loaded = sessions.loadSession(id);
    if (!loaded) return null;
    return applyChatTitle((loaded.history as ChatMessage[]) ?? [], id, true);
  });

  // ---- skills ----
  ipcMain.handle("skills:list", () => loadSkills(path.join(app.getPath("userData"), "skills")));

  ipcMain.handle("skills:openFolder", () => {
    const dir = path.join(app.getPath("userData"), "skills");
    ensureSkillsDir(dir);
    void shell.openPath(dir);
    resetAllAgents(); // reload skill list next message (cheap; also picks up edits)
  });

  // ---- per-directory instructions (CASCADE.md) ----
  ipcMain.handle("workspace:instructions", () => {
    const ws = effectiveWorkspace();
    if (!ws) return { workspace: null, active: false, file: null };
    const active = loadWorkspaceInstructions(ws).length > 0;
    const file = workspaceInstructionsFile(ws);
    return { workspace: ws, active, file: file ?? ws };
  });

  ipcMain.handle("workspace:openInstructions", () => {
    const ws = effectiveWorkspace();
    if (!ws) return;
    const file = workspaceInstructionsFile(ws);
    void shell.openPath(file ?? ws); // open the file, or reveal the folder so the user can add one
    resetAllAgents(); // pick up any edited/added instructions on the next message
  });

  // ---- MCP ----
  ipcMain.handle("mcp:getConfig", () => mcp.readConfigText());

  ipcMain.handle("mcp:setConfig", async (_e, text: string) => {
    mcp.writeConfigText(text); // throws on invalid JSON; surfaces to renderer
    const statuses = await mcp.reload();
    resetAllAgents(); // next agent picks up the new tool set
    return statuses;
  });

  ipcMain.handle("mcp:status", () => mcp.getStatuses());

  ipcMain.handle("mcp:reload", async () => {
    const statuses = await mcp.reload();
    resetAllAgents();
    return statuses;
  });

  ipcMain.handle("mcp:onDemand", () => settings.getMcpOnDemand());

  ipcMain.handle("mcp:setOnDemand", (_e, names: string[]) => {
    settings.setMcpOnDemand(Array.isArray(names) ? names : []);
    resetAllAgents();
  });

  // ---- agents ----
  ipcMain.handle("agents:list", () => agents.listAgents());
  ipcMain.handle("agents:get", (_e, id: string) => {
    const r = agents.getAgent(id);
    if (!r) return null;
    const avatarDataUrl = r.meta.avatar?.kind === "image" ? agents.getAvatarDataUrl(id, r.meta.avatar) : null;
    return { meta: r.meta, prompt: r.prompt, avatarDataUrl };
  });
  ipcMain.handle("agents:create", (_e, data: { name: string; description?: string; avatar?: unknown; model?: string; allowedTools?: "all" | string[]; prompt?: string }) => {
    const id = agents.createAgent(data as never);
    return id;
  });
  ipcMain.handle("agents:update", (_e, id: string, patch: Record<string, unknown>) => {
    agents.updateAgent(id, patch as never);
  });
  ipcMain.handle("agents:uploadAvatar", async (_e, id: string, dataUrl: string) => {
    const filename = agents.saveAgentAvatar(id, dataUrl);
    agents.updateAgent(id, { avatar: { kind: "image", path: filename } } as never);
    return filename;
  });
  ipcMain.handle("agents:duplicate", (_e, id: string) => agents.duplicateAgent(id));
  ipcMain.handle("agents:remove", (_e, id: string, mode: "delete" | "archive") => {
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
  ipcMain.handle("agents:export", (_e, id: string) => {
    const r = agents.getAgent(id);
    if (!r) return null;
    return { json: JSON.stringify(r.meta, null, 2), md: r.prompt };
  });
  ipcMain.handle("agents:import", (_e, json: string, md: string) => agents.importAgent(json, md));

  // ---- productions (Production Assistant) ----
  /** Stream a log line to the Production UI. */
  const productionEmit = (id: string, message: string, level: ProductionEvent["level"] = "info") => {
    win?.webContents.send("production:event", { id, message, level } satisfies ProductionEvent);
  };

  ipcMain.handle("production:list", () => productions.listProductions());

  ipcMain.handle("production:pickFolder", async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
  });

  ipcMain.handle("production:create", (_e, name: string, folder: string) => {
    if (typeof folder !== "string" || !folder || typeof name !== "string") throw new Error("BAD_ARGS");
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch {
      throw new Error(`Can't create or open that folder: ${folder}`);
    }
    const p = productions.newProduction(name, folder);
    settings.addRecentProduction(folder);
    return p;
  });

  ipcMain.handle("production:load", (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (p) settings.addRecentProduction(p.meta.folder);
    return p;
  });

  ipcMain.handle("production:save", (_e, p: Production) => {
    // Persist renderer-owned state (edited shots, step focus, style…). The id
    // must exist already; new productions go through production:create.
    const existing = productions.loadProduction(p?.meta?.id);
    if (!existing) throw new Error("Production not found — it may have been deleted.");
    existing.currentStep = p.currentStep;
    existing.visualStyle = p.visualStyle ?? "";
    existing.styles = Array.isArray(p.styles) ? p.styles : [];
    existing.brand = p.brand && Array.isArray(p.brand.colors)
      ? { colors: p.brand.colors.slice(0, 5).map((c) => String(c)), font: typeof p.brand.font === "string" ? p.brand.font : "" }
      : { colors: [], font: "" };
    existing.scenes = Array.isArray(p.scenes) ? p.scenes : [];
    existing.promptOverrides =
      p.promptOverrides && typeof p.promptOverrides === "object"
        ? Object.fromEntries(Object.entries(p.promptOverrides).filter(([, v]) => typeof v === "string" && v.trim()))
        : {};
    existing.characters = Array.isArray(p.characters) ? p.characters : [];
    existing.products = Array.isArray(p.products) ? p.products : [];
    existing.references = Array.isArray(p.references) ? p.references : [];
    if (p.openArt && typeof p.openArt.model === "string" && typeof p.openArt.resolution === "string") {
      existing.openArt = { model: p.openArt.model, resolution: p.openArt.resolution } as OpenArtBoardConfig;
    }
    existing.status = p.status ?? {};
    if (typeof p.scriptSource === "string") existing.scriptSource = p.scriptSource;
    if (typeof p.meta.name === "string" && p.meta.name.trim()) existing.meta.name = p.meta.name.trim();
    productions.saveProduction(existing);
    // Keep script.md in sync (renames and renderer-side edits land here too).
    if (existing.scenes.some((s) => s.shots.length)) {
      try {
        fs.writeFileSync(assetPath(existing, existing.assets.scriptMd), scriptMarkdown(existing.meta.name, existing.scenes), "utf8");
      } catch {
        /* non-fatal */
      }
    }
    return existing;
  });

  ipcMain.handle("production:remove", (_e, id: string, mode: "delete" | "archive") => {
    const ok = mode === "archive" ? productions.archiveProduction(id) : productions.deleteProduction(id);
    return ok;
  });

  ipcMain.handle("production:pickScriptFile", async () => {
    const res = await dialog.showOpenDialog(win!, {
      properties: ["openFile"],
      filters: [
        { name: "Scripts", extensions: ["pdf", "docx", "doc", "txt", "md", "markdown", "fountain"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
  });

  ipcMain.handle("production:pickReferenceImage", async () => {
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

  ipcMain.handle("production:ingest", async (_e, id: string, source: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (typeof source !== "string" || !source.trim()) throw new Error("Pick a script file or paste a Google Docs link first.");
    const apiKey = settings.getApiKey();
    if (!apiKey) throw new Error("Add your Gab.ai API key in Settings first.");
    p.status[1] = "running";
    productions.saveProduction(p);
    productionEmit(id, `Step 1 started: ${source}`);
    try {
      await ingestScript(p, source, apiKey, settings.getModel(), (m, level) => productionEmit(id, m, level));
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
  ipcMain.handle("production:refineStyle", async (_e, id: string, style: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (typeof style !== "string" || !style.trim()) throw new Error("Write some style notes first, then refine them.");
    const apiKey = settings.getApiKey();
    if (!apiKey) throw new Error("Add your Gab.ai API key in Settings first.");
    productionEmit(id, "Refining the master style prompt…");
    try {
      // A short excerpt of the first scene's visuals gives tone context.
      const excerpt = (p.scenes[0]?.shots ?? []).slice(0, 5).map((s) => s.visual).join(" ").slice(0, 800);
      const refined = await refineStylePrompt(style.trim(), excerpt, apiKey, settings.getModel());
      productionEmit(id, "Style prompt refined.", "done");
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
  ipcMain.handle("production:generateStyles", async (_e, id: string, notes: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (typeof notes !== "string" || !notes.trim()) throw new Error("Write some style notes first, then generate styles.");
    const apiKey = settings.getApiKey();
    if (!apiKey) throw new Error("Add your Gab.ai API key in Settings first.");
    productionEmit(id, "Generating up to 5 named visual styles…");
    try {
      const excerpt = (p.scenes[0]?.shots ?? []).slice(0, 5).map((s) => s.visual).join(" ").slice(0, 800);
      const styles = await generateStyleSet(notes.trim(), excerpt, apiKey, settings.getModel());
      productionEmit(id, `Generated ${styles.length} style${styles.length === 1 ? "" : "s"}.`, "done");
      return styles;
    } catch (e) {
      const msg = friendlyApiError(e);
      productionEmit(id, msg, "error");
      throw new Error(msg);
    }
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

  ipcMain.handle("production:insertShot", (_e, id: string, sceneNumber: number, index: number) =>
    mutateShots(id, (p) => {
      shotter.insertShotAt(p.scenes, sceneNumber, index);
    })
  );

  ipcMain.handle("production:deleteShot", (_e, id: string, shotId: string) =>
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
  );

  ipcMain.handle("production:updateShot", (_e, id: string, shotId: string, patch: { audio?: string; visual?: string }) =>
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

  /** Pull an array of OpenArt model entries out of the MCP server's JSON-ish reply. */
  function parseOpenArtModels(raw: string): Array<Record<string, unknown>> {
    const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let j: unknown = null;
    try {
      j = JSON.parse(t);
    } catch {
      const start = t.indexOf("[");
      const end = t.lastIndexOf("]");
      if (start === -1 || end <= start) return [];
      try { j = JSON.parse(t.slice(start, end + 1)); } catch { return []; }
    }
    if (Array.isArray(j)) {
      return (j as unknown[]).filter((m) => m && typeof m === "object") as Array<Record<string, unknown>>;
    }
    if (j && typeof j === "object") {
      const obj = j as Record<string, unknown>;
      // OpenAI-style / list envelopes: { data: [...] }, { items: [...] },
      // { models: [...] }, { list: [...] }, { results: [...] }.
      for (const key of ["data", "items", "models", "list", "results"]) {
        const v = obj[key];
        if (Array.isArray(v)) return v.filter((m) => m && typeof m === "object") as Array<Record<string, unknown>>;
      }
      // Some servers return a plain map { modelId: {…}, … }. Only trust it when
      // EVERY value is an object (so an { error: "…" } envelope isn't misread).
      const vals = Object.values(obj);
      if (vals.length && vals.every((v) => v && typeof v === "object")) {
        return vals as Array<Record<string, unknown>>;
      }
    }
    return [];
  }

  /** Shape the OpenArt model list into dropdown choices, prepending "Auto". */
  function openArtModelChoices(raw: string): OpenArtModelChoice[] {
    const out: OpenArtModelChoice[] = [
      { id: "auto", displayName: "Auto", description: "Cascade picks the best image model for each run.", imageInput: false, cost: null },
    ];
    for (const m of parseOpenArtModels(raw)) {
      const id = String(m.model ?? m.id ?? m.model_id ?? m.name ?? "").trim();
      if (!id) continue;
      const displayName = String(m.displayName ?? m.display_name ?? m.name ?? id);
      const description = String(m.description ?? m.summary ?? m.recommendedFor ?? "");
      const media = Array.isArray(m.media) ? String((m.media as unknown[]).join(" ")) : String(m.media ?? "");
      const modes = Array.isArray(m.modes) ? String((m.modes as unknown[]).join(" ")) : "";
      const blob = `${media} ${modes} ${description}`.toLowerCase();
      const imageInput = /image/i.test(blob);
      out.push({ id, displayName, description, imageInput, cost: null });
    }
    return out;
  }

  /** Turn "auto" (or any OpenArt model id) into the id to actually call. */
  function resolveOpenArtModel(choice: string, refsPresent: boolean, models: OpenArtModelChoice[]): string {
    if (choice && choice !== "auto") return choice;
    const eligible = models.slice(1); // everything but the synthetic Auto
    if (!eligible.length) return "";
    // This is the IMAGE tool, so prefer a model that accepts image input when
    // one is available (even without refs, image-capable models are the right
    // default for storyboards). Falls back to the first listed otherwise.
    const withInput = eligible.filter((m) => m.imageInput);
    const pool = withInput.length ? withInput : eligible;
    return pool[0]?.id ?? eligible[0]?.id ?? "";
  }

  /**
   * Build the OpenArt generate-tool arguments for one board.
   *
   * The generate tool takes a nested `{ model, mode, params, projectId }`
   * shape; `params` must match the resolved model's form schema. The canonical
   * field map comes from the live model form (fetched per run) — the static
   * tool schema doesn't carry per-model field names, so we never rely on it for
   * more than confirming the nested `params` wrapper. We fill the known keys:
   *   - prompt          (the shot prompt)
   *   - aspectRatio     → "16:9" (storyboards are widescreen)
   *   - resolution / resolutionTier per the 1k/2k/4k dropdown
   *   - imageCount      → 1 (exactly one frame per shot)
   *   - visualReferences → uploaded reference art (image2image mode only)
   */
  function imageGenArgs(
    prompt: string,
    refs: Record<string, unknown>[],
    cfg: OpenArtBoardConfig,
    models: OpenArtModelChoice[],
    projectId: string | null,
    mode: string,
    formProps: Record<string, unknown> | null
  ): Record<string, unknown> {
    const props = formProps ?? {};
    const params: Record<string, unknown> = { prompt };

    // Every board is storyboarded in widescreen — lock 16:9 whenever the model
    // offers it; otherwise the model's default (usually square) applies rather
    // than us guessing a malformed value.
    const asp = aspectRatioAssign(props);
    if (asp) Object.assign(params, asp);
    // Resolution bucket → the model's resolution/resolutionTier label.
    const res = resolutionAssign(cfg.resolution, props);
    if (res) Object.assign(params, res);
    // Exactly one frame per shot.
    const count = imageCountAssign(props);
    if (count) Object.assign(params, count);
    // Reference art — accepted only under image2image (text2image has no
    // reference field), so `mode` is "image2image" whenever refs exist.
    if (refs.length) {
      const vk = Object.keys(props).find((k) => /visualReference|references/i.test(k));
      if (vk) params[vk] = refs;
    }

    const args: Record<string, unknown> = { mode, params };
    // model is REQUIRED by the OpenArt tool (minLength 1); guard against the
    // empty string from a failed model-list so the error stays readable.
    const model = resolveOpenArtModel(cfg.model, refs.length > 0, models);
    if (model) args.model = model;
    // Route into the production's own OpenArt project when one is resolved, so
    // every frame for a production lands in a project named after its folder.
    if (projectId) args.projectId = projectId;
    return args;
  }

  /**
   * Force a 16:9 widescreen aspect ratio on whatever sizing param the model's
   * schema declares. Only sets a value when the schema accepts it: either an
   * enum carrying a "16:9" string, or a boolean cinematic/landscape toggle.
   * Returns null when the model has no supported 16:9 option (its default —
   * usually square — then applies rather than us guessing a malformed value).
   */
  function aspectRatioAssign(props: Record<string, unknown>): Record<string, unknown> | null {
    for (const key of Object.keys(props)) {
      if (!/aspect|orient|format/i.test(key)) continue;
      const p = props[key] as { type?: string; enum?: unknown[] } | undefined;
      if (!p) continue;
      if (Array.isArray(p.enum)) {
        const wide = p.enum.find((v) => /^16[:xX]9$/.test(String(v)));
        if (wide !== undefined) return { [key]: wide };
        continue; // has an aspect option but no 16:9 literal — don't guess
      }
      if (p.type === "boolean" && /cinema|widescreen|wide|landscape/i.test(key)) {
        return { [key]: true };
      }
    }
    return null;
  }

  /** Map the 1k/2k/4k bucket onto whatever sizing param the model's schema declares. */
  function resolutionAssign(resolution: string, props: Record<string, unknown>): Record<string, unknown> | null {
    const tier = resolution === "4k" ? 4 : resolution === "2k" ? 2 : 1;
    const label = `${tier}k`; // "1k" | "2k" | "4k" (matched case-insensitively)
    for (const key of Object.keys(props)) {
      const p = props[key] as { type?: string; enum?: unknown[] } | undefined;
      if (!p) continue;
      // Quadruple/HD/quality boolean toggles: enabled at 2k+, off at 1k.
      if (p.type === "boolean" && /upscale|hd|high|super|quality/i.test(key)) {
        return { [key]: tier > 1 };
      }
      // Explicit pixel width/height (numeric models like GPT Image 2).
      if (/^(size|width|height|image_width|image_height)/i.test(key) && (p.type === "integer" || p.type === "number")) {
        return { [key]: tier === 4 ? 4096 : tier === 2 ? 2048 : 1024 };
      }
      // Enum with "1K/2K/4K"-style tiers — pick the exact tier label.
      if (Array.isArray(p.enum)) {
        const exact = p.enum.find((v) => String(v).replace(/\s/g, "").toLowerCase() === label);
        if (exact !== undefined) return { [key]: exact };
        if (tier === 1) {
          const low = p.enum.find((v) => /^(standard|base|normal|low|1)$/i.test(String(v).trim()));
          if (low !== undefined) return { [key]: low };
        }
        continue;
      }
    }
    return null; // unknown shape — omit, model default applies
  }

  /** Force exactly one frame per shot when the model exposes an image-count field. */
  function imageCountAssign(props: Record<string, unknown>): Record<string, unknown> | null {
    for (const key of Object.keys(props)) {
      const p = props[key] as { type?: string } | undefined;
      if (!p) continue;
      if ((p.type === "integer" || p.type === "number") && /imageCount|image_count|^count$/i.test(key)) {
        return { [key]: 1 };
      }
    }
    return null;
  }

  /** Extract the field map out of an OpenArt open_model_form_get reply. */
  function parseModelFormProperties(raw: string): Record<string, unknown> | null {
    const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let j: unknown = null;
    try { j = JSON.parse(t); } catch {
      const start = t.indexOf("{"); const end = t.lastIndexOf("}");
      if (start === -1 || end <= start) return null;
      try { j = JSON.parse(t.slice(start, end + 1)); } catch { return null; }
    }
    if (!j || typeof j !== "object") return null;
    const schema = (j as Record<string, unknown>).jsonSchema as Record<string, unknown> | undefined;
    const allOf = Array.isArray(schema?.allOf) ? (schema.allOf as Record<string, unknown>[]) : [];
    const first = allOf[0];
    const props = first?.properties ?? schema?.properties;
    return props && typeof props === "object" ? (props as Record<string, unknown>) : null;
  }

  // ---- async OpenArt completion helpers ------------------------------------
  const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** Parse the leading JSON object out of a tool reply (schema may append prose). */
  const parseJsonObject = (text: string): Record<string, unknown> | null => {
    const end = text.indexOf("}");
    if (end === -1) return null;
    try {
      const o = JSON.parse(text.slice(0, end + 1));
      return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  /**
   * The OpenArt generate tool is asynchronous: the submission reply is a
   * `{"status":"PENDING","historyId":"…","pollAfterSeconds":N}` object and the
   * finished image arrives later on a creation_* tool. Pull the historyId out
   * of that submission reply (tolerating trailing prose).
   */
  function openArtHistoryId(text: string): string | null {
    const obj = parseJsonObject(text);
    if (obj && typeof obj.historyId === "string" && obj.historyId) return obj.historyId;
    return text.match(/"historyId"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  }

  /** One attempt to fetch an image from a URL/as-image Buffer; null if not an image. */
  async function fetchImageBuffer(url: string): Promise<Buffer | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length ? buf : null;
    } catch {
      return null;
    }
  }

  /**
   * Wait for an async OpenArt image generation to finish, then return the
   * pixels. Uses the server's blocking `openart_creation_wait` where present
   * (looping on STILL_RUNNING); falls back to polling `openart_creation_get`.
   * Returns null if completion surfaces no fetchable image (caller then errors).
   */
  async function waitOpenArtImage(historyId: string): Promise<Buffer | null> {
    const rawName = (n: string) => n.replace(/^openart__/, "");
    const tools = Object.keys(mcp.getTools());
    const waitRaw = tools.map(rawName).find((n) => /^openart_creation_wait$/.test(n));
    const getRaw = tools.map(rawName).find((n) => /^openart_creation_get$/.test(n));
    if (!waitRaw && !getRaw) return null;

    const deadline = Date.now() + 150_000; // ~2.5 min cap per frame
    const finalize = async (res: { text: string; images: Buffer[]; uris: string[] }): Promise<Buffer | null> => {
      if (res.images.length) return res.images[0];
      const imgUrl =
        res.text.match(IMAGE_URL_RX)?.[0] ??
        res.uris.find((u) => /\.(?:png|jpe?g|webp)(?:\?|$)/i.test(u));
      return imgUrl ? fetchImageBuffer(imgUrl) : null;
    };

    const pollWith = waitRaw
      ? async () =>
          mcp.callRawContent("openart", waitRaw!, { historyId, timeoutSeconds: 60 })
      : async () => mcp.callRawContent("openart", getRaw!, { historyId });

    while (Date.now() < deadline) {
      const res = await pollWith();
      const got = await finalize(res);
      if (got) return got;
      const obj = parseJsonObject(res.text);
      const status = typeof obj?.status === "string" ? obj.status : "";
      if (status === "FAILED" || status === "CANCELLED") {
        throw new Error(`OpenArt generation ${status.toLowerCase()} (${historyId.slice(0, 8)}…).`);
      }
      await sleepMs(Math.max(1, Number(obj?.pollAfterSeconds ?? 4)) * 1000);
    }
    throw new Error(`OpenArt image generation timed out (${historyId.slice(0, 8)}…).`);
  }

  const IMAGE_URL_RX = /https:\/\/[^\s"')\]}>]+\.(?:png|jpe?g|webp)(?:\?[^\s"')\]}>]*)?/;

  /** Minimal shape of an OpenArt project (from list or create). */
  interface RawProject { id?: unknown; name?: unknown; canGenerate?: unknown }

  /** Parse the OpenArt project-list/create reply into project objects. */
  function parseOpenArtProjects(text: string): RawProject[] {
    const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let j: unknown = null;
    try { j = JSON.parse(t); } catch {
      const start = t.indexOf("["); const end = t.lastIndexOf("]");
      if (start === -1 || end <= start) return [];
      try { j = JSON.parse(t.slice(start, end + 1)); } catch { return []; }
    }
    if (Array.isArray(j)) return j.filter((x) => x && typeof x === "object") as RawProject[];
    if (j && typeof j === "object") {
      const o = j as Record<string, unknown>;
      if (o.id !== undefined) return [o as unknown as RawProject]; // single created/found project
      for (const key of ["items", "projects", "data", "list"]) {
        const v = o[key];
        if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object") as RawProject[];
      }
    }
    return [];
  }

  /**
   * Resolve the OpenArt project a production's frames should land in: the
   * project named after the production's folder. Reuses an existing project
   * with that name (only ones Cascade can generate into), or creates it.
   * Returns the project id, or null when OpenArt's project tools aren't
   * available / an error occurs — generation then falls back to the account
   * default project rather than blocking.
   */
  async function resolveOpenArtProject(p: Production): Promise<string | null> {
    const raw = (n: string) => n.replace(/^openart__/, "");
    const tools = Object.keys(mcp.getTools()).map(raw);
    const listRaw = tools.find((n) => /^openart_project_list$/.test(n));
    const createRaw = tools.find((n) => /^openart_project_create$/.test(n));
    if (!listRaw) return null;
    const folderName = (path.basename(p.meta.folder) || p.meta.name).trim();
    if (!folderName) return null;
    try {
      const listText = await mcp.callRaw("openart", listRaw, {});
      const existing = parseOpenArtProjects(listText);
      const match = existing.find(
        (pr) => pr.canGenerate && typeof pr.id === "string" && typeof pr.name === "string" &&
          pr.name.trim().toLowerCase() === folderName.toLowerCase()
      );
      if (match && typeof match.id === "string") return match.id;
      if (!createRaw) return null;
      const createdText = await mcp.callRaw("openart", createRaw, { name: folderName });
      const created = parseOpenArtProjects(createdText)[0];
      return created && typeof created.id === "string" ? created.id : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the Step 3 image generator. First (and only in-app) choice is the
   * OpenArt MCP server; returns null when it isn't connected or exposes no
   * image-generation tool, in which case the caller falls back to exporting
   * prompts for manual generation + import. `modelOverride` forces a specific
   * OpenArt model id (per-frame edit runs); "auto"/undefined uses the config.
   */
  function openArtImageGen(p: Production, modelOverride?: string): ImageGenFn | null {
    const toolName = Object.keys(mcp.getTools()).find((n) => /^openart__/.test(n) && /generate.*image/i.test(n));
    if (!toolName) return null;
    const rawName = toolName.replace(/^openart__/, "");

    // Resolved lazily on the first shot (cache the folder-named project id for
    // the rest of the run); null when the lookup/create fails.
    let projectId: string | null | undefined;

    return async (prompt: string, refs: GenerationRef[]): Promise<Buffer> => {
      // Resolve the dropdown choice (incl. "auto") fresh per run, so edits to
      // the model dropdown are honored without an app restart.
      let models: OpenArtModelChoice[] = [];
      try {
        const raw = await mcp.callRaw("openart", "openart_model_list", {});
        models = openArtModelChoices(raw);
      } catch { models = []; }
      const cfgUsed: OpenArtBoardConfig = {
        ...(p.openArt ?? { model: "auto", resolution: "1k" }),
        ...(modelOverride ? { model: modelOverride } : {}),
      };

      // Upload reference art (deduped) so image-capable models can use it.
      // References are only meaningful under image2image (text2image exposes no
      // reference field), so their presence picks the mode below.
      // Each uploaded reference carries a unique string id (OpenArt's
      // visualReference id, falling back to its URL). The prompt already cites
      // refs by portable token (@image1, …) AND includes the alias-mapping
      // clause (see openArtPrompt) — here every token occurrence, including
      // those inside the mapping clause, is swapped for that ref's actual id,
      // so OpenArt receives exactly what Step 3 displays with real ids.
      const uploaded: Record<string, unknown>[] = [];
      const tokenToId: { token: string; id: string }[] = [];
      for (const [i, r] of refs.entries()) {
        try {
          const vr = await uploadDataUrlReference(mcp, r.dataUrl, r.name);
          uploaded.push(vr);
          const id = String((vr as { id?: unknown }).id ?? (vr as { url?: unknown }).url ?? "").trim();
          if (id) tokenToId.push({ token: refToken(i), id });
        } catch { /* non-fatal: ref falls back to text-only */ }
      }
      let fullPrompt = prompt;
      for (const { token, id } of tokenToId) {
        fullPrompt = fullPrompt.split(token).join(id);
      }
      const hasRefs = refs.length > 0;
      const mode = hasRefs ? "image2image" : "text2image";

      // Fetch the resolved model's actual form so we know the real field names
      // (aspectRatio, resolution/resolutionTier, imageCount, visualReferences).
      // This is what makes 16:9 and references actually reach the generate call.
      const modelId = resolveOpenArtModel(cfgUsed.model, hasRefs, models);
      let formProps: Record<string, unknown> | null = null;
      if (modelId) {
        try {
          formProps = parseModelFormProperties(
            await mcp.callRaw("openart", "openart_model_form_get", { model: modelId, mode })
          );
        } catch { formProps = null; }
      }

      if (projectId === undefined) {
        try { projectId = await resolveOpenArtProject(p); } catch { projectId = null; }
      }
      const args = imageGenArgs(fullPrompt, uploaded, cfgUsed, models, projectId, mode, formProps);
      const { text, images } = await mcp.callRawFull("openart", rawName, args);
      if (images.length) return images[0];

      // OpenArt's generate tool is async — a PENDING submission carries the
      // historyId but no pixels. Wait for the finished image before giving up.
      const historyId = openArtHistoryId(text);
      if (historyId) {
        const done = await waitOpenArtImage(historyId);
        if (done) return done;
        // no image surfaced despite completion — fall through to URL scan
      }

      // Many MCP image tools return text containing a URL to the result.
      const url =
        text.match(/https:\/\/[^\s"')\]}>]+\.(?:png|jpe?g|webp)(?:\?[^\s"')\]}>]*)?/i)?.[0] ??
        text.match(/https:\/\/[^\s"')\]}>]+/)?.[0];
      if (!url) throw new Error(`OpenArt returned no image (${text.slice(0, 120) || "empty reply"})`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Couldn't download the generated image (HTTP ${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    };
  }

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

  /** Shared runner for the LLM/image-driven steps (3 & 4): status + log + persist. */
  async function runProductionStep(
    id: string,
    step: 3 | 4,
    label: string,
    fn: (p: Production, emit: (m: string, l?: ProductionEvent["level"]) => void) => Promise<void>,
    opts: { needsApiKey?: boolean } = {}
  ): Promise<Production> {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (!p.scenes.some((s) => s.shots.length)) throw new Error("No shots yet — ingest a script in Step 1 first.");
    if (opts.needsApiKey !== false && !settings.getApiKey()) {
      throw new Error("Add your Gab.ai API key in Settings first.");
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
        await fn(pq, (m, l) => productionEmit(id, m, l));
        productions.saveProduction(pq);
      });
    } catch (e) {
      const pErr = productions.loadProduction(id);
      if (pErr) { pErr.status[step] = "error"; productions.saveProduction(pErr); }
      productionEmit(id, friendlyApiError(e), "error");
      throw new Error(friendlyApiError(e));
    }
    return productions.loadProduction(id) ?? p;
  }

  // Step 3: storyboard frame generation (batched or single-shot). In-app
  // generation goes through the OpenArt MCP server; when that isn't
  // connected we export per-shot prompts instead so the user can generate
  // the frames elsewhere and import them (production:importBoards).
  const boardsOrPrompts = async (
    p: Production,
    emit: (m: string, l?: ProductionEvent["level"]) => void,
    genOpts: { maxShots?: number; regenerateAll?: boolean; onlyShotId?: string; shotIds?: string[] }
  ): Promise<void> => {
    const gen = openArtImageGen(p);
    if (!gen) {
      emit("OpenArt MCP isn't connected (no image-generation tool found), so frames can't be generated in-app.", "error");
      exportBoardPrompts(p, emit);
      emit("Generate the frames with those prompts, then use “Import frames…” (name each file with its shot number, e.g. 0100.png).", "info");
      p.status[3] = "todo";
      return;
    }
    emit("Using the OpenArt MCP server for image generation.");
    await generateBoards(p, gen, emit, genOpts);
  };

  ipcMain.handle("production:generateBoards", (_e, id: string, opts?: { maxShots?: number; regenerateAll?: boolean }) =>
    runProductionStep(id, 3, opts?.regenerateAll ? "regenerating all storyboards" : "storyboard generation", async (p, emit) => {
      await boardsOrPrompts(p, emit, opts ?? {});
    }, { needsApiKey: false })
  );

  ipcMain.handle("production:regenerateBoard", (_e, id: string, shotId: string) =>
    runProductionStep(id, 3, `regenerating one board`, async (p, emit) => {
      await boardsOrPrompts(p, emit, { onlyShotId: shotId });
    }, { needsApiKey: false })
  );

  // Step 3: regenerate several frames in parallel within ONE shared production
  // (single load + save, concurrency handled inside generateBoards — avoids
  // the clobber that parallel per-frame saves would cause).
  ipcMain.handle("production:regenerateBoards", (_e, id: string, shotIds: string[]) =>
    runProductionStep(id, 3, `regenerating ${(shotIds ?? []).length} boards`, async (p, emit) => {
      await boardsOrPrompts(p, emit, { shotIds: Array.isArray(shotIds) ? shotIds : [shotIds] });
    }, { needsApiKey: false })
  );

  // Step 3 fallback: write boards/prompts.md for manual generation.
  ipcMain.handle("production:boardPrompts", (_e, id: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    if (!p.scenes.some((s) => s.shots.length)) throw new Error("No shots yet — ingest a script in Step 1 first.");
    productionEmit(id, "Exporting storyboard prompts…");
    exportBoardPrompts(p, (m, l) => productionEmit(id, m, l));
    productions.saveProduction(p);
    return p;
  });

  // Step 3: per-frame copy — return the effective prompt (same source the export uses).
  ipcMain.handle("production:boardPrompt", (_e, id: string, shotId: string) => {
    const p = productions.loadProduction(id);
    if (!p) return null;
    const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
    return shot ? openArtPrompt(p, shot) : null;
  });

  // Step 3: persist a shot's editable board-prompt override (empty clears it).
  ipcMain.handle("production:updateBoardPrompt", (_e, id: string, shotId: string, prompt: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
    if (!shot) throw new Error("Shot not found.");
    const text = typeof prompt === "string" ? prompt.trim() : "";
    // The reference-alias clause is appended at display/submission time; strip
    // any copy the user's editor included so it never accumulates in storage.
    const clean = text ? stripReferenceClause(text) : "";
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
  });

  // Step 3: refresh — discard a shot's manual prompt and re-derive it from the
  // current design (style, brand, references) + script text.
  ipcMain.handle("production:refreshBoardPrompt", (_e, id: string, shotId: string) => {
    const p = productions.loadProduction(id);
    if (!p) throw new Error("Production not found.");
    const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
    if (!shot) throw new Error("Shot not found.");
    delete shot.prompt;
    shot.promptManual = false;
    if (p.promptOverrides) delete p.promptOverrides[shot.number];
    productions.saveProduction(p);
    productionEmit(id, `Shot ${shot.number}: prompt refreshed from the current design.`);
    return p;
  });

  // Step 3: OpenArt image-capable models for the model dropdown.
  ipcMain.handle("production:openArtModels", async () => {
    try {
      const raw = await mcp.callRaw("openart", "openart_model_list", {});
      const choices = openArtModelChoices(raw);
      return choices.length > 1 ? choices : [{ id: "auto", displayName: "Auto", description: "Cascade picks the best image model for each run.", imageInput: false, cost: null }];
    } catch {
      return [{ id: "auto", displayName: "Auto", description: "Cascade picks the best image model for each run.", imageInput: false, cost: null }];
    }
  });

  // Step 3 manual workflow: pick generated frames anywhere on disk.
  ipcMain.handle("production:pickBoardImages", async () => {
    const res = await dialog.showOpenDialog(win!, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    return res.canceled ? [] : res.filePaths;
  });

  // Step 3 manual workflow: import frames. Without explicit files, scans
  // <boards>/import/; with `shotId`, the first file goes to that shot;
  // otherwise files are matched by the 4-digit shot number in the filename.
  ipcMain.handle("production:importBoards", (_e, id: string, files?: string[], shotId?: string) => {
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
  ipcMain.handle("production:boardImage", (_e, id: string, shotId: string, index?: number) => {
    const p = productions.loadProduction(id);
    if (!p) return null;
    const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
    if (!shot) return null;
    // `index` selects an entry of the shot's frame history (0 = most recent
    // previous frame); omitted = the current frame.
    const rel = typeof index === "number" && index >= 0
      ? shot.artworkHistory?.[Math.floor(index)]
      : shot.artwork;
    if (!rel) return null;
    try {
      const buf = fs.readFileSync(assetPath(p, rel));
      const img = nativeImage.createFromBuffer(buf);
      const thumb = img && !img.isEmpty() && img.getSize().width > 640 ? img.resize({ width: 640 }) : img;
      return thumb && !thumb.isEmpty() ? thumb.toDataURL() : null;
    } catch {
      return null;
    }
  });

  // Step 3 per-frame edit: send the shot's current frame to OpenArt as a
  // visual reference with the user's edit prompt, using an image-input model.
  // The result becomes the new current frame; the previous one moves into the
  // shot's history (browsable with the frame arrows).
  ipcMain.handle("production:editBoard", (_e, id: string, shotId: string, model: string, prompt: string) =>
    runProductionStep(id, 3, "editing one board", async (p, emit) => {
      const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
      if (!shot) throw new Error("Shot not found.");
      if (!shot.artwork) throw new Error("Generate or import a frame for this shot first - there's nothing to edit.");
      const text = typeof prompt === "string" ? prompt.trim() : "";
      if (!text) throw new Error('Describe the edit first (e.g. "make it night, add rain").');
      const modelId = typeof model === "string" && model.trim() && model !== "auto" ? model.trim() : undefined;
      const gen = openArtImageGen(p, modelId);
      if (!gen) throw new Error("OpenArt MCP isn't connected (no image-generation tool found), so frames can't be edited in-app.");
      const buf = fs.readFileSync(assetPath(p, shot.artwork));
      const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
      emit(`Shot ${shot.number}: editing frame${modelId ? ` via ${modelId}` : ""}...`);
      const png = await gen(
        `Edit this reference image (${refToken(0)}). Keep its composition unless asked otherwise.\n\nEdit instructions: ${text.slice(0, 1200)}`,
        [{ name: "Current frame", dataUrl }]
      );
      fs.mkdirSync(assetPath(p, p.assets.boardsDir), { recursive: true });
      const rel = `${p.assets.boardsDir}/shot-${shot.number}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.png`;
      fs.writeFileSync(assetPath(p, rel), png);
      recordBoardArtwork(shot, rel);
      productionEmit(id, `Shot ${shot.number}: frame edited.`);
    }, { needsApiKey: false })
  );

  // Step 4: animatic timing (one bounded LLM call).
  ipcMain.handle("production:planAnimatic", (_e, id: string) =>
    runProductionStep(id, 4, "animatic timing", async (p, emit) => {
      await planAnimatic(p, settings.getApiKey()!, settings.getModel(), emit);
    })
  );

  ipcMain.handle("agents:getSessionAgent", (_e, sessionId: string) => {

    const entry = chats.get(sessionId) ?? (sessions.loadSession(sessionId) ? live(sessionId) : null);
    return entry?.session.agentId ?? null;
  });
  ipcMain.handle("agents:setSessionAgent", (_e, sessionId: string, agentId: string | null) => {
    const entry = live(sessionId);
    curId = sessionId;
    const prev = entry.session.agentId ?? null;
    const next = agentId ?? null;
    if (prev === next) return;
    entry.session.agentId = next;
    // Insert a prominent switch frame into the transcript
    const display = (entry.session.display as unknown[]) as Array<Record<string, unknown>>;
    let switchName = "Default";
    let switchAvatar: unknown = null;
    let switchDescription = "";
    let switchModel = "";
    if (next) {
      const m = agents.getAgentMeta(next);
      if (m) { switchName = m.name; switchAvatar = m.avatar; switchDescription = m.description ?? ""; switchModel = m.model ?? ""; }
    }
    const frame: Record<string, unknown> = {
      kind: "agent-switch",
      agentId: next,
      name: switchName,
      description: switchDescription,
      model: switchModel,
      avatar: switchAvatar,
      at: new Date().toISOString(),
    };
    // attach avatar data url for rendering if image
    if (switchAvatar && (switchAvatar as { kind: string }).kind === "image" && next) {
      (frame as Record<string, unknown>).avatarDataUrl = agents.getAvatarDataUrl(next, switchAvatar as never);
    }
    display.push(frame);
    entry.session.display = display as unknown[];
    sessions.saveSession(entry.session);
    entry.agent?.stop();
    entry.agent = null;
    win?.webContents.send("agents:switched", { sessionId, agentId: next, frame });
  });
}

// ---- window ---------------------------------------------------------------
// Window title-bar / taskbar icon. In dev it's read straight from the build
// resource; when packaged it's copied into resources/ by extraResources.
function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(__dirname, "../../build/icon.png");
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 500,
    title: "Cascade",
    icon: appIconPath(),
    backgroundColor: "#111417",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Zoom shortcuts. Chromium's built-in binding misses Ctrl+= / Ctrl++ on
  // some layouts, so handle the whole family explicitly (and swallow the key
  // so it doesn't double-zoom).
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !input.control || input.alt || !win) return;
    const wc = win.webContents;
    const level = wc.getZoomLevel();
    if (input.key === "=" || input.key === "+") {
      event.preventDefault();
      wc.setZoomLevel(Math.min(level + 0.5, 5));
    } else if (input.key === "-" || input.key === "_") {
      event.preventDefault();
      wc.setZoomLevel(Math.max(level - 0.5, -5));
    } else if (input.key === "0") {
      event.preventDefault();
      wc.setZoomLevel(0);
    }
  });

  // Bringing the window forward cancels any attention flash.
  win.on("focus", () => win?.flashFrame(false));

  // External links open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });

  // Right-click context menu: native edit menu for inputs/textareas (Cut/Copy/
  // Paste/Select All), and a save/copy menu for images.
  win.webContents.on("context-menu", (_e, params) => {
    if (params.mediaType === "image" && params.srcURL) {
      Menu.buildFromTemplate([
        {
          label: "Save image as…",
          click: () => win?.webContents.downloadURL(params.srcURL), // triggers the native save dialog
        },
        {
          label: "Copy image",
          click: () => win?.webContents.copyImageAt(params.x, params.y),
        },
      ]).popup();
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
  registerIpc();
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
