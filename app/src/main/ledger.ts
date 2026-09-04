/**
 * Expenses ledger — the running tally of every AI generation made in-app.
 *
 * Owns the whole expense concept: the durable ledger (entries + pricing rules
 * in userData/ledger.json), the human-readable CSV mirror
 * (userData/expenses.csv) rewritten on every mutation, and the pure price-rule
 * matcher that turns a generation's metadata into a dollar amount.
 *
 * The OpenArt seam (OpenArtClient's onGeneration callback) feeds successful
 * generations in; the renderer edits pricing rules from Settings and adds
 * manual "purchased asset" rows from the Expenses page.
 *
 * Persistence follows the settings singleton (single userData file, memo
 * cache) with the store's atomic temp+rename writes. Electron is a soft
 * dependency so the module loads in a plain node test process; tests point the
 * ledger at a temp dir via setLedgerUserDataDir().
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExpensePriceRule, LedgerEntry, LedgerGenMeta, LedgerView } from "../shared/ipc.js";

let userDataDir: string | null = null;
let shell: typeof import("electron").shell | undefined;
void import("electron")
  .then((m) => {
    userDataDir = m.app.getPath("userData");
    shell = m.shell;
  })
  .catch(() => {});

/** Point the ledger at a different userData dir (tests). Must be called before
 *  the first read/write. */
export function setLedgerUserDataDir(dir: string): void {
  userDataDir = dir;
  cache = null;
}

interface LedgerFile {
  entries: LedgerEntry[];
  priceRules: ExpensePriceRule[];
  updatedAt: string;
}

const DEFAULTS: LedgerFile = { entries: [], priceRules: [], updatedAt: "" };

let cache: LedgerFile | null = null;

function ledgerDir(): string {
  if (!userDataDir) throw new Error("Ledger userData dir not available (is this running inside Electron?)");
  return userDataDir;
}

function ledgerJsonPath(): string {
  return path.join(ledgerDir(), "ledger.json");
}

function ledgerCsvPath(): string {
  return path.join(ledgerDir(), "expenses.csv");
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Match the most specific pricing rule for a generation: exact fields beat
 *  "*" wildcards, and the first rule with the highest score wins. Generations
 *  matching no rule are priced at $0. Pure — unit-tested. */
export function matchPriceRule(rules: ExpensePriceRule[], meta: LedgerGenMeta): number {
  let best: ExpensePriceRule | null = null;
  let bestScore = -1;
  for (const r of rules) {
    if (!r || r.kind !== meta.kind) continue;
    let score = 0;
    if (r.model && r.model !== "*") {
      if (r.model !== meta.model) continue;
      score += 4;
    }
    if (r.resolution && r.resolution !== "*") {
      if (r.resolution !== meta.resolution) continue;
      score += 2;
    }
    if (r.kind === "video" && r.durationSec != null) {
      if (r.durationSec !== meta.durationSec) continue;
      score += 1;
    }
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best?.price ?? 0;
}

function normalizeEntry(e: LedgerEntry): LedgerEntry | null {
  if (!e || typeof e !== "object" || typeof e.id !== "string") return null;
  const kind = e.kind === "video" ? "video" : e.kind === "manual" ? "manual" : "image";
  return {
    id: e.id,
    kind,
    model: String(e.model ?? ""),
    resolution: String(e.resolution ?? ""),
    durationSec: kind === "video" && e.durationSec != null ? Math.max(0, e.durationSec) : undefined,
    aspectRatio: typeof e.aspectRatio === "string" ? e.aspectRatio : undefined,
    price: Number.isFinite(e.price) ? Math.max(0, e.price) : 0,
    at: Number.isFinite(e.at) ? e.at : 0,
    label: typeof e.label === "string" ? e.label : undefined,
    productionId: typeof e.productionId === "string" ? e.productionId : undefined,
    shotId: typeof e.shotId === "string" ? e.shotId : undefined,
  };
}

function normalizeRule(r: ExpensePriceRule): ExpensePriceRule | null {
  if (!r || typeof r !== "object") return null;
  const kind = r.kind === "video" ? "video" : "image";
  return {
    id: String(r.id || newId()),
    kind,
    model: String(r.model ?? "").trim(),
    resolution: String(r.resolution ?? "").trim(),
    durationSec: kind === "video" && r.durationSec != null ? Math.max(0, Math.round(r.durationSec)) : null,
    price: Number.isFinite(r.price) ? Math.max(0, r.price) : 0,
  };
}

function load(): LedgerFile {
  if (cache) return cache;
  let f: LedgerFile = { ...DEFAULTS, entries: [], priceRules: [] };
  try {
    f = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(ledgerJsonPath(), "utf8")) };
  } catch {
    // no ledger file yet — start empty
  }
  f.entries = Array.isArray(f.entries) ? f.entries.map(normalizeEntry).filter((x): x is LedgerEntry => x !== null) : [];
  f.priceRules = Array.isArray(f.priceRules) ? f.priceRules.map(normalizeRule).filter((x): x is ExpensePriceRule => x !== null) : [];
  f.updatedAt = typeof f.updatedAt === "string" ? f.updatedAt : "";
  cache = f;
  return cache;
}

