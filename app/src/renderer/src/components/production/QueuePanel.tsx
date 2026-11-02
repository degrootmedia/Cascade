import { useEffect, useRef, useState } from "react";
import { isActiveJobState, jobStateLabel, type JobRecord } from "../../../../shared/ipc.js";
import { clearFinishedIds, formatElapsed, friendlyModel, jobElapsedMs, jobMediaType, queueFooterText } from "./queue-format.js";

/** Active jobs first, then newest first. */
export function sortQueueJobs(jobs: JobRecord[]): JobRecord[] {
  return [...jobs].sort((a, b) => {
    const aa = isActiveJobState(a.state) ? 0 : 1;
    const bb = isActiveJobState(b.state) ? 0 : 1;
    return aa - bb || b.startedAt.localeCompare(a.startedAt);
  });
}

export interface QueuePanelProps {
  jobs: JobRecord[];
  /** Human name for a job's target ("Shot 4", plus node), resolved by the host. */
  describeTarget: (job: JobRecord) => string;
  /** Project name to prefix rows with when more than one project is open. */
  projectName?: string;
  /** Thumbnail URL for a job's shot, when one exists. */
  thumbFor?: (job: JobRecord) => string | undefined;
  /** Take the user to the job's shot/node (switching views if needed). */
  onOpenJob: (job: JobRecord) => void;
  onClose: () => void;
  /** The button that opened the panel; clicks on it are not "outside". */
  anchorRef?: React.RefObject<HTMLElement | null>;
}

/** Popover listing this production's generations. It does not block the
 *  canvas (no backdrop); it closes on Esc or a click outside it. */
export function QueuePanel({ jobs, describeTarget, projectName, thumbFor, onOpenJob, onClose, anchorRef }: QueuePanelProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const rows = sortQueueJobs(jobs);
  const anyActive = rows.some((j) => isActiveJobState(j.state));

  // Elapsed time ticks live while anything is active.
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyActive]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || anchorRef?.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [onClose, anchorRef]);

  const act = (fn: () => Promise<unknown>) => { void fn().catch(() => {}); };
  const finished = clearFinishedIds(rows);

  return (
    <div className="prod-queue-panel" role="dialog" aria-label="Generation queue" ref={rootRef}>
      <div className="prod-queue-panel-head">
        <strong>Generation queue</strong>
        <button className="prod-queue-panel-x" onClick={onClose} aria-label="Close queue">&times;</button>
      </div>
      {rows.length === 0 && <div className="prod-queue-empty">Nothing in the queue.</div>}
      {rows.map((j) => {
        const active = isActiveJobState(j.state);
        const retryable = (j.state === "failed" || j.state === "interrupted") && !!j.channel;
        const type = jobMediaType(j.kind);
        const model = friendlyModel(j);
        const thumb = thumbFor?.(j);
        const target = describeTarget(j);
        const hasPct = active && typeof j.progress === "number";
        return (
          <div key={j.id} className={"prod-queue-row prod-queue-row--" + j.state}>
            <div className="prod-queue-row-open" role="button" tabIndex={0} title="Go to this generation"
              onClick={() => onOpenJob(j)}
              onKeyDown={(e) => { if (e.key === "Enter") onOpenJob(j); }}>
              <div className="prod-queue-thumb">
                {thumb ? <img src={thumb} alt="" /> : <span aria-hidden="true">{type === "video" ? "\u25B6" : "\u25A3"}</span>}
              </div>
              <div className="prod-queue-row-body">
                <div className="prod-queue-row-main">
                  <span className="prod-queue-row-label">{projectName ? `${projectName} \u00B7 ` : ""}{target}</span>
                  <span className="prod-queue-row-state">
                    {jobStateLabel(j.state)}{hasPct ? ` ${Math.round(j.progress as number)}%` : ""}
                  </span>
                </div>
                <div className="prod-queue-row-meta">
                  {type === "video" ? "Video" : "Image"}{model ? ` \u00B7 ${model}` : ""}{j.origin === "agent" ? " \u00B7 chat" : ""}
                  <span className="prod-queue-row-elapsed">{formatElapsed(jobElapsedMs(j, now))}</span>
                </div>
                {active && (
                  <div className={"prod-queue-bar" + (hasPct ? "" : " prod-queue-bar--indeterminate")}>
                    <span style={hasPct ? { width: `${Math.round(j.progress as number)}%` } : undefined} />
                  </div>
                )}
              </div>
            </div>
            {j.error && <div className="prod-queue-row-error">{j.error}</div>}
            {j.state === "cancelled" && (
              <div className="prod-queue-row-note">Stopped in Cascade. The provider may still finish it on their side.</div>
            )}
            <div className="prod-queue-row-actions">
              {active && (
                <button
                  onClick={() => act(() => window.cascade.jobsCancel(j.id))}
                  title={j.taskId ? "The provider has already accepted this job and may still finish and bill it; this only stops Cascade tracking it." : "Remove from the queue before it starts"}
                >
                  {j.taskId ? "Stop tracking" : "Cancel"}
                </button>
              )}
              {retryable && <button onClick={() => act(() => window.cascade.jobsRetry(j.id))}>Retry</button>}
              {!active && <button onClick={() => act(() => window.cascade.jobsDismiss(j.id))}>Dismiss</button>}
            </div>
          </div>
        );
      })}
      <div className="prod-queue-footer">
        <span>{queueFooterText(rows)}</span>
        <button disabled={finished.length === 0} onClick={() => finished.forEach((id) => act(() => window.cascade.jobsDismiss(id)))}>
          Clear finished
        </button>
      </div>
    </div>
  );
}
