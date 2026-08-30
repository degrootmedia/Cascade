/**
 * Session persistence: one JSON file per conversation under
 * userData/sessions/. Stores both the model-facing history (for resuming the
 * agent) and the renderer display items (for restoring the UI faithfully).
 */
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionMeta } from "../shared/ipc.js";

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
  history: unknown[]; // core ChatMessage[]
  display: unknown[]; // renderer display items
  /** Reference images the user picked for OpenArt (uploaded) — persisted with the chat. */
  mentionImages: string[];
}

function sessionsDir(): string {
  const dir = path.join(app.getPath("userData"), "sessions");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Last user/assistant text snippet from a session's display items, for the sidebar. */
function previewOf(s: SessionFile): string {
  const disp = Array.isArray(s.display) ? (s.display as Array<{ kind?: string; text?: string }>) : [];
  for (let i = disp.length - 1; i >= 0; i--) {
    const it = disp[i];
    if ((it.kind === "user" || it.kind === "assistant") && typeof it.text === "string" && it.text.trim()) {
      const t = it.text.replace(/\s+/g, " ").trim();
      return t.length > 90 ? `${t.slice(0, 90)}…` : t;
    }
  }
  return "";
}

export function listSessions(): SessionMeta[] {
  const metas: SessionMeta[] = [];
  for (const f of fs.readdirSync(sessionsDir())) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), "utf8")) as SessionFile;
      metas.push({ id: s.id, title: s.title, updatedAt: s.updatedAt, preview: previewOf(s) });
    } catch {
      /* skip corrupt files */
    }
  }
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function loadSession(id: string): SessionFile | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionsDir(), `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

export function saveSession(s: SessionFile): void {
  s.updatedAt = new Date().toISOString();
  if (!Array.isArray(s.mentionImages)) s.mentionImages = [];
  if (!("agentId" in s) || s.agentId === undefined) (s as SessionFile).agentId = null;
  if (typeof (s as { pureChat?: unknown }).pureChat !== "boolean") {
    // Back-fill legacy sessions: pure chat unless a workspace was bound.
    (s as SessionFile).pureChat = !s.workspace;
  }
  fs.writeFileSync(path.join(sessionsDir(), `${s.id}.json`), JSON.stringify(s), "utf8");
}

export function newSessionFile(workspace: string | null = null, agentId: string | null = null): SessionFile {
  const now = new Date().toISOString();
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    workspace,
    pureChat: !workspace, // None by default unless a default folder is configured
    agentId: agentId ?? null,
    history: [],
    display: [],
    mentionImages: [],
  };
}

/** Back-fill older sessions saved before the mentionImages field existed. */
export function hasMentionImages(s: SessionFile): s is SessionFile & { mentionImages: string[] } {
  return Array.isArray((s as { mentionImages?: unknown }).mentionImages);
}

function sessionFilePath(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

/** Permanently remove a session file. */
export function deleteSession(id: string): boolean {
  try {
    fs.rmSync(sessionFilePath(id), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Move a session out of the active list (kept on disk, restorable). */
export function archiveSession(id: string): boolean {
  const src = sessionFilePath(id);
  const archiveDir = path.join(app.getPath("userData"), "sessions", "archive");
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.renameSync(src, path.join(archiveDir, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}
