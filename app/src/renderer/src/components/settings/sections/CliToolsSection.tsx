import { useEffect, useMemo, useState } from "react";
import { useSettings } from "../context.js";
import { SettingField } from "../SettingField.js";

interface CliStatus {
  binary: string | null;
  version: string | null;
  authenticated: boolean;
  account: string | null;
}

const SECTION_ID = "cli-tools";

/** Custom binary paths for the Higgsfield and OpenArt CLIs, with a live status
 *  check. Path edits are deferred (Save path) — this section reports dirty so
 *  the panel can warn before closing. */
export function CliToolsSection() {
  const { setError, setDirty, registerSaver } = useSettings();
  const [hfBinary, setHfBinary] = useState("");
  const [oaBinary, setOaBinary] = useState("");
  const [hfSaved, setHfSaved] = useState("");
  const [oaSaved, setOaSaved] = useState("");
  const [hfSavedFlag, setHfSavedFlag] = useState(false);
  const [oaSavedFlag, setOaSavedFlag] = useState(false);
  const [hfStatus, setHfStatus] = useState<CliStatus | null>(null);
  const [oaStatus, setOaStatus] = useState<CliStatus | null>(null);

  const refreshHf = () => {
    void window.cascade.getHiggsfieldCliBinary().then((p) => { setHfBinary(p ?? ""); setHfSaved(p ?? ""); }).catch(() => {});
    void window.cascade.getHiggsfieldCliStatus().then(setHfStatus).catch(() => setHfStatus(null));
  };
  const refreshOa = () => {
    void window.cascade.getOpenArtCliBinary().then((p) => { setOaBinary(p ?? ""); setOaSaved(p ?? ""); }).catch(() => {});
    void window.cascade.getOpenArtCliStatus().then(setOaStatus).catch(() => setOaStatus(null));
  };

  useEffect(() => {
    refreshHf();
    refreshOa();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = useMemo(() => hfBinary.trim() !== hfSaved.trim() || oaBinary.trim() !== oaSaved.trim(), [hfBinary, hfSaved, oaBinary, oaSaved]);

  useEffect(() => setDirty(SECTION_ID, dirty), [dirty, setDirty]);

  async function persist(): Promise<void> {
    try {
      await window.cascade.setHiggsfieldCliBinary(hfBinary.trim() ? hfBinary.trim() : null);
      await window.cascade.setOpenArtCliBinary(oaBinary.trim() ? oaBinary.trim() : null);
      setHfSaved(hfBinary);
      setOaSaved(oaBinary);
      setHfSavedFlag(true);
      setOaSavedFlag(true);
      window.dispatchEvent(new Event("cascade:media-provider-changed"));
      void window.cascade.listMediaProviders().catch(() => {});
      refreshHf();
      refreshOa();
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    registerSaver(SECTION_ID, persist);
    return () => registerSaver(SECTION_ID, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hfBinary, oaBinary]);

  return (
    <>
      <SettingField
        label={
          <>
            Higgsfield CLI binary <span className="hint">(optional — blank resolves `higgsfield` from PATH)</span>
          </>
        }
      >
        <div className="row">
          <input
            type="text"
            value={hfBinary}
            onChange={(e) => { setHfBinary(e.target.value); setHfSavedFlag(false); }}
            placeholder="C:\Users\you\AppData\Roaming\npm\higgsfield.cmd"
            title="Full path to the higgsfield CLI binary. Leave blank to use the one on PATH."
            style={{ flex: 1 }}
          />
          <button onClick={() => void persist()}>Save path</button>
          <button onClick={() => refreshHf()} title="Re-check the binary, version, and login">Check status</button>
          {hfSavedFlag && !dirty && <span className="hint">saved</span>}
        </div>
        {hfStatus && (
          <p className="hint">
            {hfStatus.binary ? `Binary: ${hfStatus.binary}` : "Binary: not found"}
            {hfStatus.version ? ` · ${hfStatus.version}` : ""}
            {` · ${hfStatus.authenticated ? `signed in${hfStatus.account ? ` as ${hfStatus.account}` : ""}` : "not signed in — run `higgsfield auth login` in a terminal"}`}
          </p>
        )}
      </SettingField>

      <SettingField
        label={
          <>
            OpenArt CLI binary <span className="hint">(optional — blank resolves `openart` from PATH)</span>
          </>
        }
      >
        <div className="row">
          <input
            type="text"
            value={oaBinary}
            onChange={(e) => { setOaBinary(e.target.value); setOaSavedFlag(false); }}
            placeholder="C:\Users\you\AppData\Local\Programs\openart\bin\openart.exe"
            title="Full path to the openart CLI binary. Leave blank to use the one on PATH."
            style={{ flex: 1 }}
          />
          <button onClick={() => void persist()}>Save path</button>
          <button onClick={() => refreshOa()} title="Re-check the binary, version, and login">Check status</button>
          {oaSavedFlag && !dirty && <span className="hint">saved</span>}
        </div>
        {oaStatus && (
          <p className="hint">
            {oaStatus.binary ? `Binary: ${oaStatus.binary}` : "Binary: not found"}
            {oaStatus.version ? ` · ${oaStatus.version}` : ""}
            {` · ${oaStatus.authenticated ? `signed in${oaStatus.account ? ` as ${oaStatus.account}` : ""}` : "not signed in — run `openart login` in a terminal"}`}
          </p>
        )}
      </SettingField>

      <p className="hint">OpenArt CLI video takes a single start-frame image — no end frames or extra references. In-betweening and multi-reference video need the OpenArt MCP transport.</p>
    </>
  );
}
