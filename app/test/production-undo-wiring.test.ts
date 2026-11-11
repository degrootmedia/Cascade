/**
 * App-wide undo — wiring guards (Items 1-3).
 *
 * The behavioral proof lives in production-history.test.ts (pure core
 * invariants) and production-undo-restore.test.ts (real save funnel +
 * folders). These source scans pin the architectural decisions a future
 * edit could silently break: history is built ONCE at the document
 * layer in main, no per-view undo stack returns, the workspace owns the
 * global shortcuts with the text-field guard, and every persisted
 * production write still funnels through `saveProduction`.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, rel), "utf8");

const workspace = read("../src/renderer/src/components/ProductionWorkspace.tsx");
const modal = read("../src/renderer/src/components/NodeGraphModal.tsx");
const timeline = read("../src/renderer/src/components/production/timeline-editor.tsx");
const main = read("../src/main/index.ts");
const productions = read("../src/main/productions.ts");

/** Source with block comments stripped — the retired local stacks are
 *  preserved in comment blocks during the migration and must not count
 *  as live code. */
const liveCode = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "");

describe("one document-layer history (no per-view stacks)", () => {
  it("the node graph and timeline keep no snapshot stack of their own", () => {
    expect(liveCode(modal)).not.toContain("createUndoHistory");
    expect(liveCode(timeline)).not.toContain("createUndoHistory");
    expect(modal).not.toContain('from "./production/undo-history.js"');
    expect(timeline).not.toContain("./undo-history.js");
    expect(modal).toContain("pendingForceRef");
  });

  it("both views delegate undo/redo to the workspace document history", () => {
    expect(modal).toContain("onDocUndo?.()");
    expect(modal).toContain("onDocRedo?.()");
    expect(timeline).toContain("onDocUndo?.()");
    expect(timeline).toContain("onDocRedo?.()");
  });

  it("main installs the history hook and registers undo/redo/state/deleteScene", () => {
    expect(main).toContain("installProductionHistory(");
    for (const ch of ["production:undo", "production:redo", "production:historyState", "production:deleteScene"]) {
      expect(main, ch).toContain(`handle("${ch}"`);
    }
    expect(main).toContain('on("production:historyChanged"');
  });

  it("every productions-store write still funnels through saveProduction (plus the migration write)", () => {
    // store.save( = the JSON store write. Exactly two call sites are
    // allowed: saveProduction (hooked) and loadProduction's one-time
    // schema-migration persist (history resets via onLoaded).
    const saves = productions.match(/store\.save\(/g) ?? [];
    expect(saves).toHaveLength(2);
    expect(productions).toContain("historyHook.onSaved(p, meta)");
  });
});

describe("workspace shortcuts and commit boundaries (Items 1-2)", () => {
  it("global Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y drive document undo, guarded for text fields", () => {
    const at = workspace.indexOf("Global shortcuts: Ctrl+Z");
    expect(at).toBeGreaterThanOrEqual(0);
    const block = workspace.slice(at, at + 1600);
    expect(block).toContain("isEditingTarget(e.target)");
    expect(block).toContain('key === "z" && !e.shiftKey');
    expect(block).toContain('key === "y"');
    expect(block).toContain("doDocUndoRef.current()");
    expect(block).toContain("doDocRedoRef.current()");
  });

  it("prompt typing coalesces under the shot key and closes on blur", () => {
    expect(workspace).toContain("coalesceKey: `prompt:${shotId}`");
    expect(workspace).toContain("coalesceEnd: true");
    expect(workspace).toContain("onBlur={() => endPromptGesture(promptShotId)}");
    // A bare focus/blur must not write: the gesture-end is guarded by
    // the open-gesture set.
    expect(workspace).toContain("promptGestureOpenRef.current.has(shotId)");
  });

  it("header exposes Undo/Redo buttons bound to history availability", () => {
    expect(workspace).toContain("disabled={!histState.canUndo}");
    expect(workspace).toContain("disabled={!histState.canRedo}");
    expect(workspace).toContain('title="Undo (Ctrl+Z)"');
  });
});
