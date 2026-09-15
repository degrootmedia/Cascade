import { Fragment, useEffect, useMemo, useState } from "react";
import { type MediaProviderInfo, type ModelInfo, type SettingsView } from "../../../shared/ipc.js";
import { API_PROVIDERS } from "../../../shared/providers.js";
import { McpSection } from "./McpSection.js";
import { TRANSPORT_CHANGED, isProviderVisible, readTransportMode, writeTransportMode, type ProviderTransportMode } from "./media-transport.js";
import { applyAccent } from "../theme.js";

const ACCENT_PRESETS = [
  { name: "Blue", value: "#4f8ef7" },
  { name: "Violet", value: "#a371f7" },
  { name: "Teal", value: "#2ea89a" },
  { name: "Green", value: "#57ab5a" },
  { name: "Orange", value: "#e0823d" },
  { name: "Pink", value: "#f778ba" },
];


/** Settings → Media generation: which MCP vendor serves image/video
 *  generation (global for all productions), plus the manual end-frame model
 *  allowlist for the in-betweener (merged with the providers' live probe).
 *  Model ids from the other vendor are treated as unknown until the user
 *  picks explicitly. */
function MediaProviderSection({ onOpenModelCustomizer }: { onOpenModelCustomizer?: () => void }) {
  const [providers, setProviders] = useState<MediaProviderInfo[]>([]);
  const [active, setActive] = useState<string>("openart");
  const [error, setError] = useState<string | null>(null);
  /** Transport toggle (MCP vs CLI), shared with the top bar via persisted mode. */
  const [transport, setTransport] = useState<ProviderTransportMode>(() => readTransportMode());
  /** Dev Mode: submission logging + dry run. */
  const [devMode, setDevMode] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  /** Higgsfield CLI transport: custom binary path + live status. */
  const [cliBinary, setCliBinary] = useState("");
  const [cliBinarySaved, setCliBinarySaved] = useState(false);
  const [cliStatus, setCliStatus] = useState<{ binary: string | null; version: string | null; authenticated: boolean; account: string | null } | null>(null);
  /** OpenArt CLI transport: custom binary path + live status. */
  const [oaCliBinary, setOaCliBinary] = useState("");
  const [oaCliBinarySaved, setOaCliBinarySaved] = useState(false);
  const [oaCliStatus, setOaCliStatus] = useState<{ binary: string | null; version: string | null; authenticated: boolean; account: string | null } | null>(null);

  const refreshCli = () => {
    void window.cascade.getHiggsfieldCliBinary().then((p) => setCliBinary(p ?? "")).catch(() => {});
    void window.cascade.getHiggsfieldCliStatus().then(setCliStatus).catch(() => setCliStatus(null));
  };

  const refreshOaCli = () => {
    void window.cascade.getOpenArtCliBinary().then((p) => setOaCliBinary(p ?? "")).catch(() => {});
    void window.cascade.getOpenArtCliStatus().then(setOaCliStatus).catch(() => setOaCliStatus(null));
  };

  useEffect(() => {
    void window.cascade.listMediaProviders().then(setProviders).catch(() => {});
    void window.cascade.getMediaProvider().then(setActive).catch(() => {});
    void window.cascade.getDevMode().then(setDevMode).catch(() => {});
    void window.cascade.getSubmissionDryRun().then(setDryRun).catch(() => {});
    refreshCli();
    refreshOaCli();
    // A transport flip in the top bar applies here too (same persisted mode).
    const onTransport = () => setTransport(readTransportMode());
    window.addEventListener(TRANSPORT_CHANGED, onTransport);
    return () => window.removeEventListener(TRANSPORT_CHANGED, onTransport);
  }, []);

  const saveCliBinary = async () => {
    setCliBinarySaved(false);
    try {
      await window.cascade.setHiggsfieldCliBinary(cliBinary.trim() ? cliBinary.trim() : null);
      setCliBinarySaved(true);
      refreshCli();
      void window.cascade.listMediaProviders().then(setProviders).catch(() => {});
      window.dispatchEvent(new Event("cascade:media-provider-changed"));
    } catch (e) {
      setError(String(e));
    }
  };

  const saveOaCliBinary = async () => {
    setOaCliBinarySaved(false);
    try {
      await window.cascade.setOpenArtCliBinary(oaCliBinary.trim() ? oaCliBinary.trim() : null);
      setOaCliBinarySaved(true);
      refreshOaCli();
      void window.cascade.listMediaProviders().then(setProviders).catch(() => {});
      window.dispatchEvent(new Event("cascade:media-provider-changed"));
    } catch (e) {
      setError(String(e));
    }
  };

  const change = async (id: string) => {
    setActive(id);
    setError(null);
    try {
      await window.cascade.setMediaProvider(id as MediaProviderInfo["id"]);
      // ProductionWorkspace listens for this to re-read the provider and
      // repopulate its model dropdowns (same string there — keep in sync).
      window.dispatchEvent(new Event("cascade:media-provider-changed"));
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <>
      <label>Media generation</label>
      <div className="row" style={{ alignItems: "center" }}>
        <div
          className="media-toggle"
          role="radiogroup"
          aria-label="Media transport"
          title="MCP servers or local CLI binaries drive image/video generation"
        >
          {(["mcp", "cli"] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={transport === m}
              aria-label={m === "mcp" ? "MCP transport" : "CLI transport"}
              title={m === "mcp" ? "Generate via MCP servers" : "Generate via local CLI binaries"}
              className={"media-half" + (transport === m ? " active" : "")}
              onClick={() => {
                if (m === transport) return;
                writeTransportMode(m);
                setTransport(m);
                // Reconcile like the top bar: never leave the active provider
                // on the hidden transport.
                if (!providers.some((p) => p.id === active && isProviderVisible(p.id, m))) {
                  const target = providers.filter((p) => isProviderVisible(p.id, m)).find((p) => p.available);
                  if (target) void change(target.id);
                }
              }}
            >
              {m === "mcp" ? "MCP" : "CLI"}
            </button>
          ))}
        </div>
        <span className="hint">{transport === "mcp" ? "Generate via MCP servers" : "Generate via local CLI binaries"}</span>
      </div>
      {providers.filter((p) => isProviderVisible(p.id, transport)).map((p) => (
        <div className="row" key={p.id}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <input type="radio" name="media-provider" checked={active === p.id} onChange={() => void change(p.id)} />
            {p.displayName}
          </label>
          <span className="hint">{p.available ? "connected" : p.id === "higgsfield-cli"
            ? "not found — install the higgsfield CLI (`npm i -g @higgsfield/cli`) or set a custom binary path below"
            : p.id === "openart-cli"
            ? "not found — install the openart CLI (https://github.com/OpenArt-AI/cli) or set a custom binary path below"
            : "not connected — add its MCP server below"}</span>
        </div>
      ))}
      <p className="hint">Which service generates storyboard frames, clips, and reference images. Applies to every production.</p>
      {transport === "cli" && (
      <>
      <label style={{ marginTop: 8 }}>Higgsfield CLI binary <span className="hint">(optional — blank resolves `higgsfield` from PATH)</span></label>
      <div className="row">
        <input
          type="text"
          value={cliBinary}
          onChange={(e) => { setCliBinary(e.target.value); setCliBinarySaved(false); }}
          placeholder="C:\Users\you\AppData\Roaming\npm\higgsfield.cmd"
          title="Full path to the higgsfield CLI binary. Leave blank to use the one on PATH."
          style={{ flex: 1 }}
        />
        <button onClick={() => void saveCliBinary()}>Save path</button>
        <button onClick={() => void refreshCli()} title="Re-check the binary, version, and login">Check status</button>
        {cliBinarySaved && <span className="hint">saved</span>}
      </div>
      {cliStatus && (
        <p className="hint">
          {cliStatus.binary ? `Binary: ${cliStatus.binary}` : "Binary: not found"}
          {cliStatus.version ? ` · ${cliStatus.version}` : ""}
          {` · ${cliStatus.authenticated ? `signed in${cliStatus.account ? ` as ${cliStatus.account}` : ""}` : "not signed in — run `higgsfield auth login` in a terminal"}`}
        </p>
      )}
      <label style={{ marginTop: 8 }}>OpenArt CLI binary <span className="hint">(optional — blank resolves `openart` from PATH)</span></label>
      <div className="row">
        <input
          type="text"
          value={oaCliBinary}
          onChange={(e) => { setOaCliBinary(e.target.value); setOaCliBinarySaved(false); }}
          placeholder="C:\Users\you\AppData\Local\Programs\openart\bin\openart.exe"
          title="Full path to the openart CLI binary. Leave blank to use the one on PATH."
          style={{ flex: 1 }}
        />
        <button onClick={() => void saveOaCliBinary()}>Save path</button>
        <button onClick={() => void refreshOaCli()} title="Re-check the binary, version, and login">Check status</button>
        {oaCliBinarySaved && <span className="hint">saved</span>}
      </div>
      {oaCliStatus && (
        <p className="hint">
          {oaCliStatus.binary ? `Binary: ${oaCliStatus.binary}` : "Binary: not found"}
          {oaCliStatus.version ? ` · ${oaCliStatus.version}` : ""}
          {` · ${oaCliStatus.authenticated ? `signed in${oaCliStatus.account ? ` as ${oaCliStatus.account}` : ""}` : "not signed in — run `openart login` in a terminal"}`}
        </p>
      )}
      <p className="hint">OpenArt CLI video takes a single start-frame image — no end frames or extra references. In-betweening and multi-reference video need the OpenArt MCP transport.</p>
      </>
      )}
      <p className="hint">The in-betweener offers video models the live probe confirms, plus any model you assign to the in-betweener surface in the Model Customizer.</p>
      <label style={{ marginTop: 8, display: "inline-flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={devMode}
          onChange={(e) => {
            const v = e.target.checked;
            setDevMode(v);
            void window.cascade.setDevMode(v).catch((err) => setError(String(err)));
          }}
        />
        Dev Mode (log every generation submission)
      </label>
      {devMode && (
        <>
          <p className="hint">Submissions append to &lt;userData&gt;/logs/submissions.md (+ submissions.jsonl). Secrets are redacted.</p>
          <div className="row">
            <button onClick={() => void window.cascade.openSubmissionLog().catch((err) => setError(String(err)))}>Open submission log</button>
            {onOpenModelCustomizer && (
              <button onClick={onOpenModelCustomizer} title="Probe every media vendor and customize models + parameters">Model customization…</button>
            )}
          </div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => {
                const v = e.target.checked;
                setDryRun(v);
                void window.cascade.setSubmissionDryRun(v).catch((err) => setError(String(err)));
              }}
            />
            Dry run (build + log submissions, spend no credits)
          </label>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </>
  );
}

export function SettingsPanel({ settings, onClose, onOpenAgents, onOpenModelCustomizer }: { settings: SettingsView; onClose: () => void; onOpenAgents?: () => void; onOpenModelCustomizer?: () => void }) {
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
  /** 3D AI Studio API key (design-page 3D model generator). */
  const [has3daiKey, setHas3daiKey] = useState(settings.has3daiApiKey);
  const [apiKey3dai, setApiKey3daiInput] = useState("");
  /** Reference-thumbnail cache regeneration (Settings → General). */
  const [thumbsBusy, setThumbsBusy] = useState(false);
  const [thumbResult, setThumbResult] = useState<string | null>(null);

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

  /** Pre-generate the compressed reference thumbnails for every production. */
  async function regenerateThumbs() {
    if (thumbsBusy) return;
    setThumbsBusy(true);
    setThumbResult(null);
    try {
      const r = await window.cascade.regenerateThumbnails();
      setThumbResult(`${r.projects} project${r.projects === 1 ? "" : "s"} · ${r.generated} created · ${r.fromDisk} reused${r.failed ? ` · ${r.failed} skipped` : ""}`);
    } catch (e) {
      setThumbResult(`Failed: ${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setThumbsBusy(false);
    }
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
    <div className="modal-backdrop top-layer" onClick={onClose}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>

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

        <label>Reference thumbnails</label>
        <p className="hint">
          The node graph shows small compressed JPEGs of your references so large projects load fast. Pre-generate
          them here for every project (re-running is cheap — valid thumbnails are reused, stale ones pruned).
        </p>
        <div className="row">
          <button disabled={thumbsBusy} onClick={() => void regenerateThumbs()}>
            {thumbsBusy ? "Generating…" : "Regenerate thumbnail cache"}
          </button>
          {thumbResult && <span className="hint" style={{ flex: 1 }}>{thumbResult}</span>}
        </div>

        {error && <p className="error-text">{error}</p>}

        <MediaProviderSection onOpenModelCustomizer={onOpenModelCustomizer} />
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
