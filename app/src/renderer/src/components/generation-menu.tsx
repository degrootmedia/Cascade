import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

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
 * app gets (Save as… / Copy image / Edit externally / Open file folder);
 * "Save as reference" is offered whenever the caller can act on it; "Delete
 * generation…" appears only where deletion is already wired.
 */
export function GenerationMenu({ menu, onClose, onSaveAsReference, onDelete, onEditInSuite, extra }: {
  menu: GenerationMenuTarget | null;
  onClose: () => void;
  /** Copy this take into referencesDir as a new "Saved Ref_NN" reference. */
  onSaveAsReference?: (rel: string) => void;
  /** Permanently delete this take (confirmation lives in the workspace). */
  onDelete?: (rel: string) => void;
  /** Seed this image as the Image Suite's edit source ("Before edit" frame). */
  onEditInSuite?: (rel: string) => void;
  /** Additional items rendered above the shared ones. */
  extra?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
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
  return createPortal(
    <div
      ref={ref}
      className="session-context-menu"
      style={{ position: "fixed", top: menu.y, left: menu.x, zIndex: 300 }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      {extra}
      {src && (
        <>
          <button className="ctx-item" onClick={() => { onClose(); void window.cascade.saveImage(src); }}>
            {isVideo ? "Save video as…" : "Save image as…"}
          </button>
          {!isVideo && (
            <button
              className="ctx-item"
              onClick={() => {
                const { x, y } = menu;
                onClose();
                // Let the menu unmount before main samples the page at (x, y),
                // so "Copy image" captures the take, not the menu sitting on it.
                requestAnimationFrame(() => { void window.cascade.copyImage(x, y); });
              }}
            >
              Copy image
            </button>
          )}
          {!isVideo && (
            <button className="ctx-item" onClick={() => { onClose(); void window.cascade.editImageExternally({ src, relPath: menu.rel }); }}>
              Edit externally
            </button>
          )}
          <button className="ctx-item" onClick={() => { onClose(); void window.cascade.showInFolder({ src, relPath: menu.rel }); }}>
            Open file folder
          </button>
          <div className="ctx-sep" />
        </>
      )}
      {onSaveAsReference && (
        <button className="ctx-item" onClick={() => { onSaveAsReference(menu.rel); onClose(); }}>
          Save as reference
        </button>
      )}
      {onEditInSuite && !isVideo && (
        <button className="ctx-item" onClick={() => { onEditInSuite(menu.rel); onClose(); }}>
          Edit in Suite
        </button>
      )}
      {onDelete && (
        <button className="ctx-item danger" onClick={() => { onDelete(menu.rel); onClose(); }}>
          Delete generation…
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
