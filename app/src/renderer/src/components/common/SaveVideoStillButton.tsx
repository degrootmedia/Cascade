/**
 * The one "Save this frame" control every video lightbox uses: it reads the
 * paused `currentTime` from the lightbox's `<video>` element and asks main to
 * extract exactly that frame via ffmpeg as a new reference (named and
 * categorized in the save popup, defaulting to `Video still_001`).
 * Centralizing it keeps the capture shape identical across surfaces (Design
 * references, storyboard, node graph, moodboard, outdated panels).
 */
import { useState } from "react";
import type { Production } from "../../../../shared/ipc.js";
import { askReferenceSave } from "../NamePromptDialog.js";
import { nextNumberedRefName } from "../../../../shared/ref-names.js";

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
      // Capture the paused frame's timestamp before the popup opens, then
      // let the user name + categorize the still. The production is loaded
      // fresh for its categories/existing names; cancelling saves nothing.
      const timeSec = getTime();
      let categories: { id: string; name: string }[] = [];
      let existingNames: string[] = [];
      try {
        const prod = typeof window.cascade.loadProduction === "function" ? await window.cascade.loadProduction(productionId) : null;
        if (prod) {
          categories = prod.referenceCategories ?? [];
          existingNames = (prod.references ?? []).map((r) => r.name);
        }
      } catch { /* prompt with Uncategorized only; main de-duplicates */ }
      const choice = await askReferenceSave({
        title: "Save this frame as reference",
        label: "This name is how prompts cite the reference (@[name]).",
        confirmLabel: "Save reference",
        initialName: nextNumberedRefName(existingNames, "Video still"),
        categories,
      });
      if (!choice) return;
      const next = await window.cascade.saveVideoStill(productionId, videoRel, timeSec, choice);
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
