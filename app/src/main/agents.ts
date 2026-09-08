/**
 * Agent persistence: one JSON meta file + one .md prompt file per agent
 * under userData/agents/. Avatars are stored as agents/<id>.avatar.* when
 * custom images are used. The meta JSON goes through the shared store; the
 * prompt and avatar side files ride along via the store's sideFiles hooks.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createStore } from "./store.js";

export type AvatarKind = { kind: "emoji"; value: string } | { kind: "image"; path: string } | null;

export interface AgentFile {
  id: string;
  name: string;
  description: string;
  avatar: AvatarKind;
  model: string;
  allowedTools: "all" | string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentMetaIpc {
  id: string;
  name: string;
  description: string;
  avatar: AvatarKind;
  model: string;
  allowedTools: "all" | string[];
  createdAt: string;
  updatedAt: string;
  hasPrompt: boolean;
}

function promptPath(id: string): string {
  return path.join(agentsDir(), `${id}.md`);
}
function archiveDir(): string {
  return path.join(agentsDir(), "archive");
}

const store = createStore<AgentFile>({
  dirName: "agents",
  idOf: (a) => a.id,
  sortKey: (a) => a.updatedAt,
  // The store moves/deletes the meta .json; the prompt .md and avatar files
  // follow it into archive/ (or are removed) here.
  sideFiles: {
    archive: (id, archiveDir) => {
      const md = promptPath(id);
      if (fs.existsSync(md)) fs.renameSync(md, path.join(archiveDir, `${id}.md`));
      for (const f of fs.readdirSync(agentsDir())) {
        if (f.startsWith(`${id}.avatar.`)) {
          try { fs.renameSync(path.join(agentsDir(), f), path.join(archiveDir, f)); } catch { /* best-effort */ }
        }
      }
    },
    remove: (id) => {
      fs.rmSync(promptPath(id), { force: true });
      for (const f of fs.readdirSync(agentsDir())) {
        if (f.startsWith(`${id}.avatar.`)) {
          try { fs.unlinkSync(path.join(agentsDir(), f)); } catch { /* best-effort */ }
        }
      }
    },
  },
});

function agentsDir(): string {
  return store.dir();
}

function toMeta(f: AgentFile, hasPrompt: boolean): AgentMetaIpc {
  return { ...f, hasPrompt };
}

export function listAgents(): AgentMetaIpc[] {
  return store.list().map((meta) => toMeta(meta, fs.existsSync(promptPath(meta.id))));
}

export function getAgent(id: string): { meta: AgentMetaIpc; prompt: string } | null {
  const meta = store.load(id);
  if (!meta) return null;
  return { meta: toMeta(meta, fs.existsSync(promptPath(id))), prompt: getAgentPrompt(id) };
}

export function getAgentPrompt(id: string): string {
  try {
    return fs.readFileSync(promptPath(id), "utf8");
  } catch {
    return "";
  }
}

export function getAgentMeta(id: string): AgentMetaIpc | null {
  const meta = store.load(id);
  return meta ? toMeta(meta, fs.existsSync(promptPath(meta.id))) : null;
}

function slugFor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "agent";
}

export function createAgent(data: {
  name: string;
  description?: string;
  avatar?: AvatarKind;
  model?: string;
  allowedTools?: "all" | string[];
  prompt?: string;
}): string {
  const name = data.name?.trim();
  if (!name) throw new Error("Agent name is required");
  const id = store.newId();
  const now = new Date().toISOString();
  const meta: AgentFile = {
    id,
    name,
    description: (data.description ?? "").trim(),
    avatar: data.avatar ?? null,
    // Empty model = follow the app's selected model at run time.
    model: (data.model ?? "").trim(),
    allowedTools: data.allowedTools ?? "all",
    createdAt: now,
    updatedAt: now,
  };
  store.save(meta);
  fs.writeFileSync(promptPath(id), data.prompt ?? "", "utf8");
  return id;
}

