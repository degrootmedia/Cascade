import { useEffect, useState } from "react";
import type { AgentMeta, ModelInfo } from "../../../shared/ipc.js";
import { AgentHoverCard } from "./AgentIdCard.js";
import { AutoTextarea } from "./AutoTextarea.js";

const BUILTIN_TOOLS = ["read_file","write_file","edit_file","list_directory","glob","grep","run_command"];
const BUILTIN_LABELS: Record<string,string> = {
  read_file: "Read file", write_file: "Write file", edit_file: "Edit file",
  list_directory: "List directory", glob: "Glob", grep: "Grep", run_command: "Run command",
};

function toolGroups(mcpServers: string[]) {
  return [
    { label: "Filesystem & shell", tools: BUILTIN_TOOLS },
    ...mcpServers.map((s) => ({ label: s, tools: [`${s}__*`] as string[] })),
    { label: "Skills", tools: ["read_skill"] as string[] },
  ];
}

function Avatar({ avatar, dataUrl, size = 28 }: { avatar: AgentMeta["avatar"]; dataUrl?: string | null; size?: number }) {
  if (!avatar) return <span className="agent-card-avatar default" style={{ width: size, height: size }}>○</span>;
  if (avatar.kind === "emoji") return <span className="agent-card-avatar emoji" style={{ width: size, height: size, fontSize: size * 0.75 }}>{avatar.value}</span>;
  if (avatar.kind === "image" && dataUrl) return <img className="agent-card-avatar img" src={dataUrl} alt="" style={{ width: size, height: size }} />;
  return <span className="agent-card-avatar default" style={{ width: size, height: size }}>◐</span>;
}

