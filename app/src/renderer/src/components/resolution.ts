/** Selection rules shared by the video-model dropdowns (board modal, graph
 *  video/in-betweener nodes, tween timeline): when a model's live options
 *  arrive, a stale resolution re-picks the CLOSEST supported one instead of
 *  falling back to the first. */

/** Numeric weight of a resolution label: "1080p" → 1080, "2k" → 2000, "4k" → 4000. */
function resWeight(r: string): number | null {
  const m = r.trim().match(/^(\d+(?:\.\d+)?)\s*(k|p)?$/i);
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
  const target = resWeight(selected);
  if (target === null) return available[0];
  let best = available[0];
  let bestDist = Infinity;
  for (const r of available) {
    const w = resWeight(r);
    if (w === null) continue;
    const dist = Math.abs(w - target);
    if (dist < bestDist || (dist === bestDist && w < (resWeight(best) ?? Infinity))) {
      best = r;
      bestDist = dist;
    }
  }
  return best;
}
