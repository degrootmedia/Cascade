import { useEffect, useState } from "react";
import type { MediaProviderInfo } from "../../../../../shared/ipc.js";
import {
  TRANSPORT_CHANGED,
  isProviderVisible,
  readTransportMode,
  writeTransportMode,
  type ProviderTransportMode,
} from "../../media-transport.js";
import { useSettings } from "../context.js";
import { SettingField } from "../SettingField.js";

/** Which MCP/CLI vendor serves image/video generation (global for all
 *  productions) plus the reference-thumbnail cache controls. */
export function MediaStorageSection() {
  const { setError } = useSettings();
  const [providers, setProviders] = useState<MediaProviderInfo[]>([]);
  const [active, setActive] = useState<string>("openart");
  const [transport, setTransport] = useState<ProviderTransportMode>(() => readTransportMode());
  const [thumbsBusy, setThumbsBusy] = useState(false);
  const [thumbResult, setThumbResult] = useState<string | null>(null);

  useEffect(() => {
    void window.cascade.listMediaProviders().then(setProviders).catch(() => {});
    void window.cascade.getMediaProvider().then(setActive).catch(() => {});
    const onTransport = () => setTransport(readTransportMode());
    window.addEventListener(TRANSPORT_CHANGED, onTransport);
    return () => window.removeEventListener(TRANSPORT_CHANGED, onTransport);
  }, []);

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

  async function regenerateThumbs() {
    if (thumbsBusy) return;
    setThumbsBusy(true);
    setThumbResult(null);
    try {
      const r = await window.cascade.regenerateThumbnails();
      setThumbResult(
        `${r.projects} project${r.projects === 1 ? "" : "s"} · ${r.generated} created · ${r.fromDisk} reused${r.failed ? ` · ${r.failed} skipped` : ""}`
      );
    } catch (e) {
      setThumbResult(`Failed: ${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setThumbsBusy(false);
    }
  }

  return (
    <>
      <SettingField
        label="Media generation"
        help="Which service generates storyboard frames, clips, and reference images. Applies to every production."
      >
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
        {providers
          .filter((p) => isProviderVisible(p.id, transport))
          .map((p) => (
            <div className="row" key={p.id}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <input type="radio" name="media-provider" checked={active === p.id} onChange={() => void change(p.id)} />
                {p.displayName}
              </label>
              <span className="hint">
                {p.available
                  ? "connected"
                  : p.id === "higgsfield-cli"
                    ? "not found — install the higgsfield CLI (`npm i -g @higgsfield/cli`) or set a custom binary path in CLI Tools"
                    : p.id === "openart-cli"
                      ? "not found — install the openart CLI (https://github.com/OpenArt-AI/cli) or set a custom binary path in CLI Tools"
                      : "not connected — add its MCP server below"}
              </span>
            </div>
          ))}
        {!providers.some((p) => p.id === active && isProviderVisible(p.id, transport)) && (
          <div className="row">
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <input type="radio" name="media-provider" checked disabled readOnly />
              {active}
            </label>
            <span className="hint">no longer available — pick a connected provider</span>
          </div>
        )}
      </SettingField>

      <SettingField
        label="Reference thumbnails"
        help="The node graph shows small compressed JPEGs of your references so large projects load fast. Pre-generate them here for every project (re-running is cheap — valid thumbnails are reused, stale ones pruned)."
      >
        <div className="row">
          <button disabled={thumbsBusy} onClick={() => void regenerateThumbs()}>
            {thumbsBusy ? "Generating…" : "Regenerate thumbnail cache"}
          </button>
          {thumbResult && (
            <span className="hint" style={{ flex: 1 }}>
              {thumbResult}
            </span>
          )}
        </div>
      </SettingField>
    </>
  );
}
