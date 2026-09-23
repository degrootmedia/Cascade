/**
 * Pure A/B resolution for the Image Suite canvas.
 *
 * The canvas shows up to two frames stacked with a wipe: `a` over `b`. A
 * selected edit entry compares its resolved source ("Before edit") against its
 * own result ("After edit"); anything else shows a single frame.
 *
 * Kept free of React and of `cascadeMedia` (the caller injects a `media`
 * function) so the pairing rules are unit-testable in isolation.
 */
import type { Production, SuiteEntry, SuiteMode } from "../../../../shared/ipc.js";

/** One side of the wipe: a media URL plus the caption shown in its corner.
 *  `rel` is the production-relative path when known, so the right-click menu
 *  can act on the underlying file. */
export interface SuiteFrame {
  url: string;
  label: string;
  rel?: string;
}

export interface SuiteComparePair {
  a: SuiteFrame;
  b: SuiteFrame;
}

interface ArtworkRef {
  id: string;
  imagePath?: string;
  artwork?: string;
}

/** Resolve a reference/character/product id to its artwork URL + rel path. */
export function referenceArtwork(
  prod: Production,
  refId: string,
  media: (rel: string) => string
): { url: string; rel?: string } | null {
  const pool: ArtworkRef[] = [...(prod.characters ?? []), ...(prod.products ?? []), ...(prod.references ?? [])];
  const r = pool.find((x) => x.id === refId);
  if (!r) return null;
  if (r.imagePath) return { url: media(r.imagePath), rel: r.imagePath };
  return r.artwork ? { url: r.artwork } : null;
}

/** Resolve a reference/character/product id to its artwork URL. */
export function referenceArtworkUrl(
  prod: Production,
  refId: string,
  media: (rel: string) => string
): string | null {
  return referenceArtwork(prod, refId, media)?.url ?? null;
}

/** The "before" caption for a source-taking mode. */
function beforeLabel(mode: SuiteMode | undefined): string {
  return mode === "upscale" ? "Before upscale" : "Before edit";
}

/** The frame for one entry's own output. */
export function entryFrame(entry: SuiteEntry, media: (rel: string) => string): SuiteFrame {
  const label = entry.kind === "edit" ? "After edit" : entry.kind === "upscale" ? "After upscale" : "Result";
  return { url: media(entry.outputPath), rel: entry.outputPath, label };
}

/** The "Before edit" frame for an edit entry's resolved source, or null. */
export function entrySourceFrame(
  entry: SuiteEntry,
  prod: Production,
  media: (rel: string) => string
): SuiteFrame | null {
  const label = beforeLabel(entry.kind);
  if (entry.sourceRefId) {
    const art = referenceArtwork(prod, entry.sourceRefId, media);
    return art ? { ...art, label } : null;
  }
  if (entry.sourcePath) return { url: media(entry.sourcePath), rel: entry.sourcePath, label };
  return null;
}

/** The "Before edit" frame a handoff seed asks the canvas to reveal before the
 *  first edit runs (source may be a reference id or a production-relative path). */
export function seedSourceFrame(
  seed: { mode?: SuiteMode; sourceRefId?: string; sourcePath?: string },
  prod: Production,
  media: (rel: string) => string
): SuiteFrame | null {
  const label = beforeLabel(seed.mode);
  if (seed.sourceRefId) {
    const art = referenceArtwork(prod, seed.sourceRefId, media);
    return art ? { ...art, label } : null;
  }
  if (seed.sourcePath) return { url: media(seed.sourcePath), rel: seed.sourcePath, label };
  return null;
}

export interface ResolveCompareInput {
  entries: SuiteEntry[];
  selectedId: string | null;
  prod: Production;
  media: (rel: string) => string;
}

/** Resolve the canvas wipe pair, or null when there is nothing to compare. */
export function resolveSuiteCompare(input: ResolveCompareInput): SuiteComparePair | null {
  const { entries, selectedId, prod, media } = input;
  const selected = selectedId ? (entries.find((e) => e.id === selectedId) ?? null) : null;

  // An edit/upscale entry always offers its before/after pair.
  if (selected?.kind === "edit" || selected?.kind === "upscale") {
    const before = entrySourceFrame(selected, prod, media);
    if (before) return { a: before, b: entryFrame(selected, media) };
  }

  return null;
}
