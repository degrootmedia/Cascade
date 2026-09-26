/**
 * Renderer media revision cache-buster. Reference files live at a stable
 * `cascade-media://` URL, so when one is saved over outside Cascade the
 * already-mounted `<img>` would keep its cached bitmap. A per-file revision is
 * appended to `cascadeMedia` URLs; bumping it and re-rendering forces the
 * browser to re-fetch. In-memory (reset each app launch) — the protocol's
 * strong ETag makes a normal revalidation cheap.
 */
const revs = new Map<string, number>();

function key(prodId: string, rel: string): string {
  return `${prodId}\u0000${rel}`;
}

/** Bump a media file's revision so every URL for it changes. */
export function bumpMediaRev(prodId: string, rel: string): void {
  const k = key(prodId, rel);
  revs.set(k, (revs.get(k) ?? 0) + 1);
}

export function mediaRev(prodId: string, rel: string): number {
  return revs.get(key(prodId, rel)) ?? 0;
}
