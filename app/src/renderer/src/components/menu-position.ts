/**
 * Clamp a fixed-position context menu inside the viewport.
 *
 * Context menus are placed at the raw pointer coordinates, so right-clicking
 * near the bottom or right edge used to push items (Archive, Delete, …) past
 * the window and make them unclickable. Measure the real menu box after mount
 * and shift it back inside the viewport, keeping a small edge gap. Re-measures
 * on window resize and whenever the menu's own content changes size, so menus
 * with conditional items (generation menu) stay correct after they open.
 *
 * Callers pass their existing outside-click ref so the hook adds no ref
 * plumbing; the layout effect runs before paint, so the corrected position is
 * never visibly flashed.
 */
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/** Gap kept between a menu and the viewport edge, in px. */
const EDGE = 8;

export function useClampedMenuStyle(
  menu: { x: number; y: number } | null,
  ref: RefObject<HTMLElement | null>,
): CSSProperties {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu) {
      setPos(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const { width, height } = el.getBoundingClientRect();
      const maxLeft = Math.max(EDGE, window.innerWidth - width - EDGE);
      const maxTop = Math.max(EDGE, window.innerHeight - height - EDGE);
      setPos({
        left: Math.min(Math.max(EDGE, menu.x), maxLeft),
        top: Math.min(Math.max(EDGE, menu.y), maxTop),
      });
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(el);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [menu, ref]);

  // menu.x / menu.y aren't destructured so this hook re-runs when the menu
  // object identity changes (each right-click creates a fresh object).
  const left = pos?.left ?? menu?.x ?? 0;
  const top = pos?.top ?? menu?.y ?? 0;
  return { position: "fixed", left, top };
}
