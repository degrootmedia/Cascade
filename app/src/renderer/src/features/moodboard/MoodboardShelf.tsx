/**
 * Off-board reference shelf: every reference the user has taken off the
 * moodboard canvas (removed from the board, or never placed). Drag a tile onto
 * the canvas — or click it — to put it back. Mirrors the node graph's shelf in
 * miniature: compressed thumbnails, names, and a drag payload carrying the
 * `application/x-cascade-reference` id the canvas drop handler consumes.
 *
 * Tiles are grouped by the production's reference categories — the same
 * groups (and order) as the Step 2 Design panel: Uncategorized first, then
 * each category in production order. Group collapsed state shares the Design
 * panel's persisted key, so collapsing a category in either place collapses
 * it in both.
 */
import { memo, useEffect, useMemo, useState } from "react";
import type { CustomRef, ReferenceCategory } from "../../../../shared/ipc.js";
import { cascadeMedia } from "../../components/production/animatic.js";
import { refThumbUrl } from "../../components/production/thumb-url.js";
import { usePersistedCollapsed } from "../../components/production/persisted-state.js";
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
        decoding="async"
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

export interface ShelfRefGroup {
  /** Category id ("" = Uncategorized). */
  id: string;
  title: string;
  refs: CustomRef[];
}

/** Group shelf refs by category in Design-panel order (Uncategorized first,
 *  then production category order); empty groups are omitted and a ref whose
 *  category no longer exists lands in Uncategorized. Pure — order within a
 *  group follows the input array. */
export function groupShelfRefs(refs: CustomRef[], categories: ReferenceCategory[]): ShelfRefGroup[] {
  const order: { id: string; title: string }[] = [
    { id: "", title: "Uncategorized" },
    ...categories.map((c) => ({ id: c.id, title: c.name })),
  ];
  const known = new Set(order.map((g) => g.id));
  const byId = new Map<string, CustomRef[]>(order.map((g) => [g.id, []]));
  for (const r of refs) {
    const key = r.categoryId && known.has(r.categoryId) ? r.categoryId : "";
    byId.get(key)!.push(r);
  }
  return order
    .map((g) => ({ ...g, refs: byId.get(g.id)! }))
    .filter((g) => g.refs.length > 0);
}

function ShelfItem({ prodId, refItem, onAdd, onZoom }: {
  prodId: string;
  refItem: CustomRef;
  onAdd: (id: string) => void;
  onZoom: (ref: CustomRef) => void;
}) {
  const r = refItem;
  const imgUrl = r.imagePath ? cascadeMedia(prodId, r.imagePath) : r.artwork;
  const isVideo = r.media === "video" && !!r.mediaPath;
  const hasImage = !!imgUrl && !isVideo;
  return (
    <div
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
}

/** One collapsible category group. The persisted key matches the Design
 *  panel's `CategoryPanel`, so both surfaces share collapsed state. */
function ShelfGroup({ prodId, group, onAdd, onZoom }: {
  prodId: string;
  group: ShelfRefGroup;
  onAdd: (id: string) => void;
  onZoom: (ref: CustomRef) => void;
}) {
  const [collapsed, setCollapsed] = usePersistedCollapsed(`cascade.prod.${prodId}.refcat.${group.id || "uncategorized"}`);
  const open = !collapsed;
  return (
    <div className="moodboard-shelf-group">
      <button
        type="button"
        className="moodboard-shelf-group-head"
        aria-expanded={open}
        title={open ? `Collapse ${group.title}` : `Expand ${group.title}`}
        onClick={() => setCollapsed(!collapsed)}
      >
        <svg className={"moodboard-shelf-caret" + (open ? " open" : "")} viewBox="0 0 16 16" width="9" height="9" aria-hidden="true"><path d="M5 3l6 5-6 5V3z" fill="currentColor" /></svg>
        <span className="moodboard-shelf-group-name">{group.title}</span>
        <span className="moodboard-shelf-count">{group.refs.length}</span>
      </button>
      {open && group.refs.map((r) => (
        <ShelfItem key={r.id} prodId={prodId} refItem={r} onAdd={onAdd} onZoom={onZoom} />
      ))}
    </div>
  );
}

export const MoodboardShelf = memo(function MoodboardShelf({
  prodId,
  refs,
  categories,
  onAdd,
  onZoom,
}: {
  prodId: string;
  /** References not currently on the board, in production order. */
  refs: CustomRef[];
  /** The production's reference categories (Design-panel order). */
  categories: ReferenceCategory[];
  /** Put a reference back on the canvas (click). */
  onAdd: (id: string) => void;
  /** Open a reference in the full-size lightbox. */
  onZoom: (ref: CustomRef) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const groups = useMemo(() => groupShelfRefs(refs, categories), [refs, categories]);

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
        {groups.map((group) => (
          <ShelfGroup key={group.id || "uncategorized"} prodId={prodId} group={group} onAdd={onAdd} onZoom={onZoom} />
        ))}
      </div>
    </aside>
  );
});
