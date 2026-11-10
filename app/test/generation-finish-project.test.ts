/**
 * Finished generations must not reopen their project of origin.
 *
 * Bug (Nov 2, 2026): queue a generation in project A, switch to project B
 * while it runs, and when it finishes the workspace jumps back to A.
 *
 * Root cause: generation IPC calls resolve with a whole-Production snapshot
 * of A, and the renderer applied it unconditionally. `applySnapshot` only
 * checked the per-production `rev` (each production file carries its own
 * monotonic rev, so a foreign snapshot's rev routinely passes `isFresh`),
 * and several generation handlers bypassed `applySnapshot` entirely with a
 * direct `setProd(next)`.
 *
 * Fix: `applySnapshot` rejects any snapshot whose production id is not the
 * currently open production (`isForCurrentProduction`), and every
 * generation-finish handler routes through `applySnapshot`.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { isForCurrentProduction } from "../src/shared/snapshot-freshness.js";

const workspaceSrc = fs.readFileSync(
  path.resolve(__dirname, "../src/renderer/src/components/ProductionWorkspace.tsx"),
  "utf8",
);

/** The function body starting at `marker`, up to the next top-level async function. */
function functionBlock(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `function marker ${marker}`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\n  async function ", start + marker.length);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("isForCurrentProduction", () => {
  it("accepts a snapshot of the currently open production", () => {
    expect(isForCurrentProduction("prod-a", "prod-a")).toBe(true);
  });

  it("rejects a finished generation's snapshot from another production (the regression)", () => {
    expect(isForCurrentProduction("prod-a", "prod-b")).toBe(false);
  });

  it("rejects a snapshot when no production is open (closed while generating)", () => {
    expect(isForCurrentProduction("prod-a", null)).toBe(false);
    expect(isForCurrentProduction("prod-a", undefined)).toBe(false);
    expect(isForCurrentProduction("prod-a", "")).toBe(false);
  });
});

describe("applySnapshot guards the open production", () => {
  it("checks production identity before applying", () => {
    const start = workspaceSrc.indexOf("const applySnapshot");
    expect(start, "applySnapshot marker").toBeGreaterThanOrEqual(0);
    const end = workspaceSrc.indexOf("const adoptSavedRev", start);
    const block = workspaceSrc.slice(start, end === -1 ? undefined : end);
    const guardAt = block.indexOf("isForCurrentProduction(next.meta.id, prodRef.current?.meta.id)");
    expect(guardAt, "identity guard in applySnapshot").toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(block.indexOf("setProd(next)"));
  });
});

describe("generation-finish handlers go through applySnapshot", () => {
  const handlers = [
    "async function genBoards",
    "async function runRegenBatch",
    "async function runTweenBlock",
    "async function runImageGenNode",
    "async function runVideoGenNode",
    "async function upgradeDraftVideo",
    "async function runEditVideoNode",
    "async function runEditGenNode",
    "async function runBoardEdit",
    "async function runVideoGen",
  ];
  for (const fn of handlers) {
    it(`${fn} applies its finished snapshot with the identity guard`, () => {
      const block = functionBlock(workspaceSrc, fn);
      expect(block).toContain("applySnapshot(next)");
      expect(block).not.toContain("setProd(next)");
    });
  }
});
