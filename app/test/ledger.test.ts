/**
 * Expenses ledger tests — the module's pure core (price-rule matching) plus
 * the record → view → CSV lifecycle. Electron is mocked (userData dir + shell)
 * so the module loads in a plain node process; the temp dir is replaced fresh
 * before every test.
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
  buildPriceTemplate,
  getPriceRules,
  matchPriceRule,
  parsePriceRulesCsv,
  priceRulesToCsv,
  recordGeneration,
  removeEntry,
  setLedgerUserDataDir,
  setPriceRules,
  view,
} from "../src/main/ledger.js";
import type { ExpensePriceRule, LedgerGenMeta } from "../src/shared/ipc.js";

const img = (over: Partial<LedgerGenMeta> = {}): LedgerGenMeta => ({ kind: "image", model: "flux-pro", resolution: "1k", at: 1000, ...over });
const vid = (over: Partial<LedgerGenMeta> = {}): LedgerGenMeta => ({ kind: "video", model: "veo", resolution: "1080p", durationSec: 5, at: 2000, ...over });

beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  setLedgerUserDataDir(dataDir);
});

describe("matchPriceRule", () => {
  it("prefers exact matches over wildcards", () => {
    const rules: ExpensePriceRule[] = [
      { id: "r1", kind: "image", model: "*", resolution: "*", durationSec: null, price: 0.1 },
      { id: "r2", kind: "image", model: "flux-pro", resolution: "*", durationSec: null, price: 0.2 },
      { id: "r3", kind: "image", model: "flux-pro", resolution: "1k", durationSec: null, price: 0.3 },
    ];
    expect(matchPriceRule(rules, img())).toBe(0.3);
  });

  it("falls back to a partial match, then to zero", () => {
    const rules: ExpensePriceRule[] = [{ id: "r1", kind: "video", model: "*", resolution: "1080p", durationSec: null, price: 0.4 }];
    expect(matchPriceRule(rules, vid())).toBe(0.4);
    expect(matchPriceRule(rules, vid({ resolution: "720p" }))).toBe(0);
    expect(matchPriceRule([], vid())).toBe(0);
  });

  it("matches video length only when the rule pins it", () => {
    const rules: ExpensePriceRule[] = [
      { id: "r1", kind: "video", model: "*", resolution: "*", durationSec: 5, price: 0.5 },
      { id: "r2", kind: "video", model: "*", resolution: "*", durationSec: 10, price: 0.9 },
    ];
    expect(matchPriceRule(rules, vid())).toBe(0.5);
    expect(matchPriceRule(rules, vid({ durationSec: 10 }))).toBe(0.9);
    expect(matchPriceRule(rules, vid({ durationSec: 7 }))).toBe(0);
  });

  it("never crosses kinds and ignores duration on image rules", () => {
    const rules: ExpensePriceRule[] = [
      { id: "r1", kind: "image", model: "*", resolution: "2k", durationSec: 9, price: 0.2 },
      { id: "r2", kind: "video", model: "*", resolution: "*", durationSec: null, price: 0.7 },
    ];
    expect(matchPriceRule(rules, img({ resolution: "2k" }))).toBe(0.2);
    expect(matchPriceRule(rules, img({ resolution: "1k" }))).toBe(0);
  });
});

describe("ledger records", () => {
  it("records generations, stamps the matched price, and tallies the view", () => {
    setPriceRules([
      { id: "r1", kind: "image", model: "flux-pro", resolution: "1k", durationSec: null, price: 0.3 },
      { id: "r2", kind: "video", model: "veo", resolution: "1080p", durationSec: 5, price: 0.5 },
    ]);
    recordGeneration(img());
    recordGeneration(vid());

    const v = view();
    expect(v.entries).toHaveLength(2);
    expect(v.imageCount).toBe(1);
    expect(v.videoCount).toBe(1);
    expect(v.total).toBeCloseTo(0.8);
    // Newest first.
    const [video, image] = v.entries;
    expect(video).toMatchObject({ kind: "video", price: 0.5, durationSec: 5, model: "veo", resolution: "1080p" });
    expect(image).toMatchObject({ kind: "image", price: 0.3, aspectRatio: undefined });
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

  it("writes the CSV text mirror, quoted and chronological", () => {
    setPriceRules([{ id: "r1", kind: "video", model: "veo", resolution: "1080p", durationSec: 5, price: 0.5 }]);
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

  it("normalizes price rules (trims, clamps non-negative, videos keep length)", () => {
    setPriceRules([
      { id: "r1", kind: "video", model: "  veo  ", resolution: "1080p", durationSec: 5, price: -2 },
      { id: "r2", kind: "image", model: "flux-pro", resolution: "", durationSec: 4, price: 0.5 },
    ]);
    const rules = getPriceRules();
    expect(rules[0]).toMatchObject({ model: "veo", durationSec: 5, price: 0 });
    expect(rules[1]).toMatchObject({ model: "flux-pro", durationSec: null, price: 0.5 });
  });
});

describe("price rule CSV export/import", () => {
  it("round-trips rules through CSV, quoting model names with commas", () => {
    const rules: ExpensePriceRule[] = [
      { id: "r1", kind: "image", model: "flux,pro", resolution: "1k", durationSec: null, price: 0.3 },
      { id: "r2", kind: "video", model: "veo", resolution: "1080p", durationSec: 5, price: 0.5 },
      { id: "r3", kind: "video", model: "kling", resolution: "", durationSec: null, price: 1.0 },
    ];
    const csv = priceRulesToCsv(rules);
    expect(csv.split("\r\n")[0]).toBe("kind,model,resolution,duration_sec,price");
    expect(csv).toContain('"flux,pro"');

    const parsed = parsePriceRulesCsv(csv);
    expect(parsed).toHaveLength(3);
    // ids are freshly assigned, never carried across the file.
    expect(parsed[0].id).not.toBe("r1");
    expect(parsed[0]).toMatchObject({ kind: "image", model: "flux,pro", resolution: "1k", durationSec: null, price: 0.3 });
    expect(parsed[1]).toMatchObject({ kind: "video", model: "veo", resolution: "1080p", durationSec: 5, price: 0.5 });
    expect(parsed[2]).toMatchObject({ kind: "video", model: "kling", resolution: "", durationSec: null, price: 1.0 });
  });

  it("skips the header, blank lines, and malformed rows", () => {
    const csv = [
      "kind,model,resolution,duration_sec,price",
      "",
      "image,flux,1k,,0.25",
      "video,veo,1080p,5,0.50",
      "garbage line",
      "video,veo,1080p,5", // too few cells
      "bogus-kind,x,1k,,0.1",
    ].join("\r\n");
    const parsed = parsePriceRulesCsv(csv);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ kind: "image", model: "flux", price: 0.25 });
    expect(parsed[1]).toMatchObject({ kind: "video", model: "veo", durationSec: 5, price: 0.5 });
  });
});

describe("buildPriceTemplate", () => {
  it("emits every image model × resolution and video model × resolution × duration combo at $0", () => {
    const rules = buildPriceTemplate(
      [{ id: "img-a" }, { id: "img-b" }],
      [{ id: "vid-a" }],
      (id) => (id === "vid-a" ? { resolutions: ["720p", "1080p"], durations: [5, 10] } : null)
    );
    expect(rules).toHaveLength(2 * 3 + 2 * 2);
    const imageRules = rules.filter((r) => r.kind === "image");
    const videoRules = rules.filter((r) => r.kind === "video");
    expect(imageRules).toHaveLength(6);
    expect(videoRules).toHaveLength(4);
    expect(imageRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "image", model: "img-a", resolution: "1k", price: 0 }),
      expect.objectContaining({ kind: "image", model: "img-b", resolution: "4k", price: 0 }),
    ]));
    expect(videoRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "video", model: "vid-a", resolution: "720p", durationSec: 5, price: 0 }),
      expect.objectContaining({ kind: "video", model: "vid-a", resolution: "1080p", durationSec: 10, price: 0 }),
    ]));
    // Rules carry unique ids (importable directly).
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
  });

  it("falls back to the default resolution/length buckets when a video form can't be read", () => {
    const rules = buildPriceTemplate([], [{ id: "vid-a" }], () => null);
    expect(rules).toHaveLength(3 * 4);
    expect(rules[0]).toMatchObject({ kind: "video", model: "vid-a", resolution: "480p", durationSec: 5 });
    expect(rules[rules.length - 1]).toMatchObject({ resolution: "1080p", durationSec: 20 });
  });
});