export function updateAgent(
  id: string,
  patch: Partial<Omit<AgentFile, "id" | "createdAt">> & { prompt?: string }
): void {
  const meta = store.load(id);
  if (!meta) throw new Error("Agent not found");
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (!n) throw new Error("Agent name is required");
    meta.name = n;
  }
  if (patch.description !== undefined) meta.description = patch.description.trim();
  if (patch.avatar !== undefined) meta.avatar = patch.avatar;
  if (patch.model !== undefined) meta.model = patch.model.trim() || meta.model;
  if (patch.allowedTools !== undefined) meta.allowedTools = patch.allowedTools;
  meta.updatedAt = new Date().toISOString();
  store.save(meta);
  if (patch.prompt !== undefined) {
    fs.writeFileSync(promptPath(id), patch.prompt, "utf8");
  }
}

export function saveAgentAvatar(id: string, dataUrl: string): string {
  // dataUrl like data:image/png;base64,....
  const m = /^data:(image\/(png|jpeg|jpg|webp|gif));base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error("Invalid image data URL");
  const ext = m[2] === "jpeg" ? "jpg" : m[2];
  const buf = Buffer.from(m[3], "base64");
  if (buf.length > 2 * 1024 * 1024) throw new Error("Avatar image must be under 2 MB");
  // remove old avatar files for this agent
  for (const f of fs.readdirSync(agentsDir())) {
    if (f.startsWith(`${id}.avatar.`)) {
      try { fs.unlinkSync(path.join(agentsDir(), f)); } catch {}
    }
  }
  const filename = `${id}.avatar.${ext}`;
  fs.writeFileSync(path.join(agentsDir(), filename), buf);
  return filename;
}

export function getAvatarDataUrl(id: string, avatar: AvatarKind): string | null {
  if (!avatar || avatar.kind !== "image") return null;
  const p = path.join(agentsDir(), avatar.path);
  try {
    const buf = fs.readFileSync(p);
    const ext = path.extname(avatar.path).slice(1) || "png";
    const mime = ext === "jpg" ? "jpeg" : ext;
    return `data:image/${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

export function duplicateAgent(id: string): string {
  const src = getAgent(id);
  if (!src) throw new Error("Agent not found");
  const newId = store.newId();
  const now = new Date().toISOString();
  const meta: AgentFile = {
    ...src.meta,
    id: newId,
    name: `${src.meta.name} (copy)`,
    createdAt: now,
    updatedAt: now,
  };
  // copy avatar file if image
  if (src.meta.avatar?.kind === "image") {
    const srcPath = path.join(agentsDir(), src.meta.avatar.path);
    const ext = path.extname(src.meta.avatar.path);
    const destFilename = `${newId}.avatar${ext}`;
    try {
      fs.copyFileSync(srcPath, path.join(agentsDir(), destFilename));
      meta.avatar = { kind: "image", path: destFilename };
    } catch {
      meta.avatar = null;
    }
  }
  store.save(meta);
  fs.writeFileSync(promptPath(newId), src.prompt, "utf8");
  return newId;
}

export function deleteAgent(id: string): boolean {
  return store.remove(id);
}

export function archiveAgent(id: string): boolean {
  return store.archive(id);
}

export function importAgent(jsonText: string, mdText: string): string {
  let parsed: Partial<AgentFile>;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("Invalid agent JSON");
  }
  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (!name) throw new Error("Imported agent is missing a name");
  return createAgent({
    name,
    description: typeof parsed.description === "string" ? parsed.description : "",
    avatar: parsed.avatar && typeof parsed.avatar === "object" && "kind" in parsed.avatar ? (parsed.avatar as AvatarKind) : null,
    model: typeof parsed.model === "string" ? parsed.model : "",
    allowedTools: Array.isArray(parsed.allowedTools) || parsed.allowedTools === "all" ? parsed.allowedTools : "all",
    prompt: mdText ?? "",
  });
}

export function listArchivedAgents(): AgentMetaIpc[] {
  const dir = archiveDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const out: AgentMetaIpc[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as AgentFile;
        out.push(toMeta(meta, fs.existsSync(path.join(dir, `${meta.id}.md`))));
      } catch {}
    }
  } catch {}
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}