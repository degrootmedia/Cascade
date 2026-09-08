/**
 * Expenses ledger tests — the module's pure core (range interpolation) plus
 * the record → view → CSV lifecycle and re-price-on-rule-change. Electron is
 * mocked (userData dir + shell) so the module loads in a plain node process;
 * the temp dir is replaced fresh before every test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-ledger-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({
  app: { getPath: () => dataDir },
  shell: { openPath: async () => "" },
}));

import {
  addManualEntry,
  applyModelOptions,
  getPriceRules,
  matchPriceRule,
  parsePriceRulesCsv,
  priceRulesToCsv,
  recordGeneration,
  removeEntry,
  repriceAll,
  setLedgerUserDataDir,
  setPriceRules,
  view,
} from "../src/main/ledger.js";
import type { ExpensePriceRule, LedgerGenMeta } from "../src/shared/ipc.js";

const img = (over: Partial<LedgerGenMeta> = {}): LedgerGenMeta => ({ kind: "image", model: "flux-pro", resolution: "1k", at: 1000, ...over });
const vid = (over: Partial<LedgerGenMeta> = {}): LedgerGenMeta => ({ kind: "video", model: "veo", resolution: "1080p", durationSec: 5, at: 2000, ...over });

/** A valid range rule with image defaults; override for video cases. */
const rangeRule = (over: Partial<ExpensePriceRule> = {}): ExpensePriceRule => ({
  id: "r",
  kind: "image",
  model: "*",
  minPrice: 0,
  maxPrice: 0,
  resolutions: ["1k", "2k", "4k"],
  durMin: null,
  durMax: null,
  ...over,
});

beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  setLedgerUserDataDir(dataDir);
});

