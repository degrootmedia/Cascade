/**
 * Expenses ledger — the running tally of every AI generation made in-app.
 *
 * Owns the whole expense concept: the per-production entry ledgers
 * (userData/ledger/<productionId>.json, one per project), the global pricing
 * rules (userData/ledger.json — vendor-wide, not project data), each
 * project's human-readable CSV mirror (userData/ledger/<productionId>.csv)
 * rewritten on every mutation, and the pure price-rule matcher that turns a
 * generation's metadata into a dollar amount.
 *
 * Entries are scoped to the production that produced them (the generation's
 * `productionId`), so a project's Expenses page shows only its own spend.
 * Deleting/archiving a production's ledger is the caller's concern (wiring);
 * the global rules file is never per-project.
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
  rulesCache = null;
  projectCache.clear();
}

/** The global pricing-rules doc (userData/ledger.json). Entries used to live
 *  here too; `version: 2` moved them into per-production files. */
interface RulesFile {
  priceRules: ExpensePriceRule[];
  updatedAt: string;
  version: number;
}

/** One production's entry ledger (userData/ledger/<productionId>.json). */
interface ProjectLedgerFile {
  productionId: string;
  entries: LedgerEntry[];
  updatedAt: string;
}

/** Current on-disk ledger schema. 1 = legacy single-file (rules + entries),
 *  2 = rules in ledger.json, entries split per production. */
const RULES_VERSION = 2;

let rulesCache: RulesFile | null = null;
const projectCache = new Map<string, ProjectLedgerFile>();

function ledgerDir(): string {
  if (!userDataDir) throw new Error("Ledger userData dir not available (is this running inside Electron?)");
  return userDataDir;
}

function ledgerJsonPath(): string {
  return path.join(ledgerDir(), "ledger.json");
}

function entriesDir(): string {
  return path.join(ledgerDir(), "ledger");
}

/** Guard a production id before it becomes a filename. Real ids are
 *  store-generated (`<base36>-<random>`) so this only rejects corrupt callers. */
function validProductionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

function entryFilePath(productionId: string): string {
  if (!validProductionId(productionId)) throw new Error(`Invalid production id for ledger: ${productionId}`);
  return path.join(entriesDir(), `${productionId}.json`);
}

function entryCsvPath(productionId: string): string {
  if (!validProductionId(productionId)) throw new Error(`Invalid production id for ledger: ${productionId}`);
  return path.join(entriesDir(), `${productionId}.csv`);
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Read + normalize the global pricing rules, running the one-time split of
 *  legacy single-file entries into per-production ledgers. Migrated entries
 *  without a `productionId` are dropped (unattributable), then ledger.json is
 *  rewritten rules-only. */
function loadRules(): RulesFile {
  if (rulesCache) return rulesCache;
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(ledgerJsonPath(), "utf8")) as Record<string, unknown>;
  } catch {
    // no rules file yet — start empty
  }
  const priceRules = Array.isArray(raw.priceRules)
    ? migrateRules(raw.priceRules.map(normalizeRule).filter((r): r is ExpensePriceRule => r !== null))
    : [];
  const version = typeof raw.version === "number" ? raw.version : 1;
  rulesCache = {
    priceRules,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    version: RULES_VERSION,
  };
  if (version < RULES_VERSION) {
    migrateEntries(raw.entries);
    saveRules();
  }
  return rulesCache;
}

/** One-time split of the legacy global `entries` array into per-production
 *  files. Rows without a `productionId` cannot be attributed to any project
 *  and are discarded. */
function migrateEntries(legacy: unknown): void {
  if (!Array.isArray(legacy)) return;
  const byProject = new Map<string, LedgerEntry[]>();
  for (const e of legacy) {
    const entry = normalizeEntry(e as LedgerEntry);
    if (!entry || !entry.productionId || !validProductionId(entry.productionId)) continue;
    const list = byProject.get(entry.productionId) ?? [];
    list.push(entry);
    byProject.set(entry.productionId, list);
  }
  for (const [productionId, entries] of byProject) {
    const f = loadProject(productionId);
    f.entries = [...f.entries, ...entries];
    f.updatedAt = new Date().toISOString();
    saveProject(f);
  }
}

function loadProject(productionId: string): ProjectLedgerFile {
  // Ensure the one-time legacy split has run before reading per-project files
  // (loadRules sets its cache before migrating, so this is re-entrancy-safe).
  loadRules();
  const cached = projectCache.get(productionId);
  if (cached) return cached;
  let f: ProjectLedgerFile = { productionId, entries: [], updatedAt: "" };
  try {
    const raw = JSON.parse(fs.readFileSync(entryFilePath(productionId), "utf8")) as Partial<ProjectLedgerFile>;
    f.entries = Array.isArray(raw.entries)
      ? raw.entries.map(normalizeEntry).filter((x): x is LedgerEntry => x !== null)
      : [];
    f.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : "";
  } catch {
    // no ledger for this production yet — start empty
  }
  projectCache.set(productionId, f);
  return f;
}

