import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** A generated take targeted by a right-click: viewport point + its
 *  workspace-relative path (the identity `findGeneration`/copy operations use). */
export interface GenerationMenuTarget {
  x: number;
  y: number;
  rel: string;
}

/**
 * The shared right-click menu for any generated image or clip. It is portaled
 * to `document.body` so it escapes React Flow's transformed viewport (a fixed
 * element inside a transformed ancestor would otherwise be positioned relative
 * to that ancestor) and any modal stacking context. "Save as reference" is
 * offered whenever the caller can act on it; "Delete generation…" appears only
 * where deletion is already wired.
 */
export function GenerationMenu({ menu, onClose, onSaveAsReference, onDelete, extra }: {
  menu: GenerationMenuTarget | null;
  onClose: () => void;
  /** Copy this take into referencesDir as a new "Saved Ref_NN" reference. */
  onSaveAsReference?: (rel: string) => void;
  /** Permanently delete this take (confirmation lives in the workspace). */
  onDelete?: (rel: string) => void;
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
  return createPortal(
    <div
      ref={ref}
      className="session-context-menu"
      style={{ position: "fixed", top: menu.y, left: menu.x, zIndex: 130 }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      {extra}
      {onSaveAsReference && (
        <button className="ctx-item" onClick={() => { onSaveAsReference(menu.rel); onClose(); }}>
          Save as reference
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
 *  take's path and suppresses the browser/native menu. */
export function useGenerationMenu(): {
  menu: GenerationMenuTarget | null;
  open: (e: React.MouseEvent, rel: string) => void;
  close: () => void;
} {
  const [menu, setMenu] = useState<GenerationMenuTarget | null>(null);
  const open = (e: React.MouseEvent, rel: string) => {
    if (!rel) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, rel });
  };
  const close = () => setMenu(null);
  return { menu, open, close };
}
