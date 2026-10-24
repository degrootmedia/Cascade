/**
 * Magic Prompt reconciliation queue (Step 3): cited `@[Name]` tags in the
 * generated prompts that match no reference the user owns. For each one the
 * user can slot in their own reference (Assign — saves the cited name as an
 * alias on it and canonicalizes the tags, main-side), create a new empty
 * reference under the cited name, or dismiss it as a plain noun. Purely a
 * view over `computeUnresolvedMagicRefs`; all mutations are host callbacks.
 */
import { useState } from "react";
import type { Production } from "../../../../shared/ipc.js";
import { computeUnresolvedMagicRefs, magicRefRoster } from "../../../../shared/magic-refs.js";

export function MagicReconcileQueue({ prod, busy, onAssign, onCreate, onDismiss }: {
  prod: Production;
  /** Cited name currently being assigned/created (disables that row). */
  busy: string | null;
  onAssign: (citedName: string, refId: string) => void;
  onCreate: (citedName: string) => void;
  onDismiss: (citedName: string) => void;
}) {
  const unresolved = computeUnresolvedMagicRefs(prod);
  const roster = magicRefRoster(prod).filter((e) => !e.styleOnly);
  const [picks, setPicks] = useState<Record<string, string>>({});
  if (!unresolved.length) return null;

  const pickFor = (citedName: string, suggested?: string): string => {
    if (picks[citedName]) return picks[citedName];
    const suggestedId = suggested ? roster.find((e) => e.name === suggested)?.id : undefined;
    return suggestedId ?? roster[0]?.id ?? "";
  };

  return (
    <div className="prod-magic-reconcile" role="group" aria-label="Unmatched Magic Prompt references">
      <div className="prod-magic-reconcile-head">
        <strong>Unmatched references in Magic Prompts</strong>
        <span className="hint">
          These names came from the script/model and don&apos;t match any of your references, so no image
          will upload for them. Slot in your own reference, create one, or dismiss as plain text.
        </span>
      </div>
      {unresolved.map((u) => (
        <div className="prod-magic-reconcile-row" key={u.citedName}>
          <span className="prod-magic-reconcile-name">
            <code>@[{u.citedName}]</code>
            <small>shots {u.shotNumbers.join(", ")}</small>
          </span>
          {roster.length > 0 && (
            <>
              <select
                className="prod-magic-reconcile-select"
                value={pickFor(u.citedName, u.suggestedRefName)}
                disabled={busy === u.citedName}
                onChange={(e) => setPicks((prev) => ({ ...prev, [u.citedName]: e.target.value }))}
                title="Your reference that this name means"
              >
                {roster.map((e) => (
                  <option key={e.id} value={e.id}>@[{e.name}] ({e.kind})</option>
                ))}
              </select>
              <button
                className="prod-btn"
                disabled={busy === u.citedName}
                onClick={() => onAssign(u.citedName, pickFor(u.citedName, u.suggestedRefName))}
                title="Save this name as an alias on the chosen reference and rewrite the tags to match"
              >
                {busy === u.citedName ? "…" : "Use my reference"}
              </button>
            </>
          )}
          <button
            className="prod-btn"
            disabled={busy === u.citedName}
            onClick={() => onCreate(u.citedName)}
            title="Create a new empty reference under this exact name (attach its image in Step 2)"
          >
            Create reference
          </button>
          <button
            className="prod-btn prod-magic-reconcile-dismiss"
            disabled={busy === u.citedName}
            onClick={() => onDismiss(u.citedName)}
            title="Not a reference — stop asking about this name"
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
