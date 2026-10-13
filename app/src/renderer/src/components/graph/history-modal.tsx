import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { GenerationMenu, useGenerationMenu, type GenerationMenuTarget } from "../generation-menu.js";
import { refThumbUrl } from "../production/thumb-url.js";

/** Which node's take history a `GraphHistoryModal` shows. `nodeId` names the
 *  specific list entry (a video/edit node); image/upscale are singletons. */
export interface GraphHistoryTarget {
  kind: "image" | "video" | "edit" | "editvideo" | "upscale";
  nodeId?: string;
  title: string;
}

/** One stored take. `draftJobId` marks a Seedance 2.5 480p draft that can be
 *  finalized at 1080p within the vendor's window. */
export interface GraphHistoryItem {
  url: string;
  prompt: string;
  path: string;
  draftJobId?: string;
}

/**
 * The full generation history for one node. The node's inline strip shows only
 * the newest few takes; this lists every stored take (bounded by
 * `GRAPH_HISTORY_CAP`) with a thumbnail, click-to-select, and the shared
 * right-click menu. Portaled to `document.body` so it escapes React Flow's
 * transformed viewport, like `GenerationMenu`.
 */
export function GraphHistoryModal({ target, items, selected, media, onSelect, onClose, onZoom, onDelete, onSaveAsRef, onEditInSuite, onRefresh, onUpgradeDraft, upgradingRel }: {
  target: GraphHistoryTarget | null;
  items: GraphHistoryItem[];
  selected: number;
  media: "image" | "video";
  onSelect: (index: number) => void;
  onClose: () => void;
  onZoom: (name: string, url: string, kind: "image" | "video", rel: string) => void;
  onDelete?: (rel: string) => void;
  onSaveAsRef?: (rel: string) => void;
  onEditInSuite?: (rel: string) => void;
  /** Re-fetch a take from disk (external-edit fallback). */
  onRefresh?: (rel: string) => void;
  /** Finalize a Seedance 2.5 draft take at 1080p. */
  onUpgradeDraft?: (rel: string) => void;
  /** The take currently being upgraded (shows a busy label). */
  upgradingRel?: string | null;
}) {
  const genMenu = useGenerationMenu();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [target, onClose]);
  if (!target) return null;
  return createPortal(
    <div className="prod-graph-history-overlay" onMouseDown={onClose}>
      <div
        className="prod-graph-history"
        ref={ref}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="prod-graph-history-head">
          <span className="prod-graph-history-title">{target.title}</span>
          <span className="prod-graph-history-count">{items.length} stored take{items.length === 1 ? "" : "s"}</span>
          <button className="prod-graph-history-close" title="Close" onClick={onClose}>×</button>
        </div>
        {items.length === 0
          ? <div className="prod-graph-history-empty">No generations yet.</div>
          : (
            <div className="prod-graph-history-grid">
              {items.map((it, i) => (
                <button
                  key={i}
                  className={"prod-graph-history-tile" + (i === selected ? " sel" : "")}
                  title={`${it.prompt || `Take ${i + 1}`} — click to select, double-click to enlarge, right-click for options`}
                  onClick={() => onSelect(i)}
                  onDoubleClick={() => onZoom(target.title, it.url, media, it.path)}
                  onContextMenu={(e) => genMenu.open(e, it.path, { src: it.url, media })}
                >
                  <img src={refThumbUrl(it.url)} alt="" draggable={false} />
                  <span className="prod-graph-history-badge">{i + 1}</span>
                  {it.draftJobId && onUpgradeDraft && (
                    <span
                      className="prod-graph-history-upgrade nodrag"
                      role="button"
                      title="Seedance 2.5 draft — finalize at 1080p (within the vendor's window)"
                      onClick={(e) => { e.stopPropagation(); onUpgradeDraft(it.path); }}
                    >
                      {upgradingRel === it.path ? "Upgrading…" : "↑1080p"}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        <div className="prod-graph-history-foot">
          <button
            className="prod-btn"
            onClick={() => { const it = items[selected]; if (it) void window.cascade.showInFolder({ src: it.url, relPath: it.path }); }}
            disabled={!items[selected]}
          >
            Open folder
          </button>
        </div>
        <GenerationMenu
          menu={genMenu.menu as GenerationMenuTarget | null}
          onClose={genMenu.close}
          onSaveAsReference={onSaveAsRef}
          onDelete={onDelete}
          onRefresh={onRefresh}
          onEditInSuite={onEditInSuite}
        />
      </div>
    </div>,
    document.body,
  );
}
