/**
 * Stale-state guards for the pending-generation recheck + node Refresh flows.
 *
 * The IPC handlers live inside the Electron main entry (no unit harness can
 * invoke them), so these tests pin the ordering/notification invariants the
 * fixes rely on, in the same spirit as provider-seam.test.ts:
 *
 * 1. A successful recheck downloads and records the frame, THEN clears the
 *    pending record, THEN bills — billing is best-effort (wrapped), so a
 *    ledger failure can never strand the shot's "pending/generating" tag
 *    after the image already landed.
 * 2. A manual node Refresh (production:refreshMedia) that re-encodes the
 *    JPEG notifies renderers via board:externalUpdate — the same signal the
 *    automatic external-edit sweep sends — so the storyboard busts its
 *    thumbnail immediately instead of waiting for the next focus sweep.
 * 3. The renderer's recheck/clear-pending completions apply through
 *    applySnapshot (which advances the tracked snapshot revision), so a late
 *    intermediate snapshot cannot resurrect the cleared pending record.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const mainSrc = fs.readFileSync(path.resolve(__dirname, "../src/main/index.ts"), "utf8");
const workspaceSrc = fs.readFileSync(
  path.resolve(__dirname, "../src/renderer/src/components/ProductionWorkspace.tsx"),
  "utf8",
);

/** The handler block starting at `marker`, up to the next `handle("` after it. */
function handlerBlock(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `handler marker ${marker}`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf('\n  handle("', start + marker.length);
  return src.slice(start, next === -1 ? undefined : next);
}

/** The function body starting at `marker`, up to the next top-level function. */
function functionBlock(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `function marker ${marker}`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\n  async function ", start + marker.length);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("recheck clears pending before best-effort billing", () => {
  const cases: Array<{ channel: string; completion: string; clear: string }> = [
    { channel: 'handle("production:recheckBoard"', completion: "completePendingImageGeneration", clear: "delete shot.pendingImageGen;" },
    { channel: 'handle("production:recheckVideo"', completion: "completeVideoGeneration", clear: "delete shot.pendingVideoGen;" },
    { channel: 'handle("production:recheckStyleFrame"', completion: 'style.frameSource = "generated";', clear: "delete style.pendingImageGen;" },
  ];

  for (const { channel, completion, clear } of cases) {
    it(`${channel} clears the pending record after recording, before billing`, () => {
      const block = handlerBlock(mainSrc, channel);
      const ledgerAt = block.indexOf("ledger.recordGeneration");
      expect(ledgerAt, "reclaim billing call").toBeGreaterThanOrEqual(0);
      const completionAt = block.lastIndexOf(completion, ledgerAt);
      expect(completionAt, "completion before billing").toBeGreaterThanOrEqual(0);
      // The success-path clear sits between recording the result and billing
      // it (the dead-job catch also clears, but that one precedes completion).
      const clearAt = block.lastIndexOf(clear, ledgerAt);
      expect(clearAt, "pending cleared before billing").toBeGreaterThan(completionAt);
      // Billing cannot throw past the clear: a try opens before the ledger
      // call and its catch closes after it.
      expect(block.indexOf("try {", clearAt), "billing try after clear").toBeGreaterThanOrEqual(0);
      expect(block.indexOf("try {", clearAt)).toBeLessThan(ledgerAt);
      expect(block.indexOf("catch", ledgerAt), "billing catch after ledger").toBeGreaterThan(ledgerAt);
    });
  }
});

describe("node Refresh notifies the storyboard", () => {
  it("production:refreshMedia broadcasts board:externalUpdate when it re-encodes", () => {
    const block = handlerBlock(mainSrc, 'handle("production:refreshMedia"');
    expect(block).toContain("regenerateBoardJpeg");
    expect(block).toContain('"board:externalUpdate"');
  });
});

describe("renderer recheck completions go through applySnapshot", () => {
  for (const fn of ["async function recheckBoard", "async function recheckVideo", "async function clearPending"]) {
    it(`${fn} applies its snapshot with the freshness guard`, () => {
      const block = functionBlock(workspaceSrc, fn);
      expect(block).toContain("applySnapshot(next)");
      expect(block).not.toContain("setProd(next)");
    });
  }
});