/** Atomic temp+rename write (mirrors store.ts), then rewrite the CSV mirror. */
function save(): void {
  const f = load();
  fs.mkdirSync(ledgerDir(), { recursive: true });
  const target = ledgerJsonPath();
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(f, null, 2), "utf8");
  fs.renameSync(tmp, target);
  writeCsv();
}

const csvEscape = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The human-readable text mirror of the ledger. Rewritten on every mutation,
 *  oldest-first (a chronological log) so the file reads like a running tally. */
function writeCsv(): void {
  const f = load();
  const rows = [...f.entries].reverse().map((e) =>
    [
      new Date(e.at).toISOString(),
      e.kind,
      e.model,
      e.resolution,
      e.kind === "video" && e.durationSec != null ? String(e.durationSec) : "",
      e.price.toFixed(2),
      e.label ?? "",
    ]
      .map(csvEscape)
      .join(",")
  );
  const body = ["date,kind,model,resolution,duration_sec,price,label", ...rows].join("\r\n") + "\r\n";
  fs.mkdirSync(ledgerDir(), { recursive: true });
  const target = ledgerCsvPath();
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, target);
}

/** Record one successful AI generation. The price is stamped here — later
 *  rule edits only affect future generations (historical entries are fixed). */
export function recordGeneration(meta: LedgerGenMeta): void {
  const f = load();
  f.entries.unshift({
    id: newId(),
    kind: meta.kind,
    model: meta.model || "",
    resolution: meta.resolution || "",
    durationSec: meta.kind === "video" ? meta.durationSec : undefined,
    aspectRatio: meta.aspectRatio,
    price: matchPriceRule(f.priceRules, meta),
    at: meta.at || Date.now(),
    productionId: meta.productionId,
    shotId: meta.shotId,
  });
  f.updatedAt = new Date().toISOString();
  save();
}

/** Add a manual "purchased asset" row with a custom dollar amount. */
export function addManualEntry(label: string, amount: number): LedgerView {
  const f = load();
  f.entries.unshift({
    id: newId(),
    kind: "manual",
    model: "",
    resolution: "",
    price: Number.isFinite(amount) ? Math.max(0, amount) : 0,
    at: Date.now(),
    label: String(label ?? "").trim() || "Manual expense",
  });
  f.updatedAt = new Date().toISOString();
  save();
  return view();
}

/** Remove one ledger row. */
export function removeEntry(id: string): LedgerView {
  const f = load();
  const before = f.entries.length;
  f.entries = f.entries.filter((e) => e.id !== id);
  if (f.entries.length !== before) {
    f.updatedAt = new Date().toISOString();
    save();
  }
  return view();
}

/** The renderer read model: newest-first entries plus the running total. */
export function view(): LedgerView {
  const f = load();
  let total = 0;
  let imageCount = 0;
  let videoCount = 0;
  for (const e of f.entries) {
    total += e.price;
    if (e.kind === "image") imageCount += 1;
    else if (e.kind === "video") videoCount += 1;
  }
  return { entries: f.entries, total, imageCount, videoCount };
}

export function getPriceRules(): ExpensePriceRule[] {
  return load().priceRules;
}

export function setPriceRules(rules: ExpensePriceRule[]): void {
  const f = load();
  f.priceRules = Array.isArray(rules) ? rules.map(normalizeRule).filter((r): r is ExpensePriceRule => r !== null) : [];
  f.updatedAt = new Date().toISOString();
  save();
}

/** Open the CSV text ledger in the OS file manager. */
export async function openLedgerFile(): Promise<void> {
  if (!shell) {
    const m = await import("electron").catch(() => null);
    if (!m?.shell) return;
    shell = m.shell;
  }
  const p = ledgerCsvPath();
  if (fs.existsSync(p)) await shell.openPath(p);
}