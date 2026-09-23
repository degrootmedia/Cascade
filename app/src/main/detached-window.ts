/**
 * Detached canvas window (Spec 03).
 *
 * Owns the single `BrowserWindow` that hosts either the node graph or the
 * reference moodboard on a second monitor. Everything Electron-specific is
 * injected (`createWindow`, `resolveLoadUrl`, `onClosed`, `ensureVisible`) so
 * the controller is unit-testable with a fake window — the injection IS the
 * test surface, same pattern as `OpenArtClient`/`ModelGenClient`.
 *
 * Security invariants (asserted in tests):
 *  - same preload as the main window, contextIsolation on, sandboxed,
 *    `nodeIntegration: false` — never looser than the main window.
 *  - the target is validated against the two known canvases before the window
 *    is created or a context is pushed.
 */
import type { DetachedCanvasContext, DetachedCanvasState, DetachedCanvasTarget } from "../shared/ipc/window.js";

/** The slice of `BrowserWindow` the controller needs — real windows satisfy it,
 *  and tests pass a fake. */
export interface DetachedWindow {
  readonly webContents: {
    send(channel: string, ...args: unknown[]): void;
    once(event: "did-finish-load", cb: () => void): void;
  };
  isDestroyed(): boolean;
  isMinimized?(): boolean;
  restore?(): void;
  show(): void;
  focus(): void;
  close(): void;
  loadURL(url: string): void;
  on(event: "closed", cb: () => void): void;
}

/** The window options the controller builds (subset of Electron's). */
export interface DetachedWindowOptions {
  width: number;
  height: number;
  title: string;
  backgroundColor: string;
  webPreferences: {
    preload: string;
    contextIsolation: boolean;
    nodeIntegration: boolean;
    sandbox: boolean;
  };
}

export interface DetachedCanvasDeps {
  createWindow(options: DetachedWindowOptions): DetachedWindow;
  /** The boot URL for a context: dev-server URL or a packaged file URL, both
   *  carrying `?window=detached&target=…`. */
  resolveLoadUrl(ctx: DetachedCanvasContext): string;
  /** Notify the main window that the detached window closed. */
  onClosed(): void;
  /** Absolute path to the shared preload bundle. */
  preload: string;
  /** Optional: pull an existing (possibly off-screen) window back onto a live
   *  display before focusing it. */
  ensureVisible?(win: DetachedWindow): void;
}

export const DETACHED_TARGETS: readonly DetachedCanvasTarget[] = ["graph", "moodboard"];

/** Validate an untrusted context payload. Throws on a malformed target/id. */
export function validateDetachedContext(ctx: unknown): DetachedCanvasContext {
  if (!ctx || typeof ctx !== "object") throw new Error("Detached canvas: context must be an object");
  const c = ctx as Record<string, unknown>;
  if (typeof c.productionId !== "string" || c.productionId.length === 0) {
    throw new Error("Detached canvas: productionId is required");
  }
  if (c.target !== "graph" && c.target !== "moodboard") {
    throw new Error(`Detached canvas: target must be "graph" or "moodboard" (got ${String(c.target)})`);
  }
  const frameId = c.frameId === undefined || c.frameId === null ? null : c.frameId;
  if (frameId !== null && typeof frameId !== "string") {
    throw new Error("Detached canvas: frameId must be a string or null");
  }
  return { productionId: c.productionId, target: c.target, frameId };
}

/** Owns the single detached window + the current context. */
export class DetachedCanvasController {
  private win: DetachedWindow | null = null;
  private ctx: DetachedCanvasContext | null = null;

  constructor(private readonly deps: DetachedCanvasDeps) {}

  /** Open the detached window, or focus + retarget the existing one. */
  open(ctx: DetachedCanvasContext): DetachedCanvasState {
    const next = validateDetachedContext(ctx);
    const existing = this.win;
    if (existing && !existing.isDestroyed()) {
      // A monitor may have been unplugged since the window was placed.
      this.deps.ensureVisible?.(existing);
      if (existing.isMinimized?.()) existing.restore?.();
      existing.show();
      existing.focus();
      this.ctx = next;
      existing.webContents.send("canvas:context", next);
      return this.state();
    }

    const win = this.deps.createWindow({
      width: 1280,
      height: 860,
      title: "Canvas",
      backgroundColor: "#111417",
      webPreferences: {
        preload: this.deps.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.win = win;
    this.ctx = next;
    win.on("closed", () => {
      if (this.win === win) {
        this.win = null;
        this.ctx = null;
      }
      this.deps.onClosed();
    });
    win.loadURL(this.deps.resolveLoadUrl(next));
    // The window boots with only `target` in the query; push the full context
    // (production + frame) once the renderer is ready — and again on every
    // reload, since `did-finish-load` fires each time.
    win.webContents.once("did-finish-load", () => {
      if (this.win === win && this.ctx) win.webContents.send("canvas:context", this.ctx);
    });
    return this.state();
  }

  /** Close the detached window (no-op when none is open). */
  close(): DetachedCanvasState {
    const win = this.win;
    if (win && !win.isDestroyed()) win.close();
    // Clear defensively for fakes that don't emit `closed`; the real `closed`
    // handler clears too and calls onClosed().
    if (this.win === win) {
      this.win = null;
      this.ctx = null;
    }
    return this.state();
  }

  /** Forward the main window's frame selection — only when a window is open. */
  selectionChanged(frameId: string | null): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (this.ctx) this.ctx = { ...this.ctx, frameId };
    win.webContents.send("canvas:selectionChanged", { frameId });
  }

  isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed();
  }

  state(): DetachedCanvasState {
    const win = this.win;
    if (!win || win.isDestroyed()) {
      return { open: false, productionId: null, target: null, frameId: null };
    }
    return {
      open: true,
      productionId: this.ctx?.productionId ?? null,
      target: this.ctx?.target ?? null,
      frameId: this.ctx?.frameId ?? null,
    };
  }
}
