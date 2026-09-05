import { useEffect, useMemo, useState } from "react";
import type { ExpensePriceRule, ModelInfo, OpenArtModelChoice, SettingsView } from "../../../shared/ipc.js";
import { API_PROVIDERS } from "../../../shared/providers.js";
import { McpSection } from "./McpSection.js";
import { applyAccent } from "../theme.js";
import { uid } from "./production/hex.js";

const ACCENT_PRESETS = [
  { name: "Blue", value: "#4f8ef7" },
  { name: "Violet", value: "#a371f7" },
  { name: "Teal", value: "#2ea89a" },
  { name: "Green", value: "#57ab5a" },
  { name: "Orange", value: "#e0823d" },
  { name: "Pink", value: "#f778ba" },
];

/** Editable price-rule row draft (text fields so number inputs don't fight
 *  the user mid-keystroke; parsed into ExpensePriceRule on save). */
interface PriceDraft {
  id: string;
  kind: "image" | "video";
  model: string;
  resolution: string;
  durationText: string;
  priceText: string;
}

const RESOLUTION_SUGGESTIONS = ["1k", "2k", "4k", "480p", "720p", "1080p", "4K"];

/** Persisted rules → editable draft rows (text fields for number inputs). */
const rulesToDrafts = (rules: ExpensePriceRule[]): PriceDraft[] =>
  rules.map((r) => ({
    id: r.id,
    kind: r.kind,
    model: r.model,
    resolution: r.resolution,
    durationText: r.durationSec == null ? "" : String(r.durationSec),
    priceText: String(r.price),
  }));

/** Settings → Expense pricing: rules that turn a generation's (kind, model,
 *  resolution, video length) into a dollar amount. Blank fields = any. */