describe("matchPriceRule", () => {
  it("prefers exact matches over the wildcard", () => {
    const rules: ExpensePriceRule[] = [
      rangeRule({ id: "r1", model: "*", minPrice: 0.1, maxPrice: 0.1 }),
      rangeRule({ id: "r2", model: "flux-pro", minPrice: 0.2, maxPrice: 0.2 }),
    ];
    expect(matchPriceRule(rules, img())).toBe(0.2);
  });

  it("falls back to the wildcard, then to zero", () => {
    const rules: ExpensePriceRule[] = [rangeRule({ id: "r1", kind: "video", model: "*", minPrice: 0.4, maxPrice: 0.4 })];
    expect(matchPriceRule(rules, vid())).toBe(0.4);
    expect(matchPriceRule([], vid())).toBe(0);
  });

  it("interpolates between min and max by resolution", () => {
    const rules: ExpensePriceRule[] = [rangeRule({ id: "r1", model: "flux-pro", minPrice: 1, maxPrice: 10 })];
    expect(matchPriceRule(rules, img())).toBeCloseTo(1); // 1k = cheapest
    expect(matchPriceRule(rules, img({ resolution: "2k" }))).toBeCloseTo(5.5);
    expect(matchPriceRule(rules, img({ resolution: "4k" }))).toBeCloseTo(10);
  });

  it("interpolates video by resolution and length (product of both scales)", () => {
    const rules: ExpensePriceRule[] = [
      rangeRule({ id: "r1", kind: "video", model: "veo", minPrice: 1, maxPrice: 10, resolutions: ["720p", "1080p"], durMin: 5, durMax: 15 }),
    ];
    // Cheapest config.
    expect(matchPriceRule(rules, vid({ resolution: "720p", durationSec: 5 }))).toBeCloseTo(1);
    // Most expensive config.
    expect(matchPriceRule(rules, vid({ resolution: "1080p", durationSec: 15 }))).toBeCloseTo(10);
    // High-res but short, and long but low-res, both price at the floor.
    expect(matchPriceRule(rules, vid({ resolution: "1080p", durationSec: 5 }))).toBeCloseTo(1);
    expect(matchPriceRule(rules, vid({ resolution: "720p", durationSec: 10 }))).toBeCloseTo(1);
    // Half-res, half-length → halfway.
    expect(matchPriceRule(rules, vid({ resolution: "1080p", durationSec: 10 }))).toBeCloseTo(5.5);
  });

  it("clamps video lengths outside the range", () => {
    const rules: ExpensePriceRule[] = [
      rangeRule({ id: "r1", kind: "video", model: "veo", minPrice: 1, maxPrice: 10, resolutions: ["720p", "1080p"], durMin: 5, durMax: 15 }),
    ];
    expect(matchPriceRule(rules, vid({ durationSec: 100 }))).toBeCloseTo(10);
    expect(matchPriceRule(rules, vid({ resolution: "1080p", durationSec: 0 }))).toBeCloseTo(1);
  });

  it("positions resolutions outside the ladder by global rank", () => {
    const rules: ExpensePriceRule[] = [
      rangeRule({ id: "r1", kind: "video", model: "veo", minPrice: 1, maxPrice: 10, resolutions: ["720p", "1080p"], durMin: 5, durMax: 15 }),
    ];
    // "4K" ranks above the ladder top → pinned to max.
    expect(matchPriceRule(rules, vid({ resolution: "4K", durationSec: 15 }))).toBeCloseTo(10);
    // Genuinely unknown label → midpoint.
    expect(matchPriceRule(rules, vid({ resolution: "weird", durationSec: 15 }))).toBeCloseTo(5.5);
  });

  it("prices sub-480p and 4K generations against a low→high ladder", () => {
    const rules: ExpensePriceRule[] = [
      rangeRule({ id: "r1", kind: "video", model: "veo", minPrice: 1, maxPrice: 10, resolutions: ["480p", "1080p"], durMin: 5, durMax: 15 }),
    ];
    // 240p sits below the ladder floor → cheapest config.
    expect(matchPriceRule(rules, vid({ resolution: "240p", durationSec: 15 }))).toBeCloseTo(1);
    // 4K sits above the ladder ceiling → most expensive config.
    expect(matchPriceRule(rules, vid({ resolution: "4k", durationSec: 15 }))).toBeCloseTo(10);
    // 720p interpolates between the two ladder members (2/3 up → 1 + 0.667×9).
    expect(matchPriceRule(rules, vid({ resolution: "720p", durationSec: 15 }))).toBeCloseTo(7);
  });

  it("flat ranges ignore the ladder", () => {
    const rules: ExpensePriceRule[] = [rangeRule({ id: "r1", model: "flux-pro", minPrice: 2, maxPrice: 2 })];
    expect(matchPriceRule(rules, img())).toBe(2);
    expect(matchPriceRule(rules, img({ resolution: "4k" }))).toBe(2);
  });

  it("never crosses kinds", () => {
    const rules: ExpensePriceRule[] = [
      rangeRule({ id: "r1", model: "*", minPrice: 0.2, maxPrice: 0.2 }),
      rangeRule({ id: "r2", kind: "video", model: "*", minPrice: 0.7, maxPrice: 0.7 }),
    ];
    expect(matchPriceRule(rules, img())).toBe(0.2);
    expect(matchPriceRule(rules, vid())).toBe(0.7);
  });
});