export function AgentsPanel({ onClose, models }: { onClose: () => void; models: ModelInfo[] }) {
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [editing, setEditing] = useState<null | { id: string | null; prompt: string; meta: Partial<AgentMeta> & { avatar?: AgentMeta["avatar"] } }>(null);
  const [avatarDataUrls, setAvatarDataUrls] = useState<Record<string, string>>({});
  const [importOpen, setImportOpen] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [importMd, setImportMd] = useState("");

  const refresh = async () => {
    const list = await window.cascade.listAgents();
    setAgents(list);
    for (const a of list) {
      if (a.avatar?.kind === "image") {
        window.cascade.getAgent(a.id).then((d) => {
          if (d?.avatarDataUrl) setAvatarDataUrls((p) => ({ ...p, [a.id]: d.avatarDataUrl as string }));
        });
      }
    }
    try {
      const statuses = await window.cascade.getMcpStatus();
      setMcpServers(statuses.filter((s) => s.status !== "disabled").map((s) => s.name));
    } catch {}
  };
  useEffect(() => { void refresh(); }, []);

  const openNew = () => setEditing({ id: null, prompt: "", meta: { name: "", description: "", model: "arya", allowedTools: "all", avatar: null } });
  const openEdit = async (id: string) => {
    const d = await window.cascade.getAgent(id);
    if (!d) return;
    setEditing({ id, prompt: d.prompt, meta: { ...d.meta } });
  };

  const save = async () => {
    if (!editing) return;
    const name = (editing.meta.name ?? "").trim();
    if (!name) { alert("Name is required"); return; }
    const allowedTools = editing.meta.allowedTools as "all" | string[] | undefined;
    if (editing.id) {
      await window.cascade.updateAgent(editing.id, { name, description: editing.meta.description ?? "", model: editing.meta.model ?? "arya", allowedTools: allowedTools ?? "all", prompt: editing.prompt, avatar: editing.meta.avatar ?? null });
    } else {
      await window.cascade.createAgent({ name, description: editing.meta.description ?? "", model: editing.meta.model ?? "arya", allowedTools: allowedTools ?? "all", prompt: editing.prompt, avatar: editing.meta.avatar ?? null });
    }
    setEditing(null);
    void refresh();
  };

  const groups = toolGroups(mcpServers);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal agents-modal" onClick={(e) => e.stopPropagation()} style={{ width: "min(780px, 96vw)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Agents</h3>
          <button className="link" onClick={onClose}>Close</button>
        </div>
        <p className="hint">Agents are available in every workspace. Each has its own prompt (<code>.md</code>), model, avatar, and allowed tools. Chats can switch agents at any time.</p>

        <div style={{ display: "flex", gap: 8, margin: "12px 0", flexWrap: "wrap" }}>
          <button className="primary" onClick={openNew} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--accent)", color: "white", cursor: "pointer" }}>+ New agent</button>
          <button onClick={() => setImportOpen((v) => !v)} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-raised)", color: "var(--text)", cursor: "pointer" }}>Import…</button>
        </div>

        {importOpen && (
          <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, marginBottom: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ fontWeight: 600 }}>Import agent — paste JSON and Markdown</label>
            <AutoTextarea value={importJson} onChange={(e) => setImportJson(e.target.value)} placeholder='{"name":"My Agent", ...}' maxHeight={220} style={{ width: "100%", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: 8, fontFamily: "monospace", fontSize: "0.85rem" }} />
            <AutoTextarea value={importMd} onChange={(e) => setImportMd(e.target.value)} placeholder="System prompt Markdown…" maxHeight={220} style={{ width: "100%", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: 8 }} />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="primary" onClick={async () => { try { await window.cascade.importAgent(importJson, importMd); setImportJson(""); setImportMd(""); setImportOpen(false); void refresh(); } catch (e) { alert(String(e)); } }} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--accent)", background: "var(--accent)", color: "white", cursor: "pointer" }}>Import</button>
              <button onClick={() => setImportOpen(false)} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-raised)", color: "var(--text)", cursor: "pointer" }}>Cancel</button>
            </div>
          </div>
        )}

        <div className="agents-grid">
          {agents.length === 0 && <div className="hint">No agents yet. Create one above.</div>}
          {agents.map((a) => (
            <div key={a.id} className="agent-card">
              <div className="agent-card-head">
                <AgentHoverCard meta={a} avatarDataUrl={avatarDataUrls[a.id]}>
                  <span style={{ display: "inline-flex" }}><Avatar avatar={a.avatar} dataUrl={avatarDataUrls[a.id]} size={32} /></span>
                </AgentHoverCard>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="agent-card-name">{a.name}</div>
                  <div className="agent-card-desc">{a.description || "—"}</div>
                </div>
                <span className="agent-card-model">{a.model}</span>
              </div>
              <div className="agent-card-tools hint" style={{ fontSize: "0.78rem" }}>
                {a.allowedTools === "all" ? "All tools" : (a.allowedTools as string[]).join(", ") || "No tools"}
                {a.hasPrompt ? " · has prompt" : " · no prompt"}
              </div>
              <div className="agent-card-actions">
                <button onClick={() => void openEdit(a.id)}>Edit</button>
                <button onClick={async () => { await window.cascade.duplicateAgent(a.id); void refresh(); }}>Duplicate</button>
                <button onClick={async () => {
                  const ex = await window.cascade.exportAgent(a.id);
                  if (!ex) return;
                  const blob1 = new Blob([ex.json], { type: "application/json" });
                  const url1 = URL.createObjectURL(blob1);
                  const a1 = document.createElement("a"); a1.href = url1; a1.download = `${a.name.replace(/[^a-z0-9_-]/gi, "_")}.json`; a1.click(); URL.revokeObjectURL(url1);
                  const blob2 = new Blob([ex.md], { type: "text/markdown" });
                  const url2 = URL.createObjectURL(blob2);
                  const a2 = document.createElement("a"); a2.href = url2; a2.download = `${a.name.replace(/[^a-z0-9_-]/gi, "_")}.md`; a2.click(); URL.revokeObjectURL(url2);
                }}>Export</button>
                <button onClick={async () => { if (!confirm(`Archive "${a.name}"?`)) return; await window.cascade.removeAgent(a.id, "archive"); void refresh(); }}>Archive</button>
                <button className="danger" onClick={async () => { if (!confirm(`Delete "${a.name}" permanently?`)) return; await window.cascade.removeAgent(a.id, "delete"); void refresh(); }}>Delete</button>
              </div>
            </div>
          ))}
        </div>

        {editing && (
          <div className="modal-backdrop" onClick={() => setEditing(null)} style={{ zIndex: 20 }}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: "min(640px, 96vw)" }}>
              <h3 style={{ marginTop: 0 }}>{editing.id ? "Edit agent" : "New agent"}</h3>
              <label>Name</label>
              <input value={editing.meta.name ?? ""} onChange={(e) => setEditing({ ...editing, meta: { ...editing.meta, name: e.target.value } })} placeholder="Researcher" style={{ width: "100%", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px" }} />
              <label>Description</label>
              <input value={editing.meta.description ?? ""} onChange={(e) => setEditing({ ...editing, meta: { ...editing.meta, description: e.target.value } })} placeholder="What this agent does…" style={{ width: "100%", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px" }} />
              <label>Avatar</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input value={editing.meta.avatar?.kind === "emoji" ? editing.meta.avatar.value : ""} onChange={(e) => setEditing({ ...editing, meta: { ...editing.meta, avatar: e.target.value ? { kind: "emoji", value: e.target.value.slice(0, 4) } : null } })} placeholder="Emoji (e.g. 🧪)" style={{ width: 120, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px" }} />
                <span className="hint">or upload image:</span>
                <input type="file" accept="image/*" onChange={async (e) => {
                  const file = e.target.files?.[0]; if (!file) return;
                  const dataUrl = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(file); });
                  // For new agents, create first to get an id, then upload; for existing, upload directly
                  if (!editing.id) {
                    // stash as emoji hack: store dataUrl in a temp field, will be handled on save
                    // simplest: create the agent now with placeholder, then upload
                    const name = (editing.meta.name ?? "").trim() || "Agent";
                    const id = await window.cascade.createAgent({ name, description: editing.meta.description ?? "", model: editing.meta.model ?? "arya", allowedTools: (editing.meta.allowedTools as "all"|string[]) ?? "all", prompt: editing.prompt, avatar: null });
                    await window.cascade.uploadAgentAvatar(id, dataUrl);
                    setEditing(null);
                    void refresh();
                  } else {
                    await window.cascade.uploadAgentAvatar(editing.id, dataUrl);
                    const d = await window.cascade.getAgent(editing.id);
                    if (d) setEditing({ ...editing, meta: { ...editing.meta, avatar: d.meta.avatar } });
                  }
                }} />
                {editing.meta.avatar && <span className="hint">{editing.meta.avatar.kind === "emoji" ? editing.meta.avatar.value : editing.meta.avatar.kind === "image" ? "Image ✓" : "No avatar"}</span>}
                {editing.meta.avatar && <button className="link" onClick={() => setEditing({ ...editing, meta: { ...editing.meta, avatar: null } })}>Clear</button>}
              </div>
              <label>Model</label>
              <select value={editing.meta.model ?? "arya"} onChange={(e) => setEditing({ ...editing, meta: { ...editing.meta, model: e.target.value } })} style={{ width: "100%", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px" }}>
                {models.length ? [...models].sort((a, b) => a.baseCost - b.baseCost || a.id.localeCompare(b.id)).map((m) => <option key={m.id} value={m.id}>{m.id}</option>) : <option value="arya">arya</option>}
                {!models.find((m) => m.id === editing.meta.model) && editing.meta.model && <option value={editing.meta.model}>{editing.meta.model}</option>}
              </select>
              <label>Allowed tools</label>
              <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 400 }}><input type="radio" checked={editing.meta.allowedTools === "all"} onChange={() => setEditing({ ...editing, meta: { ...editing.meta, allowedTools: "all" } })} /> All</label>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 400 }}><input type="radio" checked={Array.isArray(editing.meta.allowedTools)} onChange={() => setEditing({ ...editing, meta: { ...editing.meta, allowedTools: [...BUILTIN_TOOLS] } })} /> Custom</label>
              </div>
              {Array.isArray(editing.meta.allowedTools) && (
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                  {groups.map((g) => (
                    <div key={g.label}>
                      <div style={{ fontSize: "0.78rem", color: "var(--text-dim)", marginBottom: 4 }}>{g.label}</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {(g.label === "Filesystem & shell" ? g.tools.map((t) => ({ id: t, label: BUILTIN_LABELS[t] ?? t })) : g.tools.map((t) => ({ id: t, label: t }))).map((t) => {
                          const checked = (editing.meta.allowedTools as string[]).includes(t.id);
                          return (
                            <label key={t.id} style={{ display: "flex", gap: 4, alignItems: "center", fontWeight: 400, fontSize: "0.85rem" }}>
                              <input type="checkbox" checked={checked} onChange={(e) => {
                                const cur = new Set(editing.meta.allowedTools as string[]);
                                if (e.target.checked) cur.add(t.id); else cur.delete(t.id);
                                setEditing({ ...editing, meta: { ...editing.meta, allowedTools: Array.from(cur) } });
                              }} />
                              {t.label}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  {Array.isArray(editing.meta.allowedTools) && editing.meta.allowedTools.length === 0 && <span className="hint" style={{ color: "var(--danger)" }}>No tools selected — agent won't be able to act.</span>}
                </div>
              )}
              <label>System prompt — saved as <code>{editing.meta.name ? `${editing.meta.name.replace(/[^a-z0-9_-]/gi, "_")}.md` : "<name>.md"}</code></label>
              <AutoTextarea value={editing.prompt} onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} maxHeight={Math.round(window.innerHeight * 0.4)} placeholder="You are a helpful..." style={{ width: "100%", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: 8, fontFamily: "monospace", fontSize: "0.9rem" }} />
              <div className="modal-actions">
                <button onClick={() => setEditing(null)}>Cancel</button>
                <button className="primary" onClick={() => void save()}>Save</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