function ExpensePricingSection() {
  const [drafts, setDrafts] = useState<PriceDraft[]>([]);
  const [models, setModels] = useState<OpenArtModelChoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void window.cascade
      .getExpensePriceRules()
      .then((rules) => setDrafts(rulesToDrafts(rules)))
      .catch((e) => setError(String(e)));
    void window.cascade.listOpenArtModels().then(setModels).catch(() => {});
  }, []);

  const update = (i: number, patch: Partial<PriceDraft>) => {
    setNote(null);
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  };

  const addRule = () => {
    setNote(null);
    setDrafts((ds) => [
      ...ds,
      { id: uid("expense-rule"), kind: "image", model: "", resolution: "", durationText: "", priceText: "" },
    ]);
  };

  const removeRule = (i: number) => {
    setNote(null);
    setDrafts((ds) => ds.filter((_, j) => j !== i));
  };

  const toRules = (): ExpensePriceRule[] =>
    drafts.map((d) => ({
      id: d.id,
      kind: d.kind,
      model: d.model.trim(),
      resolution: d.resolution.trim(),
      durationSec: d.kind === "video" && d.durationText.trim() ? Number(d.durationText) || null : null,
      price: Number(d.priceText) || 0,
    }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.cascade.setExpensePriceRules(toRules());
      setNote("Prices saved.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const exportRules = async () => {
    setBusy(true);
    setError(null);
    try {
      const file = await window.cascade.exportExpensePriceRules();
      setNote(file ? `Exported ${drafts.length} rules to ${file}.` : null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const exportTemplate = async () => {
    setBusy(true);
    setError(null);
    try {
      const file = await window.cascade.exportExpensePriceTemplate();
      setNote(
        file
          ? `Template saved to ${file} — fill in the prices, then Import CSV.`
          : "No models available to build a template (is OpenArt connected?)."
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const importRules = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.cascade.importExpensePriceRules();
      if (res) {
        setDrafts(rulesToDrafts(res.rules));
        setNote(`Imported ${res.rules.length} rules from ${res.path}.`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label>Expense pricing</label>
      <p className="hint">
        Price per generation: kind · model · resolution (and video length). A blank field means "any";
        exact matches win over wildcards, and generations matching nothing count as $0. Use
        <strong> Export template</strong> to get every model × resolution × video-length combination at $0,
        fill in the prices, then <strong>Import CSV</strong>.
      </p>
      <div className="expense-pricing">
        <div className="expense-rule expense-rule-head">
          <span>Kind</span>
          <span>Model</span>
          <span>Resolution</span>
          <span>Length (video)</span>
          <span>Price</span>
          <span />
        </div>
        {drafts.map((d, i) => (
          <div className="expense-rule" key={d.id}>
            <select value={d.kind} onChange={(e) => update(i, { kind: e.target.value as PriceDraft["kind"] })}>
              <option value="image">image</option>
              <option value="video">video</option>
            </select>
            <select value={d.model || "*"} onChange={(e) => update(i, { model: e.target.value === "*" ? "" : e.target.value })}>
              <option value="*">Any model</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.displayName}</option>
              ))}
            </select>
            <input
              value={d.resolution}
              list="expense-resolutions"
              placeholder="any"
              onChange={(e) => update(i, { resolution: e.target.value })}
            />
            {d.kind === "video" ? (
              <input
                type="number"
                min="1"
                placeholder="any"
                value={d.durationText}
                onChange={(e) => update(i, { durationText: e.target.value })}
              />
            ) : (
              <span className="hint">—</span>
            )}
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="$0.00"
              value={d.priceText}
              onChange={(e) => update(i, { priceText: e.target.value })}
            />
            <button className="link" onClick={() => removeRule(i)} title="Remove price rule">×</button>
          </div>
        ))}
        <datalist id="expense-resolutions">
          {RESOLUTION_SUGGESTIONS.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <div className="expense-pricing-actions">
          <button onClick={addRule} disabled={busy}>+ Add price</button>
          <button className="primary" onClick={() => void save()} disabled={busy}>
            {busy ? "Working…" : "Save prices"}
          </button>
          <button onClick={() => void exportRules()} disabled={busy} title="Save the rules above to a CSV file">
            Export CSV
          </button>
          <button onClick={() => void importRules()} disabled={busy} title="Load price rules from a CSV file">
            Import CSV
          </button>
          <button onClick={() => void exportTemplate()} disabled={busy} title="Pre-fill every model × resolution × video-length combination at $0">
            Export template
          </button>
          {note && <span className="hint" title={note}>{note.length > 90 ? `${note.slice(0, 90)}…` : note}</span>}
        </div>
      </div>
      {error && <p className="error-text">{error}</p>}
    </>
  );
}

export function SettingsPanel({ settings, onClose, onOpenAgents }: { settings: SettingsView; onClose: () => void; onOpenAgents?: () => void }) {
  const [provider, setProvider] = useState(settings.provider);
  const [apiKey, setApiKeyInput] = useState("");
  const [workspace, setWorkspace] = useState(settings.workspace);
  const [model, setModel] = useState(settings.model);
  const [accent, setAccent] = useState(settings.accent);
  const [externalEditor, setExternalEditor] = useState(settings.externalEditor);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [hasKey, setHasKey] = useState(settings.hasApiKey);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Why the model list is empty (real HTTP/API message, shown inline). */
  const [modelError, setModelError] = useState<string | null>(null);
  /** Which settings tab is open. */
  const [tab, setTab] = useState<"general" | "expenses">("general");
  /** 3D AI Studio API key (design-page 3D model generator). */
  const [has3daiKey, setHas3daiKey] = useState(settings.has3daiApiKey);
  const [apiKey3dai, setApiKey3daiInput] = useState("");

  const providerLabel = API_PROVIDERS.find((p) => p.id === provider)?.label ?? provider;

  // Cheapest first; stable by id for ties.
  const sortedModels = useMemo(
    () => [...models].sort((a, b) => a.baseCost - b.baseCost || a.id.localeCompare(b.id)),
    [models]
  );

  useEffect(() => {
    if (hasKey) void loadModels();
  }, [hasKey]);

  // A provider may have no stored model yet (or its saved model is gone) —
  // fall back to its first listed model so we never send an empty model.
  useEffect(() => {
    if (sortedModels.length === 0) return;
    if (!sortedModels.some((m) => m.id === model)) {
      void changeModel(sortedModels[0].id);
    }
  }, [sortedModels, model]);

  /** Fetch the current provider's models; surfaces the real failure reason. */
  async function loadModels(): Promise<ModelInfo[]> {
    const res = await window.cascade.listModels();
    if (!res.ok) {
      setModelError(res.error);
      return [];
    }
    setModelError(null);
    return res.models;
  }

  async function changeProvider(id: string) {
    setProvider(id);
    setError(null);
    try {
      await window.cascade.setProvider(id);
      const s = await window.cascade.getSettings();
      setHasKey(s.hasApiKey);
      setModel(s.model);
      setApiKeyInput("");
      setModels(s.hasApiKey ? await loadModels() : []);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveKey() {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await window.cascade.setApiKey(apiKey.trim());
      setApiKeyInput("");
      setHasKey(true);
      // Refresh the model list for the current provider immediately — the
      // key just changed, so stale models (or an empty list) would be wrong.
      setModels(await loadModels());
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function save3daiKey() {
    if (!apiKey3dai.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await window.cascade.set3daiApiKey(apiKey3dai.trim());
      setApiKey3daiInput("");
      setHas3daiKey(true);
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

  async function refreshModels() {
    setError(null);
    setModels(await loadModels());
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

        <div className="settings-tabs" role="tablist">
          <button role="tab" className={"settings-tab" + (tab === "general" ? " active" : "")} onClick={() => setTab("general")}>General</button>
          <button role="tab" className={"settings-tab" + (tab === "expenses" ? " active" : "")} onClick={() => setTab("expenses")}>Expenses</button>
        </div>

        {tab === "general" && (
          <>
        <label>API provider</label>
        <select value={provider} onChange={(e) => void changeProvider(e.target.value)}>
          {API_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <p className="hint">Which API powers chat, auto-titles, and the production pipeline's LLM steps. Each provider keeps its own key and model.</p>

        <label>{providerLabel} API key</label>
        {hasKey ? (
          <p className="hint">
            Key saved (encrypted). <button className="link" onClick={() => setHasKey(false)}>Replace</button>
          </p>
        ) : (
          <div className="row">
            <input
              type="password"
              value={apiKey}
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
        <div className="row">
          <select value={model} onChange={(e) => void changeModel(e.target.value)} disabled={!hasKey} style={{ flex: 1 }}>
            {sortedModels.length === 0 && <option value={model}>{model}</option>}
            {sortedModels.map((m) => (
              <option key={m.id} value={m.id} title={m.costTitle}>
                {m.costLabel.startsWith("$") ? `${m.id} (${m.costLabel})` : m.id}
              </option>
            ))}
          </select>
          <button onClick={() => void refreshModels()} disabled={!hasKey} title="Re-fetch the model list from this provider">
            Refresh models
          </button>
        </div>
        {hasKey && models.length === 0 && modelError && <p className="error-text">{modelError}</p>}
        <p className="hint">Models are listed cheapest first. Hover a cost badge in the header picker for details.</p>

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

        <label>3D AI Studio API key</label>
        {has3daiKey ? (
          <p className="hint">
            Key saved (encrypted). <button className="link" onClick={() => setHas3daiKey(false)}>Replace</button>
          </p>
        ) : (
          <div className="row">
            <input
              type="password"
              value={apiKey3dai}
              placeholder="3D AI Studio API key"
              onChange={(e) => setApiKey3daiInput(e.target.value)}
            />
            <button onClick={() => void save3daiKey()} disabled={saving || !apiKey3dai.trim()}>
              Save
            </button>
          </div>
        )}
        <p className="hint">
          Powers the 3D model generator on the Design page (Tencent Hunyuan Pro via 3dai.studio). Get a key and buy
          credits in the{" "}
          <a href="https://www.3daistudio.com/Platform/API" target="_blank" rel="noreferrer">3D AI Studio API dashboard</a>.
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
          </>
        )}

        {tab === "expenses" && (
          <ExpensePricingSection />
        )}

        <div className="modal-actions">
          <button className="primary" onClick={onClose} disabled={!ready}>
            {ready ? "Done" : "Add your API key to continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
