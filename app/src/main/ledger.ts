/**
 * Expenses ledger — the running tally of every AI generation made in-app.
 *
 * Owns the whole expense concept: the durable ledger (entries + pricing rules
 * in userData/ledger.json), the human-readable CSV mirror
 * (userData/expenses.csv) rewritten on every mutation, and the pure price-rule
 * matcher that turns a generation's metadata into a dollar amount.
 *
 * Pricing is range-based: one rule per model holds a min→max dollar range and
 * the model's baked option ladder (resolutions + video length range). The
 * matcher interpolates between the range endpoints by how far the generation's
 * resolution/length sit on that ladder, so a model needs exactly one rule
 * instead of a cartesian grid of every resolution × length.
 *
 * The OpenArt seam (OpenArtClient's onGeneration callback) feeds successful
 * generations in; the renderer edits pricing rules from Settings and adds
 * manual "purchased asset" rows from the Expenses page. Saving rules re-prices
 * every existing generation (manual rows untouched) — history is recomputable,
 * not frozen.
 *
 * Persistence follows the settings singleton (single userData file, memo
 * cache) with the store's atomic temp+rename writes. Electron is a soft
 * dependency so the module loads in a plain node test process; tests point the
 * ledger at a temp dir via setLedgerUserDataDir().
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExpensePriceRule, LedgerEntry, LedgerGenMeta, LedgerView } from "../shared/ipc.js";

/** Fallback video resolution labels when a video model's live form can't be
 *  read (mirrors the renderer fallback in boards.tsx). */
export const FALLBACK_VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
/** Fallback video lengths in seconds when a video model's live form can't be
 *  read (mirrors the renderer fallback in boards.tsx). */
export const FALLBACK_VIDEO_DURATIONS = [5, 10, 15, 20] as const;

/** Image resolution buckets offered for pricing (mirrors the board config
 *  buckets in shared/ipc.ts). */
export const IMAGE_RESOLUTIONS = ["1k", "2k", "4k"] as const;

/** Global ordinal rank for common resolution labels — used to position a label
 *  that sits outside a rule's baked ladder (e.g. a "240p" or "4K" generation
 *  against a ["720p","1080p"] ladder). Lower = cheaper. */
const RESOLUTION_RANKS: Record<string, number> = {
  "144p": 0,
  "240p": 1,
  "360p": 2,
  "480p": 3,
  "540p": 4,
  "720p": 5,
  "1k": 6,
  "1080p": 6,
  "1440p": 7,
  "2k": 7,
  "4k": 8,
  "8k": 9,
};

const rankKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]/g, "");

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

/** Position of a resolution label on a 0..1 scale inside a ladder: exact
 *  ladder members interpolate by index, known labels outside the ladder place
 *  by global rank, and unknown labels default to the midpoint. Pure. */
export function resolutionScale(ladder: readonly string[], resolution: string): number {
  const n = ladder.length;
  if (!n) return 0.5;
  const idx = ladder.indexOf(resolution);
  if (idx >= 0) return n === 1 ? 0 : idx / (n - 1);
  const rank = RESOLUTION_RANKS[rankKey(resolution)];
  if (rank == null) return 0.5;
  const known = ladder.map((r) => RESOLUTION_RANKS[rankKey(r)]).filter((x): x is number => x != null);
  if (!known.length) return 0.5;
  const minR = Math.min(...known);
  const maxR = Math.max(...known);
  if (maxR === minR) return 0.5;
  return Math.max(0, Math.min(1, (rank - minR) / (maxR - minR)));
}

/** Position of a video length on a 0..1 scale inside a rule's duration range.
 *  Images (no duration range) are pinned at 1 so they interpolate by
 *  resolution only. Pure. */
function durationScale(durMin: number | null, durMax: number | null, durationSec: number | undefined): number {
  if (durMin == null || durMax == null || durationSec == null || durMax <= durMin) return 1;
  return Math.max(0, Math.min(1, (durationSec - durMin) / (durMax - durMin)));
}

