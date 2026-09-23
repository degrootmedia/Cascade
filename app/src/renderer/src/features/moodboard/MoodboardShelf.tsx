/**
 * Off-board reference shelf: every reference the user has taken off the
 * moodboard canvas (removed from the board, or never placed). Drag a tile onto
 * the canvas — or click it — to put it back. Mirrors the node graph's shelf in
 * miniature: compressed thumbnails, names, and a drag payload carrying the
 * `application/x-cascade-reference` id the canvas drop handler consumes.
 */
import { useEffect, useState } from "react";
import type { CustomRef } from "../../../../shared/ipc.js";
import { cascadeMedia } from "../../components/production/animatic.js";
import { refThumbUrl } from "../../components/production/thumb-url.js";
import { MagnifyIcon } from "../../components/icons.js";

/** A shelf tile's artwork: the compressed image thumbnail, or a video's
 *  middle-frame poster (`?thumb=1` serves both). Falls back to a media glyph
 *  if the poster can't be produced (no ffmpeg / undecodable); the poster is
 *  generated on demand, so a transient failure retries before giving up. */
function ShelfThumb({ prodId, refItem }: { prodId: string; refItem: CustomRef }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const isVideo = refItem.media === "video" && !!refItem.mediaPath;
  const url = isVideo
    ? cascadeMedia(prodId, refItem.mediaPath!)
    : refItem.imagePath
      ? cascadeMedia(prodId, refItem.imagePath)
      : refItem.artwork;
  useEffect(() => {
    setAttempt(0);
    setFailed(false);
  }, [url]);
  if (url && !failed) {
    return (
      <img
        key={attempt}
        className="moodboard-shelf-thumb"
        src={refThumbUrl(url) + (attempt ? `&r=${attempt}` : "")}
        alt={refItem.name}
        draggable={false}
        onError={() => {
          if (attempt < 2) window.setTimeout(() => setAttempt((a) => a + 1), 1500);
          else setFailed(true);
        }}
      />
    );
  }
  return <div className="moodboard-shelf-blank">{isVideo ? "▶" : refItem.media === "audio" ? "♪" : "?"}</div>;
}

export function MoodboardShelf({
  prodId,
  refs,
  onAdd,
  onZoom,
}: {
  prodId: string;
  /** References not currently on the board, in production order. */
  refs: CustomRef[];
  /** Put a reference back on the canvas (click). */
  onAdd: (id: string) => void;
  /** Open a reference in the full-size lightbox. */
  onZoom: (ref: CustomRef) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <div className="moodboard-shelf collapsed">
        <button
          type="button"
          className="moodboard-shelf-rail"
          aria-expanded={false}
          title="Show the off-board references"
          onClick={() => setCollapsed(false)}
        >
          <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M6 3l5 5-5 5V3z" fill="currentColor" /></svg>
          <span className="moodboard-shelf-rail-label">Shelf</span>
          {refs.length > 0 && <span className="moodboard-shelf-rail-count">{refs.length}</span>}
        </button>
      </div>
    );
  }

  return (
    <aside className="moodboard-shelf">
      <div className="moodboard-shelf-head">
        <span className="moodboard-shelf-title">Shelf</span>
        <span className="moodboard-shelf-count">{refs.length}</span>
        <button
          type="button"
          className="moodboard-shelf-toggle"
          aria-expanded
          title="Collapse the shelf"
          onClick={() => setCollapsed(true)}
        >
          <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M10 3L5 8l5 5V3z" fill="currentColor" /></svg>
        </button>
      </div>
      <div className="moodboard-shelf-list">
        {refs.length === 0 && (
          <div className="moodboard-shelf-empty">Every reference is on the board. Remove one from the canvas to park it here.</div>
        )}
        {refs.map((r) => {
          const imgUrl = r.imagePath ? cascadeMedia(prodId, r.imagePath) : r.artwork;
          const isVideo = r.media === "video" && !!r.mediaPath;
          const hasImage = !!imgUrl && !isVideo;
          return (
            <div
              key={r.id}
              className="moodboard-shelf-item"
              draggable
              title={`Drag onto the board to add @[${r.name}]`}
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-cascade-reference", r.id);
                e.dataTransfer.effectAllowed = "copyMove";
              }}
              onClick={() => onAdd(r.id)}
            >
              <ShelfThumb prodId={prodId} refItem={r} />
              <span className="moodboard-shelf-name" title={`Reference @[${r.name}]`}>@[{r.name}]</span>
              {(hasImage || isVideo) && (
                <button
                  type="button"
                  className="moodboard-shelf-zoom"
                  title={isVideo ? "Play full resolution" : "View full resolution"}
                  draggable={false}
                  onClick={(e) => { e.stopPropagation(); onZoom(r); }}
                >
                  <MagnifyIcon size={11} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
