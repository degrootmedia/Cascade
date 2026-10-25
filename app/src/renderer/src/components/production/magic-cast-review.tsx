/**
 * Cast & Sets review (Magic Prompt stage 1.5): after the Story Bible is
 * built and BEFORE prompts are written, the user confirms what depicts
 * each character, environment, and prop the script needs. Every row says
 * in plain language what is needed, for which shots, what is mapped, and
 * why. Resumable: decisions persist main-side (`magicRefDecisions`), so
 * closing this modal (or the app) loses nothing; "Create in Image Suite"
 * marks the need pending and hands off to the suite.
 */
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Production } from "../../../../shared/ipc.js";
import { isMagicCitablePurpose, magicCastNeeds, magicRefRoster, type MagicCastNeed, type MagicRefRosterEntry } from "../../../../shared/magic-refs.js";
import { allPromptRefs } from "./references.js";

const KIND_LABEL: Record<string, string> = {
  character: "Character", product: "Product", location: "Environment", prop: "Prop", other: "Other",
};
const GROUP_ORDER = ["character", "location", "product", "prop", "other"] as const;
const GROUP_LABEL: Record<string, string> = {
  character: "Characters", location: "Environments & sets", product: "Products", prop: "Props", other: "Other",
};

function shotSummary(numbers: string[]): string {
  if (!numbers.length) return "no shots yet";
  const shown = numbers.slice(0, 4).join(", ");
  return `${numbers.length} shot${numbers.length === 1 ? "" : "s"} (${shown}${numbers.length > 4 ? ", …" : ""})`;
}

function statusLine(need: MagicCastNeed): string {
  if (need.status === "text-only") return "Text only — no reference will upload.";
  if (need.status === "pending-create") return "To create — finish it in the Image Suite, then it maps automatically.";
  if (need.status === "unmapped") return "No reference matched. Map one of yours, create it, or mark text-only.";
  if (need.purposeWarning) return need.purposeWarning;
  const by = need.boundBy === "user" ? "you mapped this" : need.boundBy === "auto" ? "auto-matched" : "model matched";
  return `Using ${need.refNames.map((n) => `@[${n}]`).join(", ")} — ${need.bindReason ?? by}${need.confidence ? ` · ${need.confidence} confidence` : ""}.`;
}

