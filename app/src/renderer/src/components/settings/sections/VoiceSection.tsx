import { useEffect, useState } from "react";
import { useSettings } from "../context.js";
import { SettingField } from "../SettingField.js";
import { WHISPER_MODELS, type VoiceStatusIpc, type WhisperModel } from "../../../../../shared/ipc.js";

/** Restore the voice defaults (off, base.en, no CLI override). */
export async function resetVoice(): Promise<void> {
  await window.cascade.setVoiceEnabled(false);
  await window.cascade.setWhisperModel("base.en");
  await window.cascade.setVoiceCliBinary(null);
}

/** Local voice input (Whisper): enable dictation, pick a model, check status. */
export function VoiceSection() {
  const { setError } = useSettings();
  const [enabled, setEnabled] = useState(false);
  const [model, setModel] = useState<WhisperModel>("base.en");
  const [cliOverride, setCliOverride] = useState("");
  const [status, setStatus] = useState<VoiceStatusIpc | null>(null);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function refresh() {
    try {
      const [on, m, bin, st] = await Promise.all([
        window.cascade.getVoiceEnabled(),
        window.cascade.getWhisperModel(),
        window.cascade.getVoiceCliBinary(),
        window.cascade.getVoiceStatus(),
      ]);
      setEnabled(on);
      setModel(m);
      setCliOverride(bin ?? "");
      setStatus(st);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void refresh();
    const off = window.cascade.onVoiceProgress((e) => setProgress({ received: e.received, total: e.total }));
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function download() {
    setBusy(true);
    setProgress(null);
    setError(null);
    try {
      const st = await window.cascade.prepareVoice();
      setStatus(st);
      if (!st.available) setError("The speech engine binary was not found. Set its path below or reinstall Cascade.");
      else if (!st.modelReady) setError("The speech model could not be downloaded. Check your connection and try again.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <>
      <SettingField
        label="Voice input"
        help="Adds a microphone button to the chat composer: click to dictate, and your words stream into the message as you speak. Runs fully offline via a local Whisper model (whisper.cpp) — no audio leaves your machine."
      >
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!loaded}
            onChange={(e) => {
              const v = e.target.checked;
              setEnabled(v);
              void window.cascade.setVoiceEnabled(v).catch((err) => setError(String(err)));
            }}
          />
          Show the microphone button in the composer
        </label>
      </SettingField>

      <SettingField
        label="Speech model"
        help="Larger models are more accurate but slower and a bigger download. tiny.en is fastest; small.en is most accurate. English-only models (the .en variants) are used."
      >
        <select
          value={model}
          disabled={!loaded || busy}
          onChange={(e) => {
            const m = e.target.value as WhisperModel;
            setModel(m);
            void window.cascade.setWhisperModel(m)
              .then(() => window.cascade.getVoiceStatus())
              .then(setStatus)
              .catch((err) => setError(String(err)));
          }}
        >
          {WHISPER_MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </SettingField>

      <SettingField label="Status" help="The engine is downloaded with Cascade; the model downloads once, on first use.">
        <div className="row">
          <span className="hint">
            {!status
              ? "Checking…"
              : !status.available
                ? "Speech engine not found."
                : status.modelReady
                  ? `Ready (${status.model}).`
                  : status.downloading
                    ? `Downloading ${status.model}…`
                    : `Model ${status.model} not downloaded yet.`}
          </span>
          {status?.available && !status.modelReady && (
            <button onClick={() => void download()} disabled={busy}>
              {busy
                ? progress && progress.total
                  ? `Downloading… ${Math.round((progress.received / progress.total) * 100)}%`
                  : "Downloading…"
                : "Download model"}
            </button>
          )}
        </div>
      </SettingField>

      <SettingField
        label="whisper-cli path"
        help="Advanced: a custom path to the whisper.cpp CLI. Leave blank to use the bundled binary, or a whisper-cli on your PATH."
      >
        <input
          type="text"
          value={cliOverride}
          placeholder="Auto (bundled / PATH)"
          disabled={!loaded}
          onChange={(e) => setCliOverride(e.target.value)}
          onBlur={(e) => {
            const p = e.target.value.trim();
            void window.cascade.setVoiceCliBinary(p || null)
              .then(() => window.cascade.getVoiceStatus())
              .then(setStatus)
              .catch((err) => setError(String(err)));
          }}
        />
      </SettingField>
    </>
  );
}