/** Price a generation against the rules: pick the most specific rule (exact
 *  model beats "*"), then interpolate its min→max range by the generation's
 *  resolution and video length. Generations matching no rule are priced at $0.
 *  Pure — unit-tested. */
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
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  if (!best) return 0;
  const t = resolutionScale(best.resolutions ?? [], meta.resolution) * durationScale(best.durMin, best.durMax, meta.durationSec);
  return best.minPrice + t * (best.maxPrice - best.minPrice);
}

const clampPrice = (v: unknown, fallback: number): number => (Number.isFinite(v) ? Math.max(0, Number(v)) : fallback);

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

/** Normalize one rule into the range shape. Legacy discrete rules (a single
 *  `price` instead of min/max) collapse to a flat range. Videos missing a
 *  duration range default to the fallback buckets; ladders not present default
 *  to the kind's buckets. */
function normalizeRule(r: unknown): ExpensePriceRule | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const kind = o.kind === "video" ? "video" : o.kind === "image" ? "image" : null;
  if (!kind) return null;
  const hasRange = Number.isFinite(o.minPrice) || Number.isFinite(o.maxPrice);
  let minPrice: number;
  let maxPrice: number;
  if (hasRange) {
    minPrice = clampPrice(o.minPrice, 0);
    maxPrice = clampPrice(o.maxPrice, 0);
  } else if (Number.isFinite(o.price)) {
    const p = Math.max(0, Number(o.price));
    minPrice = p;
    maxPrice = p;
  } else {
    minPrice = 0;
    maxPrice = 0;
  }
  const resolutions = Array.isArray(o.resolutions) && o.resolutions.length
    ? o.resolutions.map(String)
    : [...(kind === "video" ? FALLBACK_VIDEO_RESOLUTIONS : IMAGE_RESOLUTIONS)];
  const durMin = kind === "video" && Number.isFinite(o.durMin) ? Math.max(0, Number(o.durMin)) : null;
  const durMax = kind === "video" && Number.isFinite(o.durMax) ? Math.max(0, Number(o.durMax)) : null;
  return {
    id: String(o.id || newId()),
    kind,
    model: String(o.model ?? "").trim(),
    minPrice,
    maxPrice,
    resolutions,
    durMin,
    durMax,
  };
}

/** Collapse every (kind, model) into one range rule (min = lowest minPrice,
 *  max = highest maxPrice). Keeps the "one range per model" invariant on load
 *  and doubles as the migration for legacy cartesian grids. */
