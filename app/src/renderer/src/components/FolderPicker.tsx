import { useEffect, useRef, useState } from "react";
import type { ActiveProductionInfo, WorkspaceInstructionsInfo } from "../../../shared/ipc.js";

/** Header dropdown for choosing the current chat's working folder. */
export function FolderPicker({
  current,
  recents,
  instructions,
  pureChat,
  followProduction,
  production,
  onPick,
  onSelect,
  onNone,
  onSelectProduction,
  onOpenInstructions,
}: {
  current: string | null;
  recents: string[];
  instructions: WorkspaceInstructionsInfo | null;
  /** Pure chat (no folder) — shows the "None" chip and a chat-only option. */
  pureChat: boolean;
  /** This chat mirrors the active Production Assistant project's folder. */
  followProduction: boolean;
  /** The active production, when one has been opened. */
  production: ActiveProductionInfo | null;
  onPick: () => void;
  onSelect: (dir: string) => void;
  onNone: () => void;
  onSelectProduction: () => void;
  onOpenInstructions: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const currentName = current ? (current.split(/[\\/]/).pop() ?? current) : null;
  // Show the current folder at the top, but don't repeat it in the recent list.
  const recentList = recents.filter((r) => r !== current);
  const chipLabel = followProduction
    ? `🎬 ${production?.name ?? "Active Production"}`
    : pureChat
      ? "💬 Chat only"
      : `📁 ${currentName ?? "Choose folder…"}`;
  const chipTitle = followProduction
    ? production
      ? `Following the active production — ${production.folder}`
      : "Following the active production — open one in the Production Assistant to give the agent files"
    : pureChat
      ? "Chat only — no file access. Pick a folder to enable the agent."
      : (current ?? "Choose a working folder for this chat");

  return (
    <div className="folder-picker" ref={ref}>
      <button className="folder-chip" title={chipTitle} onClick={() => setOpen(!open)}>
        {chipLabel}
        <span className="folder-caret">▾</span>
      </button>
      {!pureChat && instructions?.active && (
        <button
          className="instructions-badge"
          title={instructions.file ?? "Folder instructions (CASCADE.md)"}
          onClick={onOpenInstructions}
        >
          📄 folder instructions
        </button>
      )}
      {open && (
        <div className="folder-menu">
          <button
            className={`folder-option${pureChat && !followProduction ? " current" : ""}`}
            onClick={() => {
              onNone();
              setOpen(false);
            }}
            title="No folder, no tools — plain chat"
          >
            <span className="folder-label">None — chat only</span>
            <span className="folder-path">No file access; replies like a plain chat</span>
          </button>
          <button
            className={`folder-option${followProduction ? " current" : ""}`}
            disabled={!production}
            onClick={() => {
              if (!production) return;
              onSelectProduction();
              setOpen(false);
            }}
            title={
              production
                ? `Mirror the open production's folder: ${production.folder}`
                : "Open a production in the Production Assistant first"
            }
          >
            <span className="folder-label">Active Production</span>
            <span className="folder-path">
              {production ? `${production.name} — ${production.folder}` : "No production open"}
            </span>
          </button>
          {
            // Only show the current folder row if it's selected but not in recents.
            current && !followProduction && (
              <button className="folder-option current" onClick={() => setOpen(false)} title={current}>
                <span className="folder-label">Current</span>
                <span className="folder-path">{current}</span>
              </button>
            )
          }
          {recentList.length > 0 && (
            <>
              <div className="folder-menu-heading">Recent</div>
              {recentList.map((dir) => (
                <button
                  key={dir}
                  className="folder-option"
                  title={dir}
                  onClick={() => {
                    onSelect(dir);
                    setOpen(false);
                  }}
                >
                  <span className="folder-label">{dir.split(/[\\/]/).pop() || dir}</span>
                  <span className="folder-path">{dir}</span>
                </button>
              ))}
            </>
          )}
          <button
            className="folder-option add"
            onClick={() => {
              setOpen(false);
              onPick();
            }}
          >
            <span className="folder-label">Choose different folder…</span>
          </button>
        </div>
      )}
    </div>
  );
}