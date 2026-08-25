import { useEffect, useState } from "react";
import type { McpStatusIpc } from "../../../shared/ipc.js";
import { AutoTextarea } from "./AutoTextarea.js";

const PLACEHOLDER = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\some\\\\folder"]
    }
  }
}`;

export function McpSection() {
  const [config, setConfig] = useState("");
  const [statuses, setStatuses] = useState<McpStatusIpc[]>([]);
  const [onDemand, setOnDemand] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void window.cascade.getMcpConfig().then(setConfig);
    void window.cascade.getMcpStatus().then(setStatuses);
    void window.cascade.getMcpOnDemand().then(setOnDemand);
  }, []);

  async function toggleOnDemand(name: string, clicked: boolean) {
    const next = clicked ? [...new Set([...onDemand, name])] : onDemand.filter((n) => n !== name);
    setOnDemand(next);
    await window.cascade.setMcpOnDemand(next);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      setStatuses(await window.cascade.setMcpConfig(config));
      setDirty(false);
    } catch (e) {
      setError(String(e).replace(/^Error: Error invoking remote method '[^']+': /, ""));
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    setBusy(true);
    setError(null);
    try {
      setStatuses(await window.cascade.reloadMcp());
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <label>MCP servers</label>
      <p className="hint">
        Same format as Claude Desktop's config — paste an "mcpServers" block. Connected tools require your
        approval before each use.
      </p>
      <AutoTextarea
        className="mcp-config"
        maxHeight={Math.round(window.innerHeight * 0.5)}
        value={config}
        placeholder={PLACEHOLDER}
        spellCheck={false}
        onChange={(e) => {
          setConfig(e.target.value);
          setDirty(true);
        }}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? "Connecting…" : "Save & connect"}
        </button>
        <button onClick={() => void reload()} disabled={busy}>
          Reconnect
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {statuses.length > 0 && (
        <ul className="mcp-status">
          {statuses.map((s) => (
            <li key={s.name} className={s.status}>
              <span className="mcp-dot" />
              <strong>{s.name}</strong>
              {s.status === "connected" && (
                <>
                  {` — ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`}
                  <label className="mcp-on-demand" title="Attach this server's tools only when you ask by name (keeps requests lean)">
                    <input
                      type="checkbox"
                      checked={onDemand.includes(s.name)}
                      disabled={busy}
                      onChange={(e) => void toggleOnDemand(s.name, e.target.checked)}
                    />
                    on demand
                  </label>
                </>
              )}
              {s.status === "disabled" && " — disabled"}
              {s.status === "error" && ` — ${s.error}`}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
