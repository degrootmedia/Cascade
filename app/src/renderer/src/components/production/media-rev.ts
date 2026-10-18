/**
 * Renderer media revision cache-buster. Reference files live at a stable
 * `cascade-media://` URL, so when one is saved over outside Cascade the
 * already-mounted `<img>` would keep its cached bitmap. A per-file revision is
 * appended to `cascadeMedia` URLs; bumping it and re-rendering forces the
 * browser to re-fetch. In-memory (reset each app launch) — the protocol's
 * strong ETag makes a normal revalidation cheap.
 *
 * Surfaces that hold fetched pixels in state (the storyboard cards' data-URL
 * thumbnails) cannot rely on a URL changing under them: they subscribe via
 * `useMediaRev` so a bump re-renders them and their fetch effect can key on
 * the returned revision.
 */
import { useEffect, useReducer } from "react";

const revs = new Map<string, number>();
const listeners = new Set<() => void>();

function key(prodId: string, rel: string): string {
  return `${prodId}\u0000${rel}`;
}

/** Bump a media file's revision so every URL for it changes. */
export function bumpMediaRev(prodId: string, rel: string): void {
  const k = key(prodId, rel);
  revs.set(k, (revs.get(k) ?? 0) + 1);
  for (const listener of listeners) listener();
}

export function mediaRev(prodId: string, rel: string): number {
  return revs.get(key(prodId, rel)) ?? 0;
}

/** Subscribe to revision bumps (any file — bumps are rare). Returns the
 *  unsubscribe function. */
export function subscribeMediaRev(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A file's current revision, re-rendering the component on every bump so an
 *  effect keyed on the value refetches exactly when ITS file's rev changes. */
export function useMediaRev(prodId: string, rel: string | undefined): number {
  const bump = useReducer((n: number) => n + 1, 0)[1];
  useEffect(() => subscribeMediaRev(bump), [bump]);
  return rel ? mediaRev(prodId, rel) : 0;
}
