/**
 * Agent persistence: one JSON meta file + one .md prompt file per agent
 * under userData/agents/. Avatars are stored as agents/<id>.avatar.* when
 * custom images are used.
 */
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

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

function agentsDir(): string {
  const dir = path.join(app.getPath("userData"), "agents");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function metaPath(id: string): string {
  return path.join(agentsDir(), `${id}.json`);
}
function promptPath(id: string): string {
  return path.join(agentsDir(), `${id}.md`);
}
function archiveDir(): string {
  return path.join(agentsDir(), "archive");
}

function toMeta(f: AgentFile, hasPrompt: boolean): AgentMetaIpc {
  return { ...f, hasPrompt };
}

export function listAgents(): AgentMetaIpc[] {
  const dir = agentsDir();
  const out: AgentMetaIpc[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as AgentFile;
      const hasPrompt = fs.existsSync(promptPath(meta.id));
      out.push(toMeta(meta, hasPrompt));
    } catch {
      /* skip corrupt */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getAgent(id: string): { meta: AgentMetaIpc; prompt: string } | null {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(id), "utf8")) as AgentFile;
    let prompt = "";
    try {
      prompt = fs.readFileSync(promptPath(id), "utf8");
    } catch {
      /* no prompt yet */
    }
    return { meta: toMeta(meta, !!prompt), prompt };
  } catch {
    return null;
  }
}

export function getAgentPrompt(id: string): string {
  try {
    return fs.readFileSync(promptPath(id), "utf8");
  } catch {
    return "";
  }
}

export function getAgentMeta(id: string): AgentMetaIpc | null {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(id), "utf8")) as AgentFile;
    const hasPrompt = fs.existsSync(promptPath(meta.id));
    return toMeta(meta, hasPrompt);
  } catch {
    return null;
  }
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
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const meta: AgentFile = {
    id,
    name,
    description: (data.description ?? "").trim(),
    avatar: data.avatar ?? null,
    model: (data.model ?? "arya").trim() || "arya",
    allowedTools: data.allowedTools ?? "all",
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2), "utf8");
  fs.writeFileSync(promptPath(id), data.prompt ?? "", "utf8");
  return id;
}

export function updateAgent(
  id: string,
  patch: Partial<Omit<AgentFile, "id" | "createdAt">> & { prompt?: string }
): void {
  const raw = fs.readFileSync(metaPath(id), "utf8");
  const meta = JSON.parse(raw) as AgentFile;
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
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2), "utf8");
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
  // also generate 512px thumbnail if possible via nativeImage (best-effort)
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
  const newId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
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
  // strip hasPrompt helper
  const { hasPrompt: _hp, ...cleanMeta } = meta as AgentMetaIpc & { hasPrompt: boolean };
  void _hp;
  fs.writeFileSync(metaPath(newId), JSON.stringify(cleanMeta, null, 2), "utf8");
  fs.writeFileSync(promptPath(newId), src.prompt, "utf8");
  return newId;
}

export function deleteAgent(id: string): boolean {
  try {
    fs.rmSync(metaPath(id), { force: true });
    fs.rmSync(promptPath(id), { force: true });
    for (const f of fs.readdirSync(agentsDir())) {
      if (f.startsWith(`${id}.avatar.`)) {
        try { fs.unlinkSync(path.join(agentsDir(), f)); } catch {}
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function archiveAgent(id: string): boolean {
  const dir = archiveDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(metaPath(id), path.join(dir, `${id}.json`));
    if (fs.existsSync(promptPath(id))) {
      fs.renameSync(promptPath(id), path.join(dir, `${id}.md`));
    }
    for (const f of fs.readdirSync(agentsDir())) {
      if (f.startsWith(`${id}.avatar.`)) {
        try { fs.renameSync(path.join(agentsDir(), f), path.join(dir, f)); } catch {}
      }
    }
    return true;
  } catch {
    return false;
  }
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
    model: typeof parsed.model === "string" ? parsed.model : "arya",
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
