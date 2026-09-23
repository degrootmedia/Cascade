/**
 * Detached canvas window (Spec 03).
 *
 * The controller's Electron seam is injected (`createWindow`, `resolveLoadUrl`,
 * `onClosed`), so these tests exercise the singleton/retarget/security behavior
 * with a fake `BrowserWindow` — no Electron needed.
 */
import { describe, it, expect } from "vitest";
import {
  DetachedCanvasController,
  validateDetachedContext,
  type DetachedWindow,
  type DetachedWindowOptions,
} from "../src/main/detached-window.js";

class FakeWindow implements DetachedWindow {
  static created: FakeWindow[] = [];
  static reset() { FakeWindow.created = []; }

  sent: Array<{ channel: string; args: unknown[] }> = [];
  loadUrls: string[] = [];
  shown = 0;
  focused = 0;
  closed = false;
  private destroyed = false;
  private onceHandlers: Record<string, Array<() => void>> = {};
  private onHandlers: Record<string, Array<() => void>> = {};
  readonly options: DetachedWindowOptions;

  constructor(options: DetachedWindowOptions) {
    this.options = options;
    FakeWindow.created.push(this);
  }
  get webContents() {
    const self = this;
    return {
      send(channel: string, ...args: unknown[]) { self.sent.push({ channel, args }); },
      once(event: string, cb: () => void) { (self.onceHandlers[event] ??= []).push(cb); },
    };
  }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  restore() {}
  show() { this.shown++; }
  focus() { this.focused++; }
  close() { this.closed = true; this.destroyed = true; }
  loadURL(url: string) { this.loadUrls.push(url); }
  on(event: string, cb: () => void) { (this.onHandlers[event] ??= []).push(cb); }
  /** Fire a queued once-handler (did-finish-load). */
  fireOnce(event: string) { for (const cb of this.onceHandlers[event] ?? []) cb(); }
  /** Simulate the OS window closing. */
  emitClosed() { this.destroyed = true; for (const cb of this.onHandlers["closed"] ?? []) cb(); }
}

function controller(overrides: Partial<{ onClosed: () => void; url: string }> = {}) {
  const onClosed = overrides.onClosed ?? (() => {});
  const c = new DetachedCanvasController({
    preload: "/preload/index.js",
    createWindow: (opts) => new FakeWindow(opts),
    resolveLoadUrl: () => overrides.url ?? "http://localhost/?window=detached&target=graph",
    onClosed,
  });
  return c;
}

const graphCtx = (productionId = "p1", frameId: string | null = "s1") => ({ productionId, target: "graph" as const, frameId });

describe("validateDetachedContext", () => {
  it("rejects a malformed target", () => {
    expect(() => validateDetachedContext({ productionId: "p1", target: "wat" })).toThrow(/target/);
    expect(() => validateDetachedContext(null)).toThrow();
    expect(() => validateDetachedContext({ target: "graph" })).toThrow(/productionId/);
  });
  it("normalizes a missing frameId to null", () => {
    expect(validateDetachedContext({ productionId: "p1", target: "moodboard" })).toEqual({
      productionId: "p1",
      target: "moodboard",
      frameId: null,
    });
  });
});

describe("DetachedCanvasController", () => {
  it("opens one window, and a second open focuses + retargets instead of duplicating", () => {
    FakeWindow.reset();
    const c = controller();
    c.open(graphCtx("p1", "s1"));
    expect(FakeWindow.created).toHaveLength(1);

    const first = FakeWindow.created[0];
    expect(first.loadUrls).toEqual(["http://localhost/?window=detached&target=graph"]);
    expect(c.state()).toEqual({ open: true, productionId: "p1", target: "graph", frameId: "s1" });

    c.open(graphCtx("p2", "s2"));
    expect(FakeWindow.created).toHaveLength(1); // still one window
    expect(first.focused).toBe(1);
    expect(first.shown).toBe(1);
    // Retarget pushed to the same window.
    expect(first.sent.at(-1)).toEqual({ channel: "canvas:context", args: [graphCtx("p2", "s2")] });
    expect(c.state()).toEqual({ open: true, productionId: "p2", target: "graph", frameId: "s2" });
  });

  it("never loosens webPreferences (contextIsolation, no nodeIntegration, sandbox, shared preload)", () => {
    FakeWindow.reset();
    controller().open(graphCtx());
    const { options } = FakeWindow.created[0];
    expect(options.webPreferences).toEqual({
      preload: "/preload/index.js",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
  });

  it("re-sends the latest context on did-finish-load (reload-safe)", () => {
    FakeWindow.reset();
    const c = controller();
    c.open(graphCtx("p1", "s1"));
    const w = FakeWindow.created[0];
    c.selectionChanged("s9"); // update current context before the page is ready
    w.fireOnce("did-finish-load");
    expect(w.sent.at(-1)).toEqual({ channel: "canvas:context", args: [graphCtx("p1", "s9")] });
  });

  it("forwards frame selection only while a window is open", () => {
    FakeWindow.reset();
    const c = controller();
    c.selectionChanged("s1"); // nothing open → no-op
    c.open(graphCtx("p1", "s1"));
    const w = FakeWindow.created[0];
    c.selectionChanged("s2");
    expect(w.sent.at(-1)).toEqual({ channel: "canvas:selectionChanged", args: [{ frameId: "s2" }] });
    expect(c.state().frameId).toBe("s2");
  });

  it("clears state and notifies when the OS window closes", () => {
    FakeWindow.reset();
    let closed = 0;
    const c = controller({ onClosed: () => { closed++; } });
    c.open(graphCtx());
    FakeWindow.created[0].emitClosed();
    expect(closed).toBe(1);
    expect(c.state()).toEqual({ open: false, productionId: null, target: null, frameId: null });
    expect(c.isOpen()).toBe(false);
  });

  it("close() clears state; a later open creates a fresh window", () => {
    FakeWindow.reset();
    const c = controller();
    c.open(graphCtx());
    c.close();
    expect(c.state().open).toBe(false);
    c.open(graphCtx("p3", null));
    expect(FakeWindow.created).toHaveLength(2);
    expect(c.state().productionId).toBe("p3");
  });

  it("rejects a malformed target before creating a window", () => {
    FakeWindow.reset();
    const c = controller();
    expect(() => c.open({ productionId: "p1", target: "nope" } as never)).toThrow(/target/);
    expect(FakeWindow.created).toHaveLength(0);
  });
});
