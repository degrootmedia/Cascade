/**
 * Session persistence: one JSON file per conversation under
 * userData/sessions/. Stores both the model-facing history (for resuming the
 * agent) and the renderer display items (for restoring the UI faithfully).
 * The document lifecycle (list/load/save/remove/archive) is the shared store;
 * this module owns the session shape and its back-fill rules.
 */
import type { ChatMessage } from "@core";
import type { DisplayItem, SessionMeta } from "../shared/ipc.js";
import { createStore } from "./store.js";

export interface SessionFile {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Working folder for this chat; null falls back to the default in settings. */
  workspace: string | null;
  /** Pure chat: no workspace, no tools. When true, `workspace` is ignored. */
  pureChat: boolean;
  /** Follow the active Production Assistant project: the chat's folder mirrors
   *  whatever production is currently open, overriding `workspace`. */
  followProduction: boolean;
  /** Agent bound to this chat; null = Default (no agent). */
  agentId: string | null;
  /** The model-facing conversation history (for resuming the agent). */
  history: ChatMessage[];
  /** The renderer transcript (for restoring the UI faithfully). */
  display: DisplayItem[];
  /** Reference images the user picked for OpenArt (uploaded) — persisted with the chat. */
  mentionImages: string[];
  /** Plan mode: research + written plan first, mutations gated until approval. */
  planMode: boolean;
  /** Autonomous mode: full permission for this chat — the approval gate is
   *  skipped. Mutually exclusive with plan mode. */
  autonomousMode: boolean;
  /** Tool names the user granted "always allow" this session. Persisted so a
   *  rebuilt agent (production rebind, settings change) doesn't ask again. */
  allowedTools: string[];
  /** MCP server prefixes (e.g. "openart") granted "allow all" this session. */
  allowedToolGroups: string[];
}

const store = createStore<SessionFile>({
  dirName: "sessions",
  idOf: (s) => s.id,
  sortKey: (s) => s.updatedAt,
});

/** Clean a persisted grant list: strings only, trimmed, deduped, capped. */
function normalizeGrantList(v: unknown, max: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    if (!s || s.length > maxLen || seen.has(s)) continue;
    seen.add(s);
    if (out.length >= max) break;
    out.push(s);
  }
  return out;
}

/** Last user/assistant text snippet from a session's display items, for the sidebar. */
function previewOf(s: SessionFile): string {
  for (const it of s.display) {
    if ((it.kind === "user" || it.kind === "assistant") && it.text?.trim()) {
      const t = it.text.replace(/\s+/g, " ").trim();
      return t.length > 90 ? `${t.slice(0, 90)}…` : t;
    }
  }
  return "";
}

export function listSessions(): SessionMeta[] {
  return store.list().map((s) => ({
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    preview: previewOf(s),
  }));
}

export function loadSession(id: string): SessionFile | null {
  return store.load(id);
}

export function saveSession(s: SessionFile): void {
  s.updatedAt = new Date().toISOString();
  if (!Array.isArray(s.mentionImages)) s.mentionImages = [];
  if (!("agentId" in s) || s.agentId === undefined) (s as SessionFile).agentId = null;
  if (typeof (s as { pureChat?: unknown }).pureChat !== "boolean") {
    // Back-fill legacy sessions: pure chat unless a workspace was bound.
    (s as SessionFile).pureChat = !s.workspace;
  }
  if (typeof (s as { followProduction?: unknown }).followProduction !== "boolean") {
    // Legacy sessions never followed the Production Assistant project.
    (s as SessionFile).followProduction = false;
  }
  if (typeof (s as { planMode?: unknown }).planMode !== "boolean") {
    (s as SessionFile).planMode = false;
  }
  if (typeof (s as { autonomousMode?: unknown }).autonomousMode !== "boolean") {
    (s as SessionFile).autonomousMode = false;
  }
  s.allowedTools = normalizeGrantList((s as { allowedTools?: unknown }).allowedTools, 256, 128);
  s.allowedToolGroups = normalizeGrantList((s as { allowedToolGroups?: unknown }).allowedToolGroups, 64, 64);
  store.save(s);
}

/**
 * The effective folder a chat's agent may touch: following the active
 * Production Assistant project wins, then pure chat, then the per-chat folder,
 * then the default for new chats. Pure so the resolution is unit-testable.
 */
export function resolveWorkspace(
  s: Pick<SessionFile, "followProduction" | "pureChat" | "workspace">,
  activeProductionFolder: string | null,
  defaultWorkspace: string | null
): string | null {
  if (s.followProduction) return activeProductionFolder;
  if (s.pureChat) return null;
  return s.workspace ?? defaultWorkspace;
}

export function newSessionFile(
  workspace: string | null = null,
  agentId: string | null = null,
  followProduction = false,
  autonomousMode = false
): SessionFile {
  const now = new Date().toISOString();
  return {
    id: store.newId(),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    workspace,
    pureChat: !workspace && !followProduction, // None by default unless a default folder is configured
    followProduction,
    agentId: agentId ?? null,
    history: [],
    display: [],
    mentionImages: [],
    planMode: false,
    autonomousMode,
    allowedTools: [],
    allowedToolGroups: [],
  };
}

/** Permanently remove a session file. */
export function deleteSession(id: string): boolean {
  return store.remove(id);
}

/** Move a session out of the active list (kept on disk, restorable). */
export function archiveSession(id: string): boolean {
  return store.archive(id);
}