/** Atomic temp+rename write of one production's ledger, then its CSV mirror. */
function saveProject(f: ProjectLedgerFile): void {
  fs.mkdirSync(entriesDir(), { recursive: true });
  const target = entryFilePath(f.productionId);
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(f, null, 2), "utf8");
  fs.renameSync(tmp, target);
  writeProjectCsv(f);
}

/** Atomic temp+rename write of the global rules file. */
function saveRules(): void {
  const f = loadRules();
  fs.mkdirSync(ledgerDir(), { recursive: true });
  const target = ledgerJsonPath();
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(f, null, 2), "utf8");
  fs.renameSync(tmp, target);
}

/** Every per-production ledger on disk (newest read order isn't needed here). */
function loadAllProjects(): ProjectLedgerFile[] {
  let files: string[];
  try {
    files = fs.readdirSync(entriesDir());
  } catch {
    return [];
  }
  const out: ProjectLedgerFile[] = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
    const id = file.slice(0, -".json".length);
    if (validProductionId(id)) out.push(loadProject(id));
  }
  return out;
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

/** Price a generation in dollars: credit-tracked rows convert at the current
 *  credit rate (unset rate prices them $0 — the credits themselves are the
 *  record); everything else prices against the $ rules. Pure — unit-tested. */
export function priceFor(rules: ExpensePriceRule[], meta: LedgerGenMeta, creditUsd: number | null): number {
  if (meta.credits != null) {
    return creditUsd != null ? meta.credits * creditUsd : 0;
  }
  return matchPriceRule(rules, meta);
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

/** Keep only sane credit amounts (finite, non-negative); corrupt shapes —
 *  NaN from a bad IPC payload, negatives — record as absent. */
function validCredits(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function normalizeEntry(e: LedgerEntry): LedgerEntry | null {
  if (!e || typeof e !== "object" || typeof e.id !== "string") return null;
  const kind = e.kind === "video" ? "video" : e.kind === "manual" ? "manual" : "image";
  const credits = typeof e.credits === "number" && Number.isFinite(e.credits) && e.credits >= 0 ? e.credits : undefined;
  return {
    id: e.id,
    kind,
    model: String(e.model ?? ""),
    resolution: String(e.resolution ?? ""),
    durationSec: kind === "video" && e.durationSec != null ? Math.max(0, e.durationSec) : undefined,
    aspectRatio: typeof e.aspectRatio === "string" ? e.aspectRatio : undefined,
    price: Number.isFinite(e.price) ? Math.max(0, e.price) : 0,
    credits,
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

const csvEscape = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The human-readable text mirror of one production's ledger. Rewritten on
 *  every mutation, oldest-first (a chronological log) so the file reads like a
 *  running tally. */
function writeProjectCsv(f: ProjectLedgerFile): void {
  const rows = [...f.entries].reverse().map((e) =>
    [
      new Date(e.at).toISOString(),
      e.kind,
      e.model,
      e.resolution,
      e.kind === "video" && e.durationSec != null ? String(e.durationSec) : "",
      e.price.toFixed(2),
      e.credits != null ? String(e.credits) : "",
      e.label ?? "",
    ]
      .map(csvEscape)
      .join(",")
  );
  const body = ["date,kind,model,resolution,duration_sec,price,credits,label", ...rows].join("\r\n") + "\r\n";
  fs.mkdirSync(entriesDir(), { recursive: true });
  const target = entryCsvPath(f.productionId);
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, target);
}

/** Record one successful AI generation against its production. The price is
 *  derived from the current rules (or the credit rate for credit-tracked
 *  rows) at record time; later rule/rate edits re-price it via repriceAll().
 *  A generation with no `productionId` can't be attributed to a project and
 *  is dropped. */
export function recordGeneration(meta: LedgerGenMeta, creditUsd?: number | null): void {
  const productionId = meta.productionId;
  if (!productionId || !validProductionId(productionId)) return;
  const rules = loadRules();
  const credits = validCredits(meta.credits);
  const f = loadProject(productionId);
  f.entries.unshift({
    id: newId(),
    kind: meta.kind,
    model: meta.model || "",
    resolution: meta.resolution || "",
    durationSec: meta.kind === "video" ? meta.durationSec : undefined,
    aspectRatio: meta.aspectRatio,
    price: priceFor(rules.priceRules, { ...meta, credits }, creditUsd ?? null),
    credits,
    at: meta.at || Date.now(),
    productionId,
    shotId: meta.shotId,
  });
  f.updatedAt = new Date().toISOString();
  saveProject(f);
}

/** Add a manual "purchased asset" row to one production's ledger. */
export function addManualEntry(productionId: string, label: string, amount: number, creditUsd?: number | null): LedgerView {
  const f = loadProject(productionId);
  f.entries.unshift({
    id: newId(),
    kind: "manual",
    model: "",
    resolution: "",
    price: Number.isFinite(amount) ? Math.max(0, amount) : 0,
    at: Date.now(),
    label: String(label ?? "").trim() || "Manual expense",
    productionId,
  });
  f.updatedAt = new Date().toISOString();
  saveProject(f);
  return view(productionId, creditUsd);
}

/** Remove one row from a production's ledger. */
export function removeEntry(productionId: string, id: string, creditUsd?: number | null): LedgerView {
  const f = loadProject(productionId);
  const before = f.entries.length;
  f.entries = f.entries.filter((e) => e.id !== id);
  if (f.entries.length !== before) {
    f.updatedAt = new Date().toISOString();
    saveProject(f);
  }
  return view(productionId, creditUsd);
}

/** The generation metadata an entry prices against (drops the pricing-irrelevant
 *  fields, normalizing "manual" out — callers skip manual rows first). */
function entryMeta(e: LedgerEntry): LedgerGenMeta {
  return {
    kind: e.kind === "video" ? "video" : "image",
    model: e.model,
    resolution: e.resolution,
    durationSec: e.durationSec,
    aspectRatio: e.aspectRatio,
    credits: e.credits,
    at: e.at,
    productionId: e.productionId,
    shotId: e.shotId,
  };
}

/** Re-run the current rules (and credit rate) over every production's
 *  generations, overwriting each entry's price. Manual rows keep their
 *  custom amounts. */
export function repriceAll(creditUsd?: number | null): void {
  const rules = loadRules();
  const rate = creditUsd ?? null;
  for (const f of loadAllProjects()) {
    let changed = false;
    for (const e of f.entries) {
      if (e.kind === "manual") continue;
      const price = priceFor(rules.priceRules, entryMeta(e), rate);
      if (price !== e.price) {
        e.price = price;
        changed = true;
      }
    }
    if (changed) {
      f.updatedAt = new Date().toISOString();
      saveProject(f);
    }
  }
}

/** The renderer read model for one production: newest-first entries plus the
 *  running total (credit rows converted at the given rate). */
export function view(productionId: string, creditUsd?: number | null): LedgerView {
  const f = loadProject(productionId);
  let total = 0;
  let imageCount = 0;
  let videoCount = 0;
  for (const e of f.entries) {
    total += e.price;
    if (e.kind === "image") imageCount += 1;
    else if (e.kind === "video") videoCount += 1;
  }
  return { entries: f.entries, total, imageCount, videoCount, creditUsd: creditUsd ?? null };
}

export function getPriceRules(): ExpensePriceRule[] {
  return loadRules().priceRules;
}

/** Persist pricing rules and immediately re-price every production's existing
 *  generations against them (manual rows untouched). Credit rows convert at
 *  the given rate — callers pass the current one so a rules edit never
 *  zeroes them. */
export function setPriceRules(rules: ExpensePriceRule[], creditUsd?: number | null): void {
  const f = loadRules();
  f.priceRules = Array.isArray(rules)
    ? migrateRules(rules.map(normalizeRule).filter((r): r is ExpensePriceRule => r !== null))
    : [];
  f.updatedAt = new Date().toISOString();
  saveRules();
  repriceAll(creditUsd);
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

/** Open one production's CSV text ledger in the OS file manager. */
export async function openLedgerFile(productionId: string): Promise<void> {
  if (!shell) {
    const m = await import("electron").catch(() => null);
    if (!m?.shell) return;
    shell = m.shell;
  }
  const p = entryCsvPath(productionId);
  if (fs.existsSync(p)) await shell.openPath(p);
}

/** Drop a production's ledger files (JSON + CSV). Called when the production is
 *  hard-deleted from the workspace so its spend can't linger as an orphan. */
export function removeProject(productionId: string): void {
  if (!validProductionId(productionId)) return;
  projectCache.delete(productionId);
  try {
    fs.rmSync(entryFilePath(productionId), { force: true });
    fs.rmSync(entryCsvPath(productionId), { force: true });
  } catch {
    /* nothing to remove */
  }
}

/** Soft-delete a production's ledger into ledger/archive/ (mirrors the
 *  production document store's archive). */
export function archiveProject(productionId: string): void {
  if (!validProductionId(productionId)) return;
  projectCache.delete(productionId);
  const dir = path.join(entriesDir(), "archive");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(entryFilePath(productionId), path.join(dir, `${productionId}.json`));
    if (fs.existsSync(entryCsvPath(productionId))) {
      fs.renameSync(entryCsvPath(productionId), path.join(dir, `${productionId}.csv`));
    }
  } catch {
    /* nothing to archive */
  }
}