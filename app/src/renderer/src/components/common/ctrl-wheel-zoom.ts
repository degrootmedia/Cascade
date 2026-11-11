/**
 * Ctrl+Mouse Wheel zoom for every view, panel-aware.
 *
 * Two pieces share one wheel dispatch:
 *
 *  - `useCtrlWheelZoom` marks a panel that already has its own zoom control
 *    (a slider: the Script zoom, Storyboard frame size, a Design reference
 *    category's tile size). A Ctrl+wheel over the panel is claimed there and
 *    steps only that panel's value, clamped by the caller to the panel's
 *    existing range. The claim (preventDefault + stopPropagation) keeps the
 *    gesture from also scrolling the view or reaching the page zoom — even
 *    when the panel is already at its limit.
 *
 *  - `installCtrlWheelPageZoom` is the window-level fallback, installed once
 *    from the renderer entry so it covers every view (Chat, Production
 *    Assistant, overlays, the detached canvas window). It listens in the
 *    bubble phase, so it runs only after every handler under the cursor had
 *    its chance: a canvas that owns the wheel already (moodboard, timeline,
 *    media lightbox, node graph — each zooms itself and calls
 *    preventDefault) leaves the event `defaultPrevented`, and the fallback
 *    stays out of it. A slider panel's listener runs on the panel element
 *    for the same reason: an inner wheel-owning canvas (the node graph
 *    opened over the storyboard) claims the event before the panel sees it,
 *    and the `defaultPrevented` check keeps the panel from zooming too.
 *
 * Anything left — empty space, panels with no zoom of their own — steps the
 * whole-page zoom through `window.cascade.zoomPageBy`, the same Electron
 * zoom level the Ctrl+= / Ctrl+- shortcuts drive. Plain wheel (no Ctrl) is
 * never touched, so scrolling behaves exactly as before.
 */
import { useCallback, useRef } from "react";

/** Wheel sensitivity shared with the moodboard/lightbox wheel zooms. */
const WHEEL_ZOOM_RATE = 0.0015;

/** The multiplicative zoom step for one wheel event: wheel-up (negative
 *  deltaY) zooms in. `deltaMode` is normalized the way the lightbox does it
 *  (lines × 16px, pages × the viewport height) so mouse notches, line
 *  wheels, and trackpad pinch (wheel + ctrlKey) step comparably. */
export function wheelZoomFactor(
  e: { deltaY: number; deltaMode: number },
  pageHeight: number,
): number {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? Math.max(pageHeight, 1) : 1;
  return Math.exp(-e.deltaY * unit * WHEEL_ZOOM_RATE);
}

/** A slider-style panel value after one wheel step: scaled by `factor`,
 *  rounded to a whole unit, clamped to the panel's existing range. */
export function zoomedSliderValue(current: number, factor: number, min: number, max: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return Math.min(max, Math.max(min, Math.round(current)));
  return Math.min(max, Math.max(min, Math.round(current * factor)));
}

/** True for a wheel gesture that means "zoom": Ctrl (or Cmd) held, with a
 *  vertical delta. Chromium also reports trackpad pinch this way. A
 *  horizontal-only wheel stays a scroll. */
export function isZoomWheel(e: { ctrlKey: boolean; metaKey: boolean; deltaY: number }): boolean {
  return (e.ctrlKey || e.metaKey) && e.deltaY !== 0;
}

/** Page-zoom level delta for one wheel event. Electron's zoom factor is
 *  1.2^level, so a level delta is the wheel factor in log(1.2) units. */
export function pageZoomLevelDelta(e: { deltaY: number; deltaMode: number }, pageHeight: number): number {
  return Math.log(wheelZoomFactor(e, pageHeight)) / Math.log(1.2);
}

/**
 * Give a panel with its own zoom control first claim on Ctrl+wheel over it.
 * Returns a ref to put on the panel's root element. `onZoom` receives the
 * wheel's multiplicative factor (> 1 zooms in) and applies it to the
 * panel's own value/range; pass null when the panel has no live zoom
 * control, which leaves the gesture to the page zoom like any other panel.
 */
export function useCtrlWheelZoom<T extends HTMLElement>(
  onZoom: ((factor: number) => void) | null | undefined,
): (el: T | null) => void {
  // The handler reads the latest callback through a ref: panels are often
  // memoized past callback identity, and the listener must never call a
  // stale closure.
  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;
  const cleanupRef = useRef<(() => void) | null>(null);
  // A callback ref, not an effect on a ref object: panels render
  // conditionally inside long-lived parents (Script/Storyboard steps swap
  // within the workspace), so the listener must attach when the panel
  // element appears and detach when it goes away.
  const ref = useCallback((el: T | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // An inner wheel-owning canvas (node graph over the storyboard,
      // lightbox, …) already claimed this event on its way up.
      if (!isZoomWheel(e) || e.defaultPrevented) return;
      const zoom = onZoomRef.current;
      if (!zoom) return;
      e.preventDefault();
      e.stopPropagation();
      zoom(wheelZoomFactor(e, window.innerHeight));
    };
    // Non-passive: React's delegated wheel listener can't preventDefault,
    // and claiming the gesture is what stops the view from also scrolling.
    el.addEventListener("wheel", onWheel, { passive: false });
    cleanupRef.current = () => el.removeEventListener("wheel", onWheel);
  }, []);
  // Unmount arrives as this same callback with null, which detaches above.
  return ref;
}

/**
 * Install the whole-page Ctrl+wheel zoom fallback on `target` (the window).
 * Bubble phase on purpose: handlers under the cursor run first, so a panel
 * zoom that claimed the event (preventDefault) or stopped its propagation
 * is never double-zoomed by the page. Returns the uninstaller.
 */
export function installCtrlWheelPageZoom(
  target: Window,
  zoomPageBy: (levelDelta: number) => void,
): () => void {
  const onWheel = (e: WheelEvent) => {
    if (!isZoomWheel(e) || e.defaultPrevented) return;
    // Claim before zooming so the gesture cannot also scroll the view or
    // trigger the browser's own Ctrl+wheel page zoom on top of ours.
    e.preventDefault();
    zoomPageBy(pageZoomLevelDelta(e, target.innerHeight));
  };
  target.addEventListener("wheel", onWheel, { passive: false });
  return () => target.removeEventListener("wheel", onWheel);
}
