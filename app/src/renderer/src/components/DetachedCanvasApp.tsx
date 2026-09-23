/**
 * Detached canvas window (Spec 03) — the renderer booted with
 * `?window=detached&target=…`. It hosts the production workspace scoped to a
 * single canvas (node graph or reference moodboard) with all chrome hidden, and
 * follows the main window's storyboard selection.
 *
 * The window is the same bundle and the same `window.cascade` API — there is no
 * privileged second preload. Main owns the context and re-pushes it on reload.
 */
import { useEffect, useState } from "react";
import type { DetachedCanvasContext } from "../../../shared/ipc/window.js";
import { ProductionWorkspace } from "./ProductionWorkspace.js";

export function DetachedCanvasApp() {
  const [ctx, setCtx] = useState<DetachedCanvasContext | null>(null);
  const [title, setTitle] = useState("Canvas");

  useEffect(() => {
    const offCtx = window.cascade.onCanvasContext((next) => setCtx(next));
    const offSel = window.cascade.onCanvasSelectionChanged((e) => {
      setCtx((prev) => (prev ? { ...prev, frameId: e.frameId } : prev));
    });
    // The boot URL only carries `target`; the full context arrives over
    // `canvas:context`. If it was pushed before this listener attached (a very
    // fast did-finish-load), ask main for the current context as a fallback.
    void window.cascade
      .getDetachedCanvasState()
      .then((s) => {
        if (s.open && s.productionId && s.target) {
          setCtx((prev) => prev ?? { productionId: s.productionId!, target: s.target!, frameId: s.frameId });
        }
      })
      .catch(() => {});
    return () => {
      offCtx();
      offSel();
    };
  }, []);

  if (!ctx) {
    return (
      <div className="detached-canvas detached-canvas--empty">
        <p>Waiting for the canvas…</p>
      </div>
    );
  }

  return (
    <div className="detached-canvas">
      <header className="detached-canvas-bar" title={title}>
        <span className="detached-canvas-dot" aria-hidden="true" />
        <span className="detached-canvas-title">{title}</span>
      </header>
      <div className="detached-canvas-body">
        <ProductionWorkspace detached={ctx} onDetachedTitle={setTitle} />
      </div>
    </div>
  );
}