describe("ledger records", () => {
  it("records generations, stamps the interpolated price, and tallies the view", () => {
    setPriceRules([
      { id: "r1", kind: "image", model: "flux-pro", minPrice: 0.1, maxPrice: 0.3, resolutions: ["1k", "2k", "4k"], durMin: null, durMax: null },
      { id: "r2", kind: "video", model: "veo", minPrice: 0.3, maxPrice: 0.5, resolutions: ["1080p"], durMin: 5, durMax: 10 },
    ]);
    recordGeneration(img());
    recordGeneration(vid());

    const v = view();
    expect(v.entries).toHaveLength(2);
    expect(v.imageCount).toBe(1);
    expect(v.videoCount).toBe(1);
    expect(v.total).toBeCloseTo(0.4);
    // Newest first.
    const [video, image] = v.entries;
    expect(video).toMatchObject({ kind: "video", price: 0.3, durationSec: 5, model: "veo", resolution: "1080p" });
    expect(image).toMatchObject({ kind: "image", price: 0.1, aspectRatio: undefined });
  });

  it("prices at $0 when no rule matches", () => {
    recordGeneration(img());
    expect(view().entries[0].price).toBe(0);
  });

  it("persists across a memo-cache reset", () => {
    recordGeneration(img({ model: "persist-me" }));
    setLedgerUserDataDir(dataDir); // reloads from disk
    expect(view().entries[0].model).toBe("persist-me");
  });

  it("adds and removes manual rows with custom amounts", () => {
    const v = addManualEntry("Stock audio pack", 12.5);
    expect(v.entries[0]).toMatchObject({ kind: "manual", price: 12.5, label: "Stock audio pack" });
    expect(v.total).toBeCloseTo(12.5);

    const after = removeEntry(v.entries[0].id);
    expect(after.entries).toHaveLength(0);
    expect(after.total).toBe(0);
  });

  it("re-prices existing generations when rules change, leaving manual rows alone", () => {
    setPriceRules([rangeRule({ id: "r1", model: "flux-pro", minPrice: 0.3, maxPrice: 0.3 })]);
    recordGeneration(img());
    addManualEntry("Stock audio pack", 12.5);
    expect(view().entries.find((e) => e.kind === "image")!.price).toBe(0.3);

    setPriceRules([rangeRule({ id: "r1", model: "flux-pro", minPrice: 0.9, maxPrice: 0.9 })]);
    const v = view();
    expect(v.entries.find((e) => e.kind === "image")!.price).toBe(0.9);
    expect(v.entries.find((e) => e.kind === "manual")!.price).toBe(12.5);
  });

  it("repriceAll recomputes every generation from the current rules", () => {
    setPriceRules([rangeRule({ id: "r1", model: "flux-pro", minPrice: 0.1, maxPrice: 0.9 })]);
    recordGeneration(img({ resolution: "1k" })); // 0.1
    recordGeneration(img({ resolution: "4k" })); // 0.9
    // Corrupt one stamped price directly on disk, as if a legacy change never
    // re-priced it.
    const f = JSON.parse(fs.readFileSync(path.join(dataDir, "ledger.json"), "utf8"));
    f.entries[0].price = 0;
    fs.writeFileSync(path.join(dataDir, "ledger.json"), JSON.stringify(f), "utf8");

    const v = repriceAll();
    expect(v.entries.find((e) => e.resolution === "4k")!.price).toBeCloseTo(0.9);
    expect(v.total).toBeCloseTo(1.0);
  });

  it("writes the CSV text mirror, quoted and chronological", () => {
    setPriceRules([rangeRule({ id: "r1", kind: "video", model: "veo", minPrice: 0.5, maxPrice: 0.5 })]);
    recordGeneration(img({ model: "flux,pro" }));
    recordGeneration(vid());

    const csv = fs.readFileSync(path.join(dataDir, "expenses.csv"), "utf8");
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines[0]).toBe("date,kind,model,resolution,duration_sec,price,label");
    // Chronological order: the image (at=1000) precedes the video (at=2000).
    expect(lines[1]).toContain("image");
    expect(lines[1]).toContain('"flux,pro"');
    expect(lines[2]).toContain("video");
    expect(lines[2]).toContain("5");
    expect(lines[2]).toContain("0.50");
  });

  it("normalizes rules (trims models, clamps prices, images drop duration ranges)", () => {
    setPriceRules([
      { id: "r1", kind: "video", model: "  veo  ", minPrice: -2, maxPrice: 5, resolutions: ["720p", "1080p"], durMin: 5, durMax: 10 },
      { id: "r2", kind: "image", model: "flux-pro", minPrice: 0.5, maxPrice: 0.5, resolutions: [], durMin: 1, durMax: 2 },
    ]);
    const rules = getPriceRules();
    expect(rules[0]).toMatchObject({ model: "veo", minPrice: 0, maxPrice: 5, durMin: 5, durMax: 10 });
    expect(rules[1]).toMatchObject({ model: "flux-pro", minPrice: 0.5, maxPrice: 0.5, durMin: null, durMax: null });
    // Empty resolutions fall back to the kind's buckets.
    expect(rules[1].resolutions).toEqual(["1k", "2k", "4k"]);
  });

  it("migrates legacy discrete rules to one flat range per model", () => {
    setPriceRules([
      { id: "a", kind: "image", model: "flux-pro", resolution: "1k", durationSec: null, price: 0.2 },
      { id: "b", kind: "image", model: "flux-pro", resolution: "4k", durationSec: null, price: 0.8 },
      { id: "c", kind: "video", model: "veo", resolution: "720p", durationSec: 5, price: 1.0 },
    ] as unknown as ExpensePriceRule[]);
    const rules = getPriceRules();
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ kind: "image", model: "flux-pro", minPrice: 0.2, maxPrice: 0.8 });
    expect(rules[1]).toMatchObject({ kind: "video", model: "veo", minPrice: 1.0, maxPrice: 1.0 });
  });
});

