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

/**
 * A surface that embeds the snippet library itself (the node canvas's
 * tabbed right shelf) can claim shelf-open requests while it is mounted:
 * "Save selection as snippet" from a node prompt then lands in the
 * embedded Snippets tab instead of also opening the overlay shelf.
 * Only one claim is active at a time (the most recently mounted).
 */
let claimHandler: ((req: SnippetsShelfRequest) => void) | null = null;

/** Ask the mounted shelf host to open. No-op when no host is mounted. */
export function openSnippetsShelf(req: SnippetsShelfRequest = {}): void {
  if (claimHandler) {
    claimHandler(req);
    return;
  }
  for (const fn of [...listeners]) fn(req);
}

/** Host subscription. Returns an unsubscribe function. */
export function onOpenSnippetsShelf(fn: (req: SnippetsShelfRequest) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Claim shelf-open requests (see above). Returns a release function that
 *  only clears the claim when it is still the active one. */
export function claimSnippetsShelfRequests(fn: (req: SnippetsShelfRequest) => void): () => void {
  claimHandler = fn;
  return () => {
    if (claimHandler === fn) claimHandler = null;
  };
}
