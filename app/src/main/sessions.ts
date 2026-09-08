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
}

const store = createStore<SessionFile>({
  dirName: "sessions",
  idOf: (s) => s.id,
  sortKey: (s) => s.updatedAt,
});

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
  if (typeof (s as { planMode?: unknown }).planMode !== "boolean") {
    (s as SessionFile).planMode = false;
  }
  store.save(s);
}

export function newSessionFile(workspace: string | null = null, agentId: string | null = null): SessionFile {
  const now = new Date().toISOString();
  return {
    id: store.newId(),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    workspace,
    pureChat: !workspace, // None by default unless a default folder is configured
    agentId: agentId ?? null,
    history: [],
    display: [],
    mentionImages: [],
    planMode: false,
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