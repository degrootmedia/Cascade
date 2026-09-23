/**
 * Expenses-ledger types (master plan step 06 T1).
 *
 * Domain module of `shared/ipc.ts`; the barrel re-exports everything.
 */

/** One row in the expenses ledger — a priced AI generation or a manual
 *  "purchased asset" entry the user adds by hand. */
export interface LedgerEntry {
  /** Stable identity. */
  id: string;
  /** What was generated: image / video, or "manual" for custom purchased-asset rows. */
  kind: "image" | "video" | "manual";
  /** Resolved OpenArt model id (empty for manual rows). */
  model: string;
  /** Resolution label: "1k"/"2k"/"4k" bucket for images, e.g. "1080p" for video. */
  resolution: string;
  /** Clip length in seconds (video only). */
  durationSec?: number;
  /** Aspect ratio for images (e.g. "16:9"). */
  aspectRatio?: string;
  /** The price stamped when the entry was recorded ($0 when no rule matched).
   *  For credit-tracked rows (Higgsfield CLI) this is credits × the credit
   *  rate at record/reprice time — the row's `credits` is the source of
   *  truth and the rate is recomputable, same philosophy as the $ rules. */
  price: number;
  /** Credits the generation cost (Higgsfield CLI `generate cost` preflight at
   *  submit time). Rows carrying this render in credits; `price` is the
   *  dollar conversion. Absent for $ rule rows and manual rows. */
  credits?: number;
  /** When the generation completed / the manual row was added. */
  at: number;
  /** Custom label for manual entries. */
  label?: string;
  /** Production the generation belongs to. */
  productionId?: string;
  /** Shot the generation belongs to. */
  shotId?: string;
}

/** A pricing rule: kind + model → a dollar range. One range per model: the
 *  price interpolates between minPrice (cheapest config) and maxPrice (most
 *  expensive config) based on the generation's resolution and (video) length
 *  against the model's baked option ladder (resolutions[] + durMin/durMax).
 *  An empty model acts as "*" (any model). Exact models beat the wildcard;
 *  generations matching no rule are priced at $0. */
export interface ExpensePriceRule {
  id: string;
  kind: "image" | "video";
  model: string;
  /** Price at the cheapest config (lowest resolution, shortest video). */
  minPrice: number;
  /** Price at the most expensive config (highest resolution, longest video). */
  maxPrice: number;
  /** The model's resolution ladder, low → high (baked from its live form
   *  options at edit time; kind defaults when unknown). */
  resolutions: string[];
  /** Shortest video length in seconds this range prices (null for images). */
  durMin: number | null;
  /** Longest video length in seconds this range prices (null for images). */
  durMax: number | null;
}

/** The renderer read model for the Expenses page. */
export interface LedgerView {
  entries: LedgerEntry[];
  total: number;
  imageCount: number;
  videoCount: number;
  /** Dollar value of one Higgsfield credit used for `total` (null when the
   *  user hasn't set a rate — credit rows then contribute $0). */
  creditUsd: number | null;
}

/** Metadata handed to the generation seam for one successful AI generation. */
export interface LedgerGenMeta {
  kind: "image" | "video";
  model: string;
  resolution: string;
  durationSec?: number;
  aspectRatio?: string;
  /** Credits the generation cost (Higgsfield CLI preflight at submit time).
   *  Recorded on the entry so credit-tracked rows never need $ rules. */
  credits?: number;
  at: number;
  productionId?: string;
  shotId?: string;
}
