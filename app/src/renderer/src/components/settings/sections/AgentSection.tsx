import { useEffect, useState } from "react";
import { useSettings } from "../context.js";
import { SettingField } from "../SettingField.js";

/** Restore the agent defaults (autonomous off, 250 turns). */
export async function resetAgent(): Promise<void> {
  await window.cascade.setAutonomousByDefault(false);
  await window.cascade.setMaxIterations(250);
}

/** Agent behavior defaults: autonomous mode + the per-message turn cap. */
export function AgentSection() {
  const { setError } = useSettings();
  const [autonomousByDefault, setAutonomousByDefault] = useState(false);
  const [maxIterations, setMaxIterations] = useState(250);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void Promise.all([window.cascade.getAutonomousByDefault(), window.cascade.getMaxIterations()])
      .then(([auto, max]) => {
        setAutonomousByDefault(auto);
        setMaxIterations(max);
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
    </>
  );
}
