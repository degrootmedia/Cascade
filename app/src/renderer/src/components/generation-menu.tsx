import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useClampedMenuStyle } from "./menu-position.js";
import { useExternalEditorLabel } from "../use-external-editor-label.js";
import { MEDIA_MENU_LABELS } from "../../../shared/menu-labels.js";

/** A generated take targeted by a right-click: viewport point + its
 *  workspace-relative path (the identity `findGeneration`/copy operations use).
 *  `src` is the take's full-res media URL (`cascade-media://…`) — when present
 *  the menu also offers the native Save / Copy / Edit / Open-folder actions. */
export interface GenerationMenuTarget {
  x: number;
  y: number;
  rel: string;
  src?: string;
  /** Media kind; inferred from the path extension when omitted. */
  media?: "image" | "video";
}

/** Production + relative path for the "Send to assembly folder" action,
 *  derived from the take's cascade-media URL. */
export function assemblySendTarget(t: { rel: string; src?: string }): { productionId: string; relPath: string } | null {
  if (!t.src || !t.src.startsWith("cascade-media://")) return null;
  try {
    const u = new URL(t.src);
    if (!u.hostname || !t.rel) return null;
    return { productionId: u.hostname, relPath: t.rel };
  } catch { return null; }
}

const VIDEO_REL_RX = /\.(mp4|webm|mov|m4v|mkv|avi)$/i;

/** Whether a target is a video clip (explicit `media` wins; else the path). */
function targetIsVideo(t: GenerationMenuTarget): boolean {
  if (t.media) return t.media === "video";
  return VIDEO_REL_RX.test(t.rel);
}

/**
 * The shared right-click menu for any generated image or clip. It is portaled
 * to `document.body` so it escapes React Flow's transformed viewport (a fixed
 * element inside a transformed ancestor would otherwise be positioned relative
 * to that ancestor) and any modal stacking context. Its z-index must clear the
 * detached canvas overlay (200) so the menu still shows inside a popped-out
 * node graph. When the target carries a
 * `src`, it leads with the same native media actions every other image in the
 * app gets (Save as… / Copy image / the external-editor action / Open file folder);
 * "Save as reference" is offered whenever the caller can act on it; "Delete
 * generation…" appears only where deletion is already wired.
 */
export function GenerationMenu({ menu, onClose, onSaveAsReference, onDelete, onRefresh, onEditInSuite, selectTag, extra }: {
  /** Video takes: tag/untag as an assembly "select". */
  selectTag?: { selected: boolean; onToggle: (rel: string, selected: boolean) => void };
  menu: GenerationMenuTarget | null;
  onClose: () => void;
  /** Copy this take into referencesDir as a new reference (via the save popup). */
  onSaveAsReference?: (rel: string) => void;
  /** Permanently delete this take (confirmation lives in the workspace). */
  onDelete?: (rel: string) => void;
  /** Re-fetch this take from disk (external-edit fallback). */
  onRefresh?: (rel: string) => void;
  /** Seed this image as the Image Suite's edit source ("Before edit" frame). */
  onEditInSuite?: (rel: string) => void;
  /** Additional items rendered above the shared ones. */
  extra?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const editorLabel = useExternalEditorLabel();
  const menuStyle = useClampedMenuStyle(menu, ref);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, onClose]);
  if (!menu) return null;
  const src = menu.src;
  const isVideo = targetIsVideo(menu);
  const sendInfo = assemblySendTarget(menu);
  return createPortal(
    <div
      ref={ref}
      className="session-context-menu"
      style={{ ...menuStyle, zIndex: 300 }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      {extra}
      {selectTag && isVideo && (
        <button className="ctx-item" onClick={() => { selectTag.onToggle(menu.rel, !selectTag.selected); onClose(); }}>
          {selectTag.selected ? "Remove select tag" : "Tag as select (export with assembly)"}
        </button>
      )}
      {sendInfo && (
        <button className="ctx-item" onClick={() => { onClose(); void window.cascade.assemblySend(sendInfo.productionId, sendInfo.relPath); }}>
          Send to assembly folder
        </button>
      )}
      {src && (
        <>
          <button className="ctx-item" onClick={() => { onClose(); void window.cascade.saveImage(src); }}>
            {isVideo ? MEDIA_MENU_LABELS.saveVideoAs : MEDIA_MENU_LABELS.saveImageAs}
          </button>
          {!isVideo && (
            <button
              className="ctx-item"
              onClick={() => {
                onClose();
                // Copy from the take's own source (main resolves the file
                // behind the cascade-media URL) — no page hit-testing, so
                // the menu sitting over the image can't swallow the copy.
                void window.cascade.copyImage({ src, relPath: menu.rel, x: menu.x, y: menu.y });
              }}
            >
              {MEDIA_MENU_LABELS.copyImage}
            </button>
          )}
          {!isVideo && (
            <button className="ctx-item" onClick={() => { onClose(); void window.cascade.editImageExternally({ src, relPath: menu.rel }); }}>
              {editorLabel}
            </button>
          )}
          <button className="ctx-item" onClick={() => { onClose(); void window.cascade.showInFolder({ src, relPath: menu.rel }); }}>
            {MEDIA_MENU_LABELS.openFolder}
          </button>
          <div className="ctx-sep" />
        </>
      )}
      {onSaveAsReference && (
        <button className="ctx-item" onClick={() => { onSaveAsReference(menu.rel); onClose(); }}>
          {MEDIA_MENU_LABELS.saveAsReference}
        </button>
      )}
      {onEditInSuite && !isVideo && (
        <button className="ctx-item" onClick={() => { onEditInSuite(menu.rel); onClose(); }}>
          {MEDIA_MENU_LABELS.editInSuite}
        </button>
      )}
      {onRefresh && (
        <button
          className="ctx-item"
          title="Re-fetch this take from disk — use if it was edited outside Cascade and the automatic update didn't land"
          onClick={() => { onClose(); onRefresh(menu.rel); }}
        >
          {isVideo ? MEDIA_MENU_LABELS.refreshClip : MEDIA_MENU_LABELS.refreshImage}
        </button>
      )}
      {onDelete && (
        <button className="ctx-item danger" onClick={() => { onDelete(menu.rel); onClose(); }}>
          {MEDIA_MENU_LABELS.deleteGeneration}
        </button>
      )}
    </div>,
    document.body,
  );
}

/** Menu state for `GenerationMenu`. `open` stores the click position with the
 *  take's path (plus its media URL when the caller has it) and suppresses the
 *  browser/native menu. */
export function useGenerationMenu(): {
  menu: GenerationMenuTarget | null;
  open: (e: React.MouseEvent, rel: string, media?: { src?: string; media?: "image" | "video" }) => void;
  close: () => void;
} {
  const [menu, setMenu] = useState<GenerationMenuTarget | null>(null);
  const open = (e: React.MouseEvent, rel: string, media?: { src?: string; media?: "image" | "video" }) => {
    if (!rel) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, rel, ...media });
  };
  const close = () => setMenu(null);
  return { menu, open, close };
}
