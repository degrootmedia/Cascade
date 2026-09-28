/**
 * The one "Save this frame" control every video lightbox uses: it reads the
 * paused `currentTime` from the lightbox's `<video>` element and asks main to
 * extract exactly that frame via ffmpeg as a new `Video still_NN` reference.
 * Centralizing it keeps the capture shape identical across surfaces (Design
 * references, storyboard, node graph, moodboard, outdated panels).
 */
import { useState } from "react";
import type { Production } from "../../../../shared/ipc.js";

export function SaveVideoStillButton({
  productionId,
  videoRel,
  getTime,
  onSaved,
  className = "prod-btn",
}: {
  productionId: string;
  /** The clip's workspace-relative path (what main extracts from). */
  videoRel: string;
  /** Reads the paused timestamp — usually `() => videoRef.current?.currentTime ?? 0`. */
  getTime: () => number;
  /** Called with main's updated production (the caller applies it). */
  onSaved: (next: Production) => void;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.cascade.saveVideoStill(productionId, videoRel, getTime());
      onSaved(next);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="prod-still-save" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={className}
        disabled={busy}
        title="Save the paused frame as a new reference image"
        onClick={(e) => { e.stopPropagation(); void save(); }}
      >
        {busy ? "Saving frame…" : "Save this frame"}
      </button>
      {error && <span className="prod-still-error" title={error}>Couldn't save the frame</span>}
    </span>
  );
}
