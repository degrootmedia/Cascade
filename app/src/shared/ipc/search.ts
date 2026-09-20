/**
 * Session search types (master plan step 09 T1).
 *
 * Domain module of `shared/ipc.ts`; the barrel re-exports it.
 */
export interface SessionSearchHit {
  sessionId: string;
  title: string;
  updatedAt: string;
  /** A window of the transcript around the match. */
  snippet: string;
}
