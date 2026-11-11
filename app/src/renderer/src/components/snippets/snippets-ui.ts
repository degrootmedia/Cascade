/**
 * Open/close requests for the Snippets shelf. The shelf host is mounted
 * once (ProductionWorkspace, which owns both the classic view and the node
 * graph modal); opener buttons and the prompt editor's "Save selection as
 * snippet" menu live elsewhere and talk to it through these listeners, so
 * no prop drilling crosses the modal boundary.
 */

export interface SnippetsShelfRequest {
  /** When set, the shelf opens with the add-snippet form pre-filled with
   *  this body (Save selection as snippet). */
  prefillBody?: string;
}

const listeners = new Set<(req: SnippetsShelfRequest) => void>();

/** Ask the mounted shelf host to open. No-op when no host is mounted. */
export function openSnippetsShelf(req: SnippetsShelfRequest = {}): void {
  for (const fn of [...listeners]) fn(req);
}

/** Host subscription. Returns an unsubscribe function. */
export function onOpenSnippetsShelf(fn: (req: SnippetsShelfRequest) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
