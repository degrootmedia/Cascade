import { useEffect, useState } from "react";
import { useSettings } from "../context.js";
import { SettingField } from "../SettingField.js";
import type { SandboxModeIpc } from "../../../../../shared/ipc.js";

/** Restore the agent defaults (autonomous off, 250 turns, screen capture on). */
export async function resetAgent(): Promise<void> {
  await window.cascade.setAutonomousByDefault(false);
  await window.cascade.setMaxIterations(250);
  await window.cascade.setScreenCaptureEnabled(true);
  await window.cascade.setSandboxMode("none");
}

/** Agent behavior defaults: autonomous mode + the per-message turn cap. */
export function AgentSection() {
  const { setError } = useSettings();
  const [autonomousByDefault, setAutonomousByDefault] = useState(false);
  const [maxIterations, setMaxIterations] = useState(250);
  const [screenCapture, setScreenCapture] = useState(true);
  const [sandbox, setSandbox] = useState<SandboxModeIpc>("none");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void Promise.all([
      window.cascade.getAutonomousByDefault(),
      window.cascade.getMaxIterations(),
      window.cascade.getScreenCaptureEnabled(),
      window.cascade.getSandboxMode(),
    ])
      .then(([auto, max, capture, sandboxMode]) => {
        setAutonomousByDefault(auto);
        setMaxIterations(max);
        setScreenCapture(capture);
        setSandbox(sandboxMode);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  return (
    <>
      <SettingField
        label="Autonomous mode for new chats"
        help={
          <>
            When on, new chats start with autonomous mode: Cascade runs tools (including OpenArt) without asking for
            approval each time. Toggle it per chat from the composer footer, or with <code>/autonomous on|off</code>.
            Autonomous mode and plan mode are mutually exclusive.
          </>
        }
      >
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={autonomousByDefault}
            onChange={(e) => {
              const v = e.target.checked;
              setAutonomousByDefault(v);
              void window.cascade.setAutonomousByDefault(v).catch((err) => setError(String(err)));
            }}
          />
          Start new chats without approval prompts
        </label>
      </SettingField>

      <SettingField
        label="Max turns per message"
        help="How many model turns Cascade may take in one message before it stops for you to continue. A full video production can need hundreds. Lower it to bound cost; raise it for very long runs."
      >
        <input
          type="number"
          min={10}
          max={2000}
          step={10}
          value={maxIterations}
          disabled={!loaded}
          onChange={(e) => setMaxIterations(Number(e.target.value))}
          onBlur={(e) => {
            const v = Number(e.target.value);
            void window.cascade.setMaxIterations(v).then(setMaxIterations).catch((err) => setError(String(err)));
          }}
        />
      </SettingField>

      <SettingField
        label="Screen capture"
        help="Lets the agent take a screenshot of your primary display (the capture_screen tool) to check on-screen progress. It always asks for approval first unless the chat is in autonomous mode; turning this off removes the tool entirely. The separate view_image tool (looking at generated frames and references) is unaffected."
      >
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={screenCapture}
            disabled={!loaded}
            onChange={(e) => {
              const v = e.target.checked;
              setScreenCapture(v);
              void window.cascade.setScreenCaptureEnabled(v).catch((err) => setError(String(err)));
            }}
          />
          Allow the agent to capture the screen
        </label>
      </SettingField>

      <SettingField
        label="Command sandbox"
        help="Optional OS-level isolation for commands the agent runs. 'None' relies on approval + shell:false (not OS isolation). 'srt' uses Anthropic's sandbox-runtime (network denied, writes confined to the workspace); 'docker' runs commands in a network-off container mounted at the workspace. If the selected tool isn't on PATH, Cascade tells you and runs without isolation — it never fakes it."
      >
        <select
          value={sandbox}
          disabled={!loaded}
          onChange={(e) => {
            const v = e.target.value as SandboxModeIpc;
            setSandbox(v);
            void window.cascade.setSandboxMode(v).catch((err) => setError(String(err)));
          }}
        >
          <option value="none">None (approval-gated, not OS-isolated)</option>
          <option value="srt">sandbox-runtime (srt)</option>
          <option value="docker">Docker container</option>
        </select>
      </SettingField>
    </>
  );
}
