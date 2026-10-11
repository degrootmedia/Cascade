/**
 * Resolution-label ranking shared by every dropdown/submit path that has to
 * reconcile a requested resolution with the tiers a model actually declares.
 *
 * The renderer uses it to re-pick the closest supported option when a model's
 * live choices arrive (board modal, graph video/in-betweener nodes, tween
 * timeline); main uses it to clamp a requested tier onto a vendor form's enum
 * (OpenArt image forms expose tiers like `["2K","4K"]`, so an unsupported
 * "4k" pick must land on the closest tier instead of silently falling back to
 * the vendor default — which is often the smallest).
 */

/** Numeric weight of a resolution label: "1080p" → 1080, "2k" → 2000, "4k" → 4000. */
export function resolutionWeight(r: string): number | null {
  const m = String(r).trim().match(/^(\d+(?:\.\d+)?)\s*(k|p)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] && m[2].toLowerCase() === "k" ? n * 1000 : n;
}

/** The available resolution closest to `selected` (numeric distance, ties
 *  break toward the smaller/cheaper one). Unparseable labels fall back to the
 *  first entry; an empty list returns the selection unchanged. */
export function closestResolution(selected: string, available: string[]): string {
  if (!available.length) return selected;
  if (available.includes(selected)) return selected;
  const target = resolutionWeight(selected);
  if (target === null) return available[0];
  let best = available[0];
  let bestDist = Infinity;
  for (const r of available) {
    const w = resolutionWeight(r);
    if (w === null) continue;
    const dist = Math.abs(w - target);
    if (dist < bestDist || (dist === bestDist && w < (resolutionWeight(best) ?? Infinity))) {
      best = r;
      bestDist = dist;
    }
  }
  return best;
}
