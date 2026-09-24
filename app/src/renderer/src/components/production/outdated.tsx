/**
 * Outdated panels — the trailing, read-only section of the Step 3 storyboard.
 *
 * Each card is a shot preserved from an earlier script ingestion. A re-ingest
 * moves its board folder to `boards/outdated/<id>/` (so a fresh shot re-using
 * its number can't overwrite it) and drops it on `Production.outdatedShots`.
 * The cards show the frame, number, and Audio/Visual text; the frame opens
 * full-res in an overlay, and every panel can be Restored (back into the active
 * storyboard with a fresh number) or Deleted.
 */
import { memo, useState } from "react";
import type { Production, ProductionShot } from "../../../../shared/ipc.js";
import { cascadeMedia } from "./animatic.js";
import { refThumbUrl } from "./thumb-url.js";

interface Props {
  prod: Production;
  /** Apply a mutation promise — the workspace's `apply` hot-swaps the doc. */
  onMutate: (p: Promise<Production>) => void;
}

/**
 * Source for a panel's tile: the frame when it has one, else the clip path —
 * `?thumb=1` yields a compressed still (a video gets its middle-frame poster).
 * Inline data URLs and already-built cascade URLs pass through unchanged.
 */
function thumbUrl(prod: Production, shot: ProductionShot): string | null {
  const rel = shot.artwork ?? shot.videoPath;
  if (!rel) return null;
  if (rel.startsWith("data:") || rel.startsWith("cascade-media://")) return refThumbUrl(rel);
  return refThumbUrl(cascadeMedia(prod.meta.id, rel));
}

/** Full-resolution media for the overlay: the frame, else the clip. */
function fullMedia(prod: Production, shot: ProductionShot): { url: string; kind: "image" | "video" } | null {
  const rel = shot.artwork ?? shot.videoPath;
  if (!rel) return null;
  const url = rel.startsWith("data:") || rel.startsWith("cascade-media://")
    ? rel
    : cascadeMedia(prod.meta.id, rel);
  return { url, kind: shot.artwork ? "image" : "video" };
}

const OutdatedCard = memo(function OutdatedCard({
  prod,
  shot,
  onMutate,
  onZoom,
}: {
  prod: Production;
  shot: ProductionShot;
  onMutate: Props["onMutate"];
  onZoom: (media: { url: string; kind: "image" | "video"; label: string }) => void;
}) {
  const src = thumbUrl(prod, shot);
  return (
    <figure className="prod-outdated-card">
      <button
        type="button"
        className="prod-outdated-frame"
        onClick={() => { const media = fullMedia(prod, shot); if (media) onZoom({ ...media, label: `Shot ${shot.number}` }); }}
        disabled={!src}
        title={src ? "View full panel" : "No frame"}
      >
        {src
          ? <img src={src} alt={`Outdated shot ${shot.number}`} loading="lazy" />
          : <span className="prod-outdated-noframe">{shot.videoPath ? "Clip panel" : "No frame"}</span>}
        <span className="prod-outdated-badge">Outdated</span>
      </button>
      <figcaption className="prod-outdated-meta">
        <span className="prod-outdated-number">Shot {shot.number}</span>
        {shot.audio.trim() && <p className="prod-outdated-text"><b>A</b> {shot.audio}</p>}
        {shot.visual.trim() && <p className="prod-outdated-text"><b>V</b> {shot.visual}</p>}
      </figcaption>
      <div className="prod-outdated-actions">
        <button
          className="prod-btn"
          onClick={() => onMutate(window.cascade.restoreOutdatedShot(prod.meta.id, shot.id))}
          title="Put this panel back into the active storyboard with a fresh shot number"
        >Restore</button>
        <button
          className="prod-btn danger"
          onClick={() => {
            if (confirm(`Delete outdated shot ${shot.number} and its preserved frames? This can't be undone.`)) {
              onMutate(window.cascade.removeOutdatedShot(prod.meta.id, shot.id));
            }
          }}
        >Delete</button>
      </div>
    </figure>
  );
});

export function OutdatedSection({ prod, onMutate }: Props) {
  const shots = prod.outdatedShots ?? [];
  const [zoom, setZoom] = useState<{ url: string; kind: "image" | "video"; label: string } | null>(null);
  if (!shots.length) return null;
  return (
    <section className="prod-outdated">
      <header className="prod-outdated-head">
        <h3>Outdated panels</h3>
        <span className="hint">
          {shots.length} kept from earlier script ingestion{shots.length === 1 ? "" : "s"} — not part of the active
          storyboard.
        </span>
      </header>
      <div className="prod-outdated-grid">
        {shots.map((shot) => (
          <OutdatedCard key={shot.id} prod={prod} shot={shot} onMutate={onMutate} onZoom={setZoom} />
        ))}
      </div>
      {zoom && (
        <div className="prod-ref-lightbox" onClick={() => setZoom(null)}>
          <figure className="prod-ref-lightbox-card">
            {zoom.kind === "video"
              ? <video className="prod-ref-lightbox-video" src={zoom.url} controls autoPlay playsInline />
              : <img src={zoom.url} alt={zoom.label} />}
            <figcaption>{zoom.label} — click anywhere to close</figcaption>
          </figure>
        </div>
      )}
    </section>
  );
}
