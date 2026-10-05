import { useEffect, useRef, useState } from "react";
import type { McpStatusIpc } from "../../../shared/ipc.js";
import {
  argsToLines,
  cleanMcpServer,
  emptyMcpConfig,
  envToText,
  linesToArgs,
  mcpServerEntries,
  mcpTransport,
  namesToText,
  parseMcpConfigText,
  removeMcpServer,
  serializeMcpConfig,
  textToEnv,
  textToNames,
  upsertMcpServer,
  validateMcpServer,
  type McpConfigFile,
  type McpServerConfig,
  type McpTransport,
} from "../../../shared/mcp-config.js";
import { useSettings } from "./settings/context.js";
import { SettingField } from "./settings/SettingField.js";
import { AutoTextarea } from "./AutoTextarea.js";
import { TRANSPORT_CHANGED, readTransportMode, type ProviderTransportMode } from "./media-transport.js";

const PLACEHOLDER = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\some\\\\folder"]
    }
  }
}`;

const KNOWN_KEYS = new Set(["command", "args", "env", "envPassthrough", "url", "disabled"]);

/** Unknown keys a hand-written config carries — preserved across a form edit. */
function unknownKeys(server: McpServerConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(server)) if (!KNOWN_KEYS.has(key)) out[key] = value;
  return out;
}

/** The form's working copy: strings for every text control so edits round-trip. */
interface McpDraft {
  originalName: string | null;
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  url: string;
  envText: string;
  passthroughText: string;
  disabled: boolean;
  extra: Record<string, unknown>;
}

function newDraft(): McpDraft {
  return {
    originalName: null,
    name: "",
    transport: "stdio",
    command: "",
    argsText: "",
    url: "",
    envText: "",
    passthroughText: "",
    disabled: false,
    extra: {},
  };
}

function draftFromServer(originalName: string, name: string, server: McpServerConfig): McpDraft {
  return {
    originalName,
    name,
    transport: mcpTransport(server),
    command: server.command ?? "",
    argsText: argsToLines(server.args),
    url: server.url ?? "",
    envText: envToText(server.env),
    passthroughText: namesToText(server.envPassthrough),
    disabled: Boolean(server.disabled),
    extra: unknownKeys(server),
  };
}

function draftToServer(draft: McpDraft): McpServerConfig {
  if (draft.transport === "http") {
    return cleanMcpServer({ ...draft.extra, url: draft.url, disabled: draft.disabled });
  }
  return cleanMcpServer({
    ...draft.extra,
    command: draft.command,
    args: linesToArgs(draft.argsText),
    env: textToEnv(draft.envText),
    envPassthrough: textToNames(draft.passthroughText),
    disabled: draft.disabled,
  });
}

function cleanIpcError(e: unknown): string {
  return String(e).replace(/^Error: Error invoking remote method '[^']+': /, "");
}

function statusLabel(server: McpServerConfig, status: McpStatusIpc | undefined): string {
  if (status?.status === "connected") return `${status.toolCount} tool${status.toolCount === 1 ? "" : "s"}`;
  if (status?.status === "error") return status.error ?? "Connection failed";
  if (status?.status === "disabled" || server.disabled) return "Disabled";
  return "Not connected";
}

export function McpSection() {
  const { setDirty, registerSaver } = useSettings();
  const [file, setFile] = useState<McpConfigFile>(emptyMcpConfig);
  const [statuses, setStatuses] = useState<McpStatusIpc[]>([]);
  const [onDemand, setOnDemand] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rawText, setRawText] = useState("");
  const [rawOpen, setRawOpen] = useState(false);
  const [rawDirty, setRawDirty] = useState(false);
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  /** MCP-specific block: hidden while the CLI transport is selected. */
  const [transport, setTransport] = useState<ProviderTransportMode>(() => readTransportMode());

  useEffect(() => {
    let alive = true;
    void window.cascade.getMcpConfig().then((text) => {
      if (!alive) return;
      const parsed = parseMcpConfigText(text);
      if (parsed.ok) {
        setFile(parsed.file);
        setRawText(serializeMcpConfig(parsed.file));
      } else {
        // Never silently discard a config we can't parse — surface it raw.
        setLoadError(parsed.error);
        setRawText(text);
        setRawOpen(true);
      }
    });
    void window.cascade.getMcpStatus().then((next) => {
      if (alive) setStatuses(next);
    });
    void window.cascade.getMcpOnDemand().then((next) => {
      if (alive) setOnDemand(next);
    });
    const onTransport = () => setTransport(readTransportMode());
    window.addEventListener(TRANSPORT_CHANGED, onTransport);
    return () => {
      alive = false;
      window.removeEventListener(TRANSPORT_CHANGED, onTransport);
    };
  }, []);

  async function commit(next: McpConfigFile): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const text = serializeMcpConfig(next);
      const nextStatuses = await window.cascade.setMcpConfig(text);
      setFile(next);
      setRawText(text);
      setRawDirty(false);
      setLoadError(null);
      setStatuses(nextStatuses);
      return true;
    } catch (e) {
      setError(cleanIpcError(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (!draft) return;
    const server = draftToServer(draft);
    const others = mcpServerEntries(file)
      .map((entry) => entry.name)
      .filter((name) => name !== draft.originalName);
    const message = validateMcpServer(draft.name, server, others, draft.transport);
    if (message) {
      setFormError(message);
      return;
    }
    const next = upsertMcpServer(file, draft.name, server, draft.originalName ?? undefined);
    if (await commit(next)) {
      setDraft(null);
      setFormError(null);
    }
  }

  async function saveRaw() {
    const parsed = parseMcpConfigText(rawText);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    await commit(parsed.file);
  }

  async function removeServer(name: string) {
    if (!window.confirm(`Remove MCP server “${name}”?`)) return;
    if (draft?.originalName === name) setDraft(null);
    await commit(removeMcpServer(file, name));
  }

  async function reconnect() {
    setBusy(true);
    setError(null);
    try {
      setStatuses(await window.cascade.reloadMcp());
    } catch (e) {
      setError(cleanIpcError(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleOnDemand(name: string, clicked: boolean) {
    const next = clicked ? [...new Set([...onDemand, name])] : onDemand.filter((n) => n !== name);
    setOnDemand(next);
    try {
      await window.cascade.setMcpOnDemand(next);
    } catch (e) {
      setError(cleanIpcError(e));
    }
  }

  function startAdd() {
    setFormError(null);
    setDraft(newDraft());
  }

  function startEdit(name: string, server: McpServerConfig) {
    setFormError(null);
    setDraft(draftFromServer(name, name, server));
  }

  function openRaw() {
    if (!rawDirty) setRawText(serializeMcpConfig(file));
    setRawOpen(true);
  }

  // Unsaved form/raw edits drive the rail dot and the panel close guard.
  const pending = draft !== null || rawDirty;
  const savePendingRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    savePendingRef.current = async () => {
      if (draft) await saveDraft();
      else if (rawDirty) await saveRaw();
    };
  });
  useEffect(() => {
    setDirty("mcp", pending);
    registerSaver("mcp", pending ? () => savePendingRef.current() : null);
    return () => registerSaver("mcp", null);
  }, [pending, setDirty, registerSaver]);

  if (transport === "cli") return null;

  const entries = mcpServerEntries(file);

  return (
    <SettingField
      label="MCP servers"
      help={
        <>
          Connect Model Context Protocol tool servers to give the agent extra capabilities. Each connected tool still
          asks for your approval before it runs — unless a server is marked “on demand”, which attaches its tools only
          when you name them.
        </>
      }
    >
      <div className="row mcp-toolbar">
        <button className="primary" onClick={startAdd} disabled={busy || draft !== null}>
          Add server
        </button>
        <button onClick={() => void reconnect()} disabled={busy}>
          {busy ? "Working…" : "Reconnect"}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}

      {entries.length === 0 && !draft && <p className="mcp-empty">No servers yet. Add one to get started.</p>}

      <div className="mcp-list">
        {entries.map(({ name, server }) => {
          const status = statuses.find((s) => s.name === name);
          const state = status?.status ?? (server.disabled ? "disabled" : "");
          const transportKind = mcpTransport(server);
          const detail =
            transportKind === "http"
              ? server.url
              : [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
          return (
            <div key={name} className={`mcp-server ${state}`}>
              <div className="mcp-server-head">
                <span className="mcp-dot" />
                <span className="mcp-server-name" title={name}>
                  {name}
                </span>
                <span className="mcp-badge">{transportKind === "http" ? "URL" : "Command"}</span>
                <span className="mcp-server-status" title={statusLabel(server, status)}>
                  {statusLabel(server, status)}
                </span>
                <div className="mcp-server-actions">
                  <button className="link" onClick={() => startEdit(name, server)} disabled={busy || draft !== null}>
                    Edit
                  </button>
                  <button className="link danger" onClick={() => void removeServer(name)} disabled={busy}>
                    Remove
                  </button>
                </div>
              </div>
              {detail && <div className="mcp-server-detail">{detail}</div>}
              {status?.status === "connected" && (
                <div className="mcp-server-foot">
                  <label
                    className="mcp-on-demand"
                    title="Attach this server's tools only when you ask for them by name (keeps requests lean)"
                  >
                    <input
                      type="checkbox"
                      checked={onDemand.includes(name)}
                      disabled={busy}
                      onChange={(e) => void toggleOnDemand(name, e.target.checked)}
                    />
                    On demand
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {draft && (
        <div className="mcp-form">
          <strong>{draft.originalName ? `Edit “${draft.originalName}”` : "Add MCP server"}</strong>

          <div className="mcp-form-field">
            <label>Name</label>
            <input
              value={draft.name}
              placeholder="filesystem"
              autoFocus
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <p className="hint">Namespaces the server's tools so they can't collide.</p>
          </div>

          <div className="mcp-form-field">
            <label>Connection type</label>
            <div className="mcp-seg" role="group" aria-label="Connection type">
              <button
                type="button"
                className={draft.transport === "stdio" ? "active" : ""}
                onClick={() => setDraft({ ...draft, transport: "stdio" })}
              >
                Local command
              </button>
              <button
                type="button"
                className={draft.transport === "http" ? "active" : ""}
                onClick={() => setDraft({ ...draft, transport: "http" })}
              >
                Remote URL
              </button>
            </div>
          </div>

          {draft.transport === "stdio" ? (
            <>
              <div className="mcp-form-field">
                <label>Command</label>
                <input
                  value={draft.command}
                  placeholder="npx"
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                />
              </div>
              <div className="mcp-form-field">
                <label>
                  Arguments <span className="mcp-optional">one per line</span>
                </label>
                <textarea
                  rows={3}
                  value={draft.argsText}
                  placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\some\\folder"}
                  onChange={(e) => setDraft({ ...draft, argsText: e.target.value })}
                />
              </div>
              <details className="mcp-advanced">
                <summary>Environment &amp; advanced</summary>
                <div className="mcp-form-field">
                  <label>
                    Environment variables <span className="mcp-optional">KEY=value per line</span>
                  </label>
                  <textarea
                    rows={3}
                    value={draft.envText}
                    placeholder="GITHUB_TOKEN=ghp_…"
                    onChange={(e) => setDraft({ ...draft, envText: e.target.value })}
                  />
                </div>
                <div className="mcp-form-field">
                  <label>
                    Pass through variables <span className="mcp-optional">names to inherit</span>
                  </label>
                  <input
                    value={draft.passthroughText}
                    placeholder="GITHUB_TOKEN"
                    onChange={(e) => setDraft({ ...draft, passthroughText: e.target.value })}
                  />
                </div>
              </details>
            </>
          ) : (
            <div className="mcp-form-field">
              <label>Server URL</label>
              <input
                value={draft.url}
                placeholder="https://example.com/mcp"
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              />
              <p className="hint">If the server requires sign-in, a browser window opens when you connect.</p>
            </div>
          )}

          <label className="mcp-enabled">
            <input
              type="checkbox"
              checked={!draft.disabled}
              onChange={(e) => setDraft({ ...draft, disabled: !e.target.checked })}
            />
            Enable this server
          </label>

          {formError && <p className="error-text">{formError}</p>}
          <div className="mcp-form-actions">
            <button className="primary" onClick={() => void saveDraft()} disabled={busy}>
              {busy ? "Connecting…" : "Save & connect"}
            </button>
            <button
              onClick={() => {
                setDraft(null);
                setFormError(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mcp-raw">
        <button type="button" className="mcp-advanced-toggle" aria-expanded={rawOpen} onClick={() => (rawOpen ? setRawOpen(false) : openRaw())}>
          {rawOpen ? "▾" : "▸"} Advanced: edit raw JSON
        </button>
        {rawOpen && (
          <>
            {loadError && <p className="error-text">{loadError}</p>}
            <AutoTextarea
              className="mcp-config"
              maxHeight={Math.round(window.innerHeight * 0.4)}
              value={rawText}
              placeholder={PLACEHOLDER}
              spellCheck={false}
              onChange={(e) => {
                setRawText(e.target.value);
                setRawDirty(true);
              }}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button onClick={() => void saveRaw()} disabled={busy || !rawDirty}>
                {busy ? "Connecting…" : "Save & connect"}
              </button>
              <button
                onClick={() => {
                  setRawText(serializeMcpConfig(file));
                  setRawDirty(false);
                  setError(null);
                }}
                disabled={busy || !rawDirty}
              >
                Revert
              </button>
            </div>
          </>
        )}
      </div>
    </SettingField>
  );
}
