import { useCallback, useEffect, useRef, useState } from "react";
import type { JobRecord } from "../../../../shared/ipc.js";
import { nextRunIds, runProgress, unseenProblemIds, type RunProgress } from "./queue-format.js";

export interface QueueButtonState extends RunProgress {
  /** Warning dot: a job failed/was interrupted and the panel hasn't been opened since. */
  warn: boolean;
  /** Brief done state after the last active job finishes. */
  justDone: boolean;
  /** Call when the panel opens: acknowledges current problems. */
  acknowledge: () => void;
}

const DONE_MS = 2500;

/** Derives the header button's state from the ledger's jobs. */
export function useQueueButton(jobs: JobRecord[]): QueueButtonState {
  const runRef = useRef<Set<string>>(new Set());
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const [justDone, setJustDone] = useState(false);
  const wasActive = useRef(false);

  runRef.current = nextRunIds(runRef.current, jobs);
  const progress = runProgress(jobs, runRef.current);

  useEffect(() => {
    if (progress.active > 0) { wasActive.current = true; setJustDone(false); return; }
    if (!wasActive.current) return;
    wasActive.current = false;
    setJustDone(true);
    const t = setTimeout(() => setJustDone(false), DONE_MS);
    return () => clearTimeout(t);
  }, [progress.active]);

  const acknowledge = useCallback(() => {
    setSeen((prev) => {
      const next = new Set(prev);
      for (const j of jobs) if (j.state === "failed" || j.state === "interrupted") next.add(j.id);
      return next;
    });
  }, [jobs]);

  return { ...progress, warn: unseenProblemIds(jobs, seen).length > 0, justDone, acknowledge };
}