describe("price rule CSV export/import", () => {
  it("round-trips range rules through CSV, quoting model names with commas", () => {
    const rules: ExpensePriceRule[] = [
      rangeRule({ id: "r1", model: "flux,pro", minPrice: 0.3, maxPrice: 0.8 }),
      rangeRule({ id: "r2", kind: "video", model: "veo", minPrice: 0.5, maxPrice: 2, resolutions: ["720p", "1080p"], durMin: 5, durMax: 20 }),
      rangeRule({ id: "r3", kind: "video", model: "kling", minPrice: 1.0, maxPrice: 1.0 }),
    ];
    const csv = priceRulesToCsv(rules);
    expect(csv.split("\r\n")[0]).toBe("kind,model,min_price,max_price");
    expect(csv).toContain('"flux,pro"');

    const parsed = parsePriceRulesCsv(csv);
    expect(parsed).toHaveLength(3);
    // ids are freshly assigned, never carried across the file.
    expect(parsed[0].id).not.toBe("r1");
    expect(parsed[0]).toMatchObject({ kind: "image", model: "flux,pro", minPrice: 0.3, maxPrice: 0.8 });
    expect(parsed[1]).toMatchObject({ kind: "video", model: "veo", minPrice: 0.5, maxPrice: 2 });
    expect(parsed[2]).toMatchObject({ kind: "video", model: "kling", minPrice: 1.0, maxPrice: 1.0 });
    // Ladders are not carried in the CSV — defaults apply (import re-derives).
    expect(parsed[0].resolutions).toEqual(["1k", "2k", "4k"]);
  });

  it("skips the header, blank lines, and malformed rows", () => {
    const csv = [
      "kind,model,min_price,max_price",
      "",
      "image,flux,0.25,0.50",
      "video,veo,1.00,2.00",
      "garbage line",
      "video,veo,1.00", // too few cells
      "bogus-kind,x,0.1,0.2",
    ].join("\r\n");
    const parsed = parsePriceRulesCsv(csv);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ kind: "image", model: "flux", minPrice: 0.25, maxPrice: 0.5 });
    expect(parsed[1]).toMatchObject({ kind: "video", model: "veo", minPrice: 1, maxPrice: 2 });
  });

  it("reads the legacy cartesian format as flat ranges", () => {
    const csv = [
      "kind,model,resolution,duration_sec,price",
      "image,flux,1k,,0.25",
      "video,veo,1080p,5,0.50",
    ].join("\r\n");
    const parsed = parsePriceRulesCsv(csv);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ kind: "image", model: "flux", minPrice: 0.25, maxPrice: 0.25 });
    expect(parsed[1]).toMatchObject({ kind: "video", model: "veo", minPrice: 0.5, maxPrice: 0.5 });
  });
});

describe("applyModelOptions", () => {
  it("bakes live video options into video rules, leaving images and unknown models alone", async () => {
    const rules: ExpensePriceRule[] = [
      rangeRule({ id: "r1", model: "flux-pro", minPrice: 0.1, maxPrice: 0.2 }),
      rangeRule({ id: "r2", kind: "video", model: "veo", minPrice: 0.5, maxPrice: 2 }),
      rangeRule({ id: "r3", kind: "video", model: "kling", minPrice: 1, maxPrice: 1 }),
    ];
    const out = await applyModelOptions(rules, async (id) =>
      id === "veo" ? { resolutions: ["720p", "1080p"], durations: [5, 10, 15] } : null
    );
    expect(out[0]).toBe(rules[0]); // images untouched
    expect(out[1]).toMatchObject({ resolutions: ["720p", "1080p"], durMin: 5, durMax: 15 });
    expect(out[2]).toBe(rules[2]); // unknown model keeps its defaults
  });
});