function migrateRules(rules: ExpensePriceRule[]): ExpensePriceRule[] {
  const byKey = new Map<string, ExpensePriceRule>();
  for (const r of rules) {
    const key = `${r.kind}\u0000${r.model}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...r, resolutions: [...r.resolutions] });
      continue;
    }
    existing.minPrice = Math.min(existing.minPrice, r.minPrice);
    existing.maxPrice = Math.max(existing.maxPrice, r.maxPrice);
    if (r.resolutions.length > existing.resolutions.length) existing.resolutions = [...r.resolutions];
  }
  return [...byKey.values()];
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
  f.priceRules = Array.isArray(f.priceRules)
    ? migrateRules(f.priceRules.map(normalizeRule).filter((x): x is ExpensePriceRule => x !== null))
    : [];
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

/** Record one successful AI generation. The price is derived from the current
 *  rules at record time; later rule edits re-price it via repriceAll(). */
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

/** Re-run the current rules over every existing generation, overwriting each
 *  entry's price. Manual rows keep their custom amounts. Pure on the persisted
 *  data — unit-tested. */
export function repriceAll(): LedgerView {
  const f = load();
  let changed = false;
  for (const e of f.entries) {
    if (e.kind === "manual") continue;
    const price = matchPriceRule(f.priceRules, {
      kind: e.kind,
      model: e.model,
      resolution: e.resolution,
      durationSec: e.durationSec,
      aspectRatio: e.aspectRatio,
      at: e.at,
      productionId: e.productionId,
      shotId: e.shotId,
    });
    if (price !== e.price) {
      e.price = price;
      changed = true;
    }
  }
  if (changed) {
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

/** Persist pricing rules and immediately re-price every existing generation
 *  against them (manual rows untouched). */
export function setPriceRules(rules: ExpensePriceRule[]): void {
  const f = load();
  f.priceRules = Array.isArray(rules)
    ? migrateRules(rules.map(normalizeRule).filter((r): r is ExpensePriceRule => r !== null))
    : [];
  f.updatedAt = new Date().toISOString();
  save();
  repriceAll();
}

/** Bake a model's live resolution/length options into its rule. Only video
 *  rules get overridden — image ladders stay the fixed buckets. Used by the
 *  import handler to re-derive ladders that the clean CSV format doesn't
 *  carry. Pure on the rules (the resolver seam is the test surface). */
export async function applyModelOptions(
  rules: ExpensePriceRule[],
  resolveOptions: (modelId: string) => Promise<{ resolutions: string[]; durations: number[] } | null>
): Promise<ExpensePriceRule[]> {
  const out: ExpensePriceRule[] = [];
  for (const r of rules) {
    let next = r;
    if (r.kind === "video" && r.model && r.model !== "*") {
      const o = await resolveOptions(r.model);
      if (o && o.resolutions.length && o.durations.length) {
        next = {
          ...r,
          resolutions: [...o.resolutions],
          durMin: Math.min(...o.durations),
          durMax: Math.max(...o.durations),
        };
      }
    }
    out.push(next);
  }
  return out;
}

/** Serialize price rules to CSV text. Header + one row per rule
 *  (`kind,model,min_price,max_price`). Pure — unit-tested. Ladders are not
 *  carried; the import handler re-derives them from live model options. */
export function priceRulesToCsv(rules: ExpensePriceRule[]): string {
  const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = rules.map((r) =>
    [r.kind, r.model, r.minPrice.toFixed(2), r.maxPrice.toFixed(2)].map(esc).join(",")
  );
  return ["kind,model,min_price,max_price", ...rows].join("\r\n") + "\r\n";
}

/** Split one CSV line into fields, honoring double-quoted fields ("" escapes
 *  a quote). The only CSV the ledger reads is its own export format. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Parse the price-rule CSV export format back into rules. Reads the current
 *  format (`kind,model,min_price,max_price`) and the legacy cartesian format
 *  (`kind,model,resolution,duration_sec,price`, collapsed to flat ranges).
 *  Header + blank lines are skipped; malformed rows are dropped. Fresh ids are
 *  assigned (rules never carry identity across files). Pure — unit-tested. */
export function parsePriceRulesCsv(text: string): ExpensePriceRule[] {
  const lines = String(text ?? "").split(/\r\n|\n/);
  const rules: ExpensePriceRule[] = [];
  let legacy = false;
  for (const rawLine of lines) {
    const cells = splitCsvLine(rawLine).map((c) => c.trim());
    if (cells.length < 2) continue;
    const [a, b] = cells;
    if (a.toLowerCase() === "kind" && b.toLowerCase() === "model") {
      legacy = cells.length >= 5 && cells[2].toLowerCase() === "resolution";
      continue;
    }
    const kindCell = cells[0];
    const kind = kindCell === "video" ? "video" : kindCell === "image" ? "image" : null;
    if (!kind) continue;
    if (legacy) {
      if (cells.length < 5) continue;
      const price = Number.isFinite(Number(cells[4])) ? Number(cells[4]) : 0;
      const rule = normalizeRule({ id: newId(), kind, model: cells[1], minPrice: price, maxPrice: price });
      if (rule) rules.push(rule);
    } else {
      if (cells.length < 4) continue;
      const rule = normalizeRule({ id: newId(), kind, model: cells[1], minPrice: Number(cells[2]), maxPrice: Number(cells[3]) });
      if (rule) rules.push(rule);
    }
  }
  return rules;
}

/** Write the price rules as CSV to an arbitrary user-picked path (atomic
 *  temp+rename). Used by the Settings → Expense pricing export button. */
export function writePriceRulesFile(filePath: string, rules: ExpensePriceRule[]): void {
  const body = priceRulesToCsv(rules);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, filePath);
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