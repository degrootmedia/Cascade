import { useEffect, useState } from "react";
import type { ModelInfo, SettingsView } from "../../../shared/ipc.js";
import { McpSection } from "./McpSection.js";
import { applyAccent } from "../theme.js";

const ACCENT_PRESETS = [
  { name: "Blue", value: "#4f8ef7" },
  { name: "Violet", value: "#a371f7" },
  { name: "Teal", value: "#2ea89a" },
  { name: "Green", value: "#57ab5a" },
  { name: "Orange", value: "#e0823d" },
  { name: "Pink", value: "#f778ba" },
];

export function SettingsPanel({ settings, onClose, onOpenAgents }: { settings: SettingsView; onClose: () => void; onOpenAgents?: () => void }) {
  const [apiKey, setApiKeyInput] = useState("");
  const [workspace, setWorkspace] = useState(settings.workspace);
  const [model, setModel] = useState(settings.model);
  const [accent, setAccent] = useState(settings.accent);
  const [externalEditor, setExternalEditor] = useState(settings.externalEditor);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [hasKey, setHasKey] = useState(settings.hasApiKey);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (hasKey) void window.cascade.listModels().then(setModels).catch(() => {});
  }, [hasKey]);

  async function saveKey() {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await window.cascade.setApiKey(apiKey.trim());
      setApiKeyInput("");
      setHasKey(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function pickWorkspace() {
    const dir = await window.cascade.pickWorkspace();
    if (dir) setWorkspace(dir);
  }

  async function changeModel(id: string) {
    setModel(id);
    await window.cascade.setModel(id);
  }

  /** Persist + live-apply a new accent color. */
  function changeAccent(color: string) {
    setAccent(color);
    applyAccent(color);
    void window.cascade.setAccent(color);
  }

  async function pickExternalEditor() {
    try {
      const picked = await window.cascade.pickExternalEditor();
      if (picked) setExternalEditor(picked);
    } catch (e) {
      setError(String(e));
    }
  }

  async function clearExternalEditor() {
    try {
      await window.cascade.setExternalEditor(null);
      setExternalEditor(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveExternalEditor(path: string | null) {
    const trimmed = path?.trim() ? path.trim() : null;
    // Allow WindowsApps even though it may not pass exists check — we bake elevation for it.
    try {
      await window.cascade.setExternalEditor(trimmed);
      setExternalEditor(trimmed);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  const ready = hasKey;

  return (
    <div className="modal-backdrop">
      <div className="modal settings">
        <h3>Settings</h3>

        <label>Gab.ai API key</label>
        {hasKey ? (
          <p className="hint">
            Key saved (encrypted). <button className="link" onClick={() => setHasKey(false)}>Replace</button>
          </p>
        ) : (
          <div className="row">
            <input
              type="password"
              value={apiKey}
              placeholder="gab_…"
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
            <button onClick={() => void saveKey()} disabled={saving || !apiKey.trim()}>
              Save
            </button>
          </div>
        )}

        <label>Default folder for new chats</label>
        <div className="row">
          <span className="path">{workspace ?? "None — pure chat"}</span>
          <button onClick={() => void pickWorkspace()}>Choose…</button>
          <button
            onClick={() => {
              setWorkspace(null);
              void window.cascade.clearDefaultWorkspace();
            }}
          >
            None
          </button>
        </div>
        <p className="hint">
          "None" makes new chats plain chat (no file access). Each chat can use its own folder — click the chip above
          the conversation to change it. Cascade can only read and change files inside the chat's folder.
        </p>

        <label>Model</label>
        <select value={model} onChange={(e) => void changeModel(e.target.value)} disabled={!hasKey}>
          {models.length === 0 && <option value={model}>{model}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
        <p className="hint">arya is cheapest; premium models use credits much faster.</p>

        <label>Accent color</label>
        <div className="accent-row">
          {ACCENT_PRESETS.map((p) => (
            <button
              key={p.value}
              className={`accent-swatch${accent.toLowerCase() === p.value ? " selected" : ""}`}
              style={{ background: p.value }}
              title={p.name}
              aria-label={`Accent color: ${p.name}`}
              onClick={() => changeAccent(p.value)}
            />
          ))}
          <input
            type="color"
            className="accent-custom"
            value={accent}
            title="Custom accent color"
            onChange={(e) => changeAccent(e.target.value)}
          />
        </div>
        <p className="hint">Highlights, links, and selection outlines. Applied immediately.</p>

        <label>External image editor</label>
        <div className="row">
          <input
            value={externalEditor ?? ""}
            placeholder="System default — paste path e.g. ...\WindowsApps\Affinity.exe"
            onChange={(e) => setExternalEditor(e.target.value || null)}
            onBlur={(e) => void saveExternalEditor(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setExternalEditor(settings.externalEditor); }}
            style={{ flex: 1, minWidth: 220 }}
            title={externalEditor ?? "System default"}
          />
          <button onClick={() => void pickExternalEditor()}>Choose…</button>
          {externalEditor && <button onClick={() => void clearExternalEditor()}>Clear</button>}
        </div>
        <p className="hint">
          Photoshop, Affinity, etc. Right-click any reference or generated frame and choose “Edit externally” to open it here.
          Windows Store apps (e.g. <code>...\WindowsApps\Affinity.exe</code>) are ACL-locked — the file picker can't enter that folder, so paste the full path above. It will be launched elevated (UAC) automatically.
        </p>

        <label>Agents</label>
        <p className="hint">
          Custom personas with their own prompt, model, avatar, and tools.
          {onOpenAgents && <> <button className="link" onClick={onOpenAgents}>Manage agents</button></>}
        </p>

        <label>Skills</label>
        <p className="hint">
          Markdown files that teach Cascade repeatable workflows. Drop .md files in the skills folder; Cascade
          reads them when relevant.{" "}
          <button className="link" onClick={() => void window.cascade.openSkillsFolder()}>
            Open skills folder
          </button>
        </p>

        {error && <p className="error-text">{error}</p>}

        <McpSection />

        <div className="modal-actions">
          <button className="primary" onClick={onClose} disabled={!ready}>
            {ready ? "Done" : "Add your API key to continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