export function MagicCastReview({ prod, busy, onMap, onTextOnly, onCreateInSuite, onClose, onWrite }: {
  prod: Production;
  /** Entity name currently being saved (disables its row). */
  busy: string | null;
  onMap: (entityName: string, refIds: string[]) => void;
  onTextOnly: (entityName: string) => void;
  onCreateInSuite: (need: MagicCastNeed) => void;
  onClose: () => void;
  onWrite: () => void;
}) {
  const needs = useMemo(() => magicCastNeeds(prod), [prod]);
  const roster = useMemo(() => magicRefRoster(prod), [prod]);
  const thumbs = useMemo(() => new Map(allPromptRefs(prod).map((r) => [r.id, r.artwork])), [prod]);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  /** Multi-select draft per entity while its picker is open (ref ids). */
  const [draftPicks, setDraftPicks] = useState<Record<string, string[]>>({});
  const [showReady, setShowReady] = useState(false);
  const rosterByName = useMemo(() => new Map(roster.map((e) => [e.name, e])), [roster]);
  const reviewCount = needs.filter((n) => n.status === "review" || n.status === "unmapped" || n.status === "pending-create").length;
  const ready = needs.filter((n) => n.status === "ready" || n.status === "text-only");
  const pending = needs.filter((n) => n.status !== "ready" && n.status !== "text-only");

  const candidatesFor = (need: MagicCastNeed): MagicRefRosterEntry[] => {
    const wantedPurpose = need.kind === "location" ? "environment" : "subject";
    return roster
      .filter((e) => isMagicCitablePurpose(e.purpose))
      .sort((a, b) => Number(b.purpose === wantedPurpose) - Number(a.purpose === wantedPurpose) || a.name.localeCompare(b.name));
  };
  const notCastable = roster.filter((e) => !isMagicCitablePurpose(e.purpose));

  const openPicker = (need: MagicCastNeed, mappedIds: string[]): void => {
    if (pickerFor === need.entityName) { setPickerFor(null); return; }
    setPickerFor(need.entityName);
    setDraftPicks((prev) => ({ ...prev, [need.entityName]: mappedIds }));
  };
  const togglePick = (entityName: string, id: string): void => {
    setDraftPicks((prev) => {
      const cur = prev[entityName] ?? [];
      return { ...prev, [entityName]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
    });
  };

  const row = (need: MagicCastNeed) => {
    const mapped = need.refNames.map((n) => rosterByName.get(n)).filter(Boolean) as MagicRefRosterEntry[];
    const isBusy = busy === need.entityName;
    const draft = draftPicks[need.entityName] ?? mapped.map((e) => e.id);
    const draftChanged = draft.length !== mapped.length || draft.some((id) => !mapped.some((e) => e.id === id));
    return (
      <div className="prod-cast-row" key={need.entityName}>
        <div className="prod-cast-main">
          <div className="prod-cast-title">
            <strong>{need.entityName}</strong>
            <span className="prod-cast-kind">{KIND_LABEL[need.kind]}</span>
            <small>{shotSummary(need.shotNumbers)}</small>
          </div>
          {need.descriptor && <div className="prod-cast-desc">{need.descriptor}</div>}
          <div className={"prod-cast-status" + (need.status === "ready" || need.status === "text-only" ? " ok" : "")}>{statusLine(need)}</div>
          {mapped.length > 0 && pickerFor !== need.entityName && (
            <div className="prod-cast-chips">
              {mapped.map((e) => (
                <span key={e.id} className="prod-cast-chip">
                  @[{e.name}]
                  <button disabled={isBusy} title={`Remove @[${e.name}] from ${need.entityName}`} onClick={() => onMap(need.entityName, mapped.filter((x) => x.id !== e.id).map((x) => x.id))}>×</button>
                </span>
              ))}
            </div>
          )}
          {pickerFor === need.entityName && (
            <div className="prod-cast-picker">
              <div className="prod-cast-picker-hint">Select one or more references — a group (heroes, a gang, a team) can use several at once.</div>
              <div className="prod-cast-picker-grid">
                {candidatesFor(need).map((c) => {
                  const selectedPick = draft.includes(c.id);
                  return (
                    <button key={c.id} className={"prod-cast-candidate" + (selectedPick ? " selected" : "")} disabled={isBusy} aria-pressed={selectedPick} onClick={() => togglePick(need.entityName, c.id)} title={c.descriptor || c.name}>
                      {thumbs.get(c.id) ? <img src={thumbs.get(c.id)} alt="" /> : <span className="prod-cast-candidate-blank">＋</span>}
                      <span>{selectedPick ? "✓ " : ""}@[{c.name}]</span>
                      <small>{c.purpose}{c.purposeInferred ? " (auto)" : ""}{c.descriptor ? ` — ${c.descriptor}` : ""}</small>
                    </button>
                  );
                })}
              </div>
              {!candidatesFor(need).length && <span className="hint">No castable references yet — create one.</span>}
              <div className="prod-cast-picker-actions">
                <button className="prod-btn" disabled={isBusy || !draftChanged} onClick={() => { setPickerFor(null); onMap(need.entityName, draft); }}>
                  {draft.length ? `Use selected (${draft.length})` : "Unmap all"}
                </button>
                <button className="prod-btn ghost" disabled={isBusy} onClick={() => setPickerFor(null)}>Cancel</button>
              </div>
              {notCastable.length > 0 && (
                <div className="prod-cast-notcastable">
                  Not castable (style/layout/inspiration): {notCastable.map((e) => `${e.name} (${e.purpose})`).join(", ")}. Change a reference's purpose in Step 2 to use it here.
                </div>
              )}
            </div>
          )}
        </div>
        <div className="prod-cast-side">
          {mapped.slice(0, 4).map((e) => (
            thumbs.get(e.id)
              ? <img key={e.id} className="prod-cast-thumb" src={thumbs.get(e.id)} alt={e.name} title={`@[${e.name}]`} />
              : <span key={e.id} className="prod-cast-thumb-blank" title={`@[${e.name}] (no image yet)`}>?</span>
          ))}
          <div className="prod-cast-actions">
            {need.status !== "ready" && need.status !== "text-only" && need.refNames.length > 0 && !need.purposeWarning && (
              <button className="prod-btn" disabled={isBusy} onClick={() => onMap(need.entityName, mapped.map((e) => e.id))}>Looks right</button>
            )}
            <button className="prod-btn" disabled={isBusy} onClick={() => openPicker(need, mapped.map((e) => e.id))}>
              {need.refNames.length ? "Add / change references" : "Use my reference"}
            </button>
            <button className="prod-btn" disabled={isBusy} onClick={() => onCreateInSuite(need)}>Create in Image Suite</button>
            {need.status !== "text-only" && (
              <button className="prod-btn ghost" disabled={isBusy} onClick={() => onTextOnly(need.entityName)}>Text only</button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return createPortal(
    <div className="modal-backdrop top-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal prod-cast-modal" role="dialog" aria-modal="true" aria-label="Cast and sets review">
        <h3>Cast &amp; sets for {prod.meta.name}</h3>
        <p className="hint">
          Magic read the whole script and worked out who and what appears. Confirm what depicts each one —
          prompts are written only after this, and you can leave and come back anytime (Step 3 → Cast &amp; sets).
        </p>
        {prod.magicBible?.worldPremise && <p className="prod-cast-premise"><strong>World:</strong> {prod.magicBible.worldPremise}</p>}
        <div className="prod-cast-list">
          {pending.length === 0 && <p className="hint">Everything is mapped. You're ready to write prompts.</p>}
          {GROUP_ORDER.map((g) => {
            const rows = pending.filter((n) => n.kind === g);
            if (!rows.length) return null;
            return (
              <section key={g}>
                <h4 className="prod-cast-group">{GROUP_LABEL[g]}</h4>
                {rows.map(row)}
              </section>
            );
          })}
          {ready.length > 0 && (
            <section>
              <button className="prod-cast-ready-toggle" onClick={() => setShowReady((v) => !v)}>
                {showReady ? "▾" : "▸"} Ready ({ready.length})
              </button>
              {showReady && ready.map(row)}
            </section>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Review later</button>
          <button type="button" className="primary" onClick={onWrite}>
            Write prompts{reviewCount ? ` (${reviewCount} unreviewed — text only where unmapped)` : ""}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
