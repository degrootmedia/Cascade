/**
 * Suite history rail: the timeline of generations/edits, newest-first, as a
 * straight list. Selecting an entry loads it into the canvas + prompt panel
 * for replay; deleting removes it (and its files, main-side).
 *
 * Thumbnails stream over `cascade-media://…?thumb=1` and `loading="lazy"`, so
 * a long history never decodes full-res images into renderer memory.
 */
import { useMemo } from "react";
import type { SuiteEntry } from "./suite-types.js";
import { cascadeMedia } from "../../components/production/animatic.js";
import { GenerationMenu, useGenerationMenu } from "../../components/generation-menu.js";

export function SuiteHistoryRail({
  prodId,
  entries,
  selectedId,
  busy,
  onSelect,
  onDelete,
  onEditInSuite,
}: {
  prodId: string;
  entries: SuiteEntry[];
  selectedId: string | null;
  busy?: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onEditInSuite?: (rel: string) => void;
}) {
  const genMenu = useGenerationMenu();
  // Newest first — a flat timeline (branching is still persisted on `parentId`,
  // it just isn't visualised as a tree here).
  const rows = useMemo(
    () => [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [entries]
  );

  return (
    <aside className="suite-rail" aria-label="Generation history">
      <div className="suite-rail-head">
        <span>History</span>
        <span className="hint">{entries.length}</span>
      </div>
      {busy && (
        <div className="suite-rail-row suite-rail-inflight" aria-live="polite">
          <span className="suite-spinner" aria-hidden="true" /> Generating…
        </div>
      )}
      {rows.length === 0 && !busy && <p className="hint suite-rail-empty">No generations yet — describe one and hit Generate.</p>}
      <div className="suite-rail-list">
        {rows.map((entry) => {
          const selected = entry.id === selectedId;
          return (
            <div
              key={entry.id}
              className={"suite-rail-row" + (selected ? " selected" : "")}
            >
              <button
                className="suite-rail-thumb"
                onClick={() => onSelect(entry.id)}
                onContextMenu={(e) => {
                  if (!entry.error && entry.outputPath) genMenu.open(e, entry.outputPath, { src: cascadeMedia(prodId, entry.outputPath), media: "image" });
                }}
                title={`${entry.kind === "edit" ? "Edit" : entry.kind === "upscale" ? "Upscale" : "Generate"} · ${entry.model || "auto"} · ${entry.resolution}`}
              >
                {entry.error ? (
                  <span className="suite-rail-err" aria-hidden="true">!</span>
                ) : (
                  <img src={`${cascadeMedia(prodId, entry.outputPath)}?thumb=1`} alt="" loading="lazy" decoding="async" />
                )}
              </button>
              <button className="suite-rail-label" onClick={() => onSelect(entry.id)}>
                <span className="suite-rail-kind">{entry.kind === "edit" ? "Edit" : entry.kind === "upscale" ? "Ups" : "Gen"}</span>
                <span className="suite-rail-prompt">{entry.prompt || (entry.kind === "upscale" ? "Upscaled image" : "(no prompt)")}</span>
                <span className="suite-rail-meta">{entry.model || "auto"} · {entry.resolution}</span>
              </button>
              <div className="suite-rail-actions">
                <button className="suite-rail-btn danger" title="Delete this entry (removes its file)" onClick={() => onDelete(entry.id)}>✕</button>
              </div>
            </div>
          );
        })}
      </div>
      <GenerationMenu menu={genMenu.menu} onClose={genMenu.close} onEditInSuite={onEditInSuite} />
    </aside>
  );
}
