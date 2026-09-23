import { useEffect, useState } from "react";
import { useSettings } from "../context.js";
import { SettingField } from "../SettingField.js";

export async function resetWorkspace(): Promise<void> {
  await window.cascade.clearDefaultWorkspace();
}

export function WorkspaceSection() {
  const { view, setError, onOpenAgents } = useSettings();
  const [workspace, setWorkspace] = useState(view.workspace);

  useEffect(() => setWorkspace(view.workspace), [view.workspace]);

  async function pickWorkspace() {
    const dir = await window.cascade.pickWorkspace();
    if (dir) setWorkspace(dir);
  }

  return (
    <>
      <SettingField
        label="Default folder for new chats"
        help={
          <>
            "None" makes new chats plain chat (no file access). Each chat can use its own folder — click the chip above the
            conversation to change it. Cascade can only read and change files inside the chat's folder.
          </>
        }
      >
        <div className="row">
          <span className="path">{workspace ?? "None — pure chat"}</span>
          <button onClick={() => void pickWorkspace()}>Choose…</button>
          <button
            onClick={() => {
              setWorkspace(null);
              void window.cascade.clearDefaultWorkspace().catch((e) => setError(String(e)));
            }}
          >
            None
          </button>
        </div>
      </SettingField>

      <SettingField
        label="Agents"
        help={
          <>
            Custom personas with their own prompt, model, avatar, and tools.
            {onOpenAgents && (
              <>
                {" "}
                <button className="link" onClick={onOpenAgents}>
                  Manage agents
                </button>
              </>
            )}
          </>
        }
      />

      <SettingField
        label="Skills"
        help={
          <>
            Markdown files that teach Cascade repeatable workflows. Drop .md files in the skills folder; Cascade reads
            them when relevant.{" "}
            <button className="link" onClick={() => void window.cascade.openSkillsFolder()}>
              Open skills folder
            </button>
          </>
        }
      />
    </>
  );
}
