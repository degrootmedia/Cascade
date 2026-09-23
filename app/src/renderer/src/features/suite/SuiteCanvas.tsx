/**
 * Suite canvas: the result viewer (full-res via `cascade-media://`), the A/B
 * compare surface, and the "Before edit" reveal shown right after a handoff
 * seeds an edit source.
 */
import { SuiteCompare } from "./SuiteCompare.js";
import type { SuiteFrame } from "./suite-compare.js";
import type { SuiteEntry } from "./suite-types.js";
import { cascadeMedia } from "../../components/production/animatic.js";
import { GenerationMenu, useGenerationMenu } from "../../components/generation-menu.js";

export function SuiteCanvas({
  prodId,
  entry,
  compare,
  before,
  busy,
  onExport,
  onDelete,
  onEditInSuite,
}: {
  prodId: string;
  entry: SuiteEntry | null;
  compare: { a: SuiteFrame; b: SuiteFrame } | null;
  /** The source "Before edit" frame when no comparison is active yet. */
  before: SuiteFrame | null;
  busy?: boolean;
  onExport: (target: "references" | "boards") => void;
  onDelete: () => void;
  /** Right-click a result → seed it as a new edit source in the suite. */
  onEditInSuite?: (rel: string) => void;
}) {
  const genMenu = useGenerationMenu();
  /** Open the right-click menu for whichever frame was clicked. The suite-only
   *  actions (save as reference / delete / edit in suite) are offered only when
   *  the frame is the selected entry's own output, not a source. */
  const openFrameMenu = (frame: SuiteFrame, e: React.MouseEvent) => {
    if (!frame.rel) return;
    genMenu.open(e, frame.rel, { src: frame.url, media: "image" });
  };
  const menuTargetsEntry = !!entry && genMenu.menu?.rel === entry.outputPath;
  return (
    <section className="suite-canvas" aria-label="Suite canvas">
      <div className="suite-canvas-toolbar">
        <span className="suite-canvas-title">
          {compare ? "Compare" : before ? before.label : entry ? (entry.kind === "edit" ? "Edit result" : entry.kind === "upscale" ? "Upscale result" : "Generation result") : "Nothing selected"}
        </span>
        <div className="suite-canvas-actions">
          <button className="prod-btn ghost" disabled={!entry} onClick={() => onExport("references")} title="Copy this result into the production's references">Save as reference</button>
          <button className="prod-btn ghost danger" disabled={!entry} onClick={onDelete}>Delete</button>
        </div>
      </div>

      <div className="suite-canvas-body">
        {busy && (
          <div className="suite-canvas-busy" aria-live="polite">
            <span className="suite-spinner" aria-hidden="true" /> Generating…
          </div>
        )}
        {compare ? (
          <SuiteCompare a={compare.a} b={compare.b} onFrameContextMenu={openFrameMenu} />
        ) : before ? (
          <figure className="suite-canvas-figure">
            <img
              className="suite-canvas-img suite-canvas-before"
              src={before.url}
              alt={before.label}
              title="Right-click for save, copy, edit, or folder options"
              onContextMenu={(e) => openFrameMenu(before, e)}
            />
            <figcaption>
              <span className="suite-before-badge">A · {before.label}</span> Waiting for the result…
            </figcaption>
          </figure>
        ) : entry ? (
          <figure className="suite-canvas-figure">
            <img
              className="suite-canvas-img"
              src={cascadeMedia(prodId, entry.outputPath)}
              alt={entry.prompt || "suite result"}
              title="Right-click for save, copy, edit, reference, or delete options"
              onContextMenu={(e) => openFrameMenu({ url: cascadeMedia(prodId, entry.outputPath), rel: entry.outputPath, label: entry.prompt }, e)}
            />
            <figcaption>{entry.prompt || (entry.kind === "upscale" ? "Upscaled image" : "")}</figcaption>
          </figure>
        ) : (
          <p className="hint suite-canvas-empty">Select a history entry, or generate one from the prompt panel.</p>
        )}
      </div>
      <GenerationMenu
        menu={genMenu.menu}
        onClose={genMenu.close}
        onSaveAsReference={menuTargetsEntry ? () => onExport("references") : undefined}
        onDelete={menuTargetsEntry ? onDelete : undefined}
        onEditInSuite={menuTargetsEntry ? onEditInSuite : undefined}
      />
    </section>
  );
}
