/**
 * In-betweener timeline (styleframe.ai-like): keyframes on a 1s grid with
 * action prompts between them. One action block = 1 start keyframe + 1 end
 * keyframe + 1 action prompt, submitted as a start→end video generation.
 * The selected clip per block stitches into one continuous shot for the
 * frame output node.
 *
 * Timing source of truth: `blocks` (persisted on the shot) + `refIds` order.
 * Display blocks are derived here via `deriveTweenBlocksClient` — a renderer
 * mirror of the canonical `deriveTweenBlocks` in `app/src/main/pipeline.ts`
 * (pair-key preservation, 1–15s gaps, 15s total cap). The main process
 * re-derives authoritatively on every generate/stitch, so this mirror only
 * needs to stay visually correct, never to persist novel shapes.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { GraphGenItem, OpenArtModelChoice, TweenBlock, VideoModelOptions } from "../../../shared/ipc.js";

export const TWEEN_MIN_REFS = 2;
export const TWEEN_MAX_REFS = 5;
export const TWEEN_MIN_GAP_SEC = 1;
export const TWEEN_MAX_GAP_SEC = 15;
export const TWEEN_MAX_TOTAL_SEC = 15;

const snapSec = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const clampGap = (v: number): number => Math.max(TWEEN_MIN_GAP_SEC, Math.min(TWEEN_MAX_GAP_SEC, snapSec(v)));

/** Renderer mirror of `deriveTweenBlocks` (see pipeline.ts — the canonical
 *  implementation). Matches blocks by `startRefId→endRefId` so prompts,
 *  timing, and per-block history survive keyframe reordering. */
export function deriveTweenBlocksClient(refIds: string[], prev: TweenBlock[] = []): TweenBlock[] {
  const ids = (Array.isArray(refIds) ? refIds : []).filter((r) => typeof r === "string" && r);
  if (ids.length < TWEEN_MIN_REFS) return [];
  const byPair = new Map(prev.map((b) => [`${b.startRefId}→${b.endRefId}`, b]));
  const blocks: TweenBlock[] = [];
  let t = 0;
  for (let i = 0; i + 1 < ids.length; i++) {
    if (t >= TWEEN_MAX_TOTAL_SEC) break;
    const prevBlock = byPair.get(`${ids[i]}→${ids[i + 1]}`);
    const prevDur = prevBlock && Number.isFinite(prevBlock.durationSec) ? prevBlock.durationSec : undefined;
    const dur = Math.min(clampGap(prevDur ?? 2), TWEEN_MAX_TOTAL_SEC - t);
    if (dur < TWEEN_MIN_GAP_SEC) break;
    blocks.push({
      id: `tw${i}`,
      startRefId: ids[i],
      endRefId: ids[i + 1],
      prompt: prevBlock?.prompt ?? "",
      startSec: t,
      durationSec: dur,
      gens: prevBlock?.gens,
      genIndex: prevBlock?.genIndex,
    });
    t += dur;
  }
  return blocks;
}

/** Move keyframe `index` to time `t`: reshapes the two adjacent blocks (or the
 *  single trailing block for the last keyframe), clamped so gaps stay ≥1s and
 *  the total stays ≤15s. Index 0 is pinned at 0s. Pure — shared by the live
 *  drag overlay and the drop commit. */
export function applyKeyframeDrag(base: TweenBlock[], index: number, t: number): TweenBlock[] {
  if (index <= 0 || !base.length) return base;
  const ts: number[] = [];
  let acc = 0;
  for (const b of base) { ts.push(acc); acc += b.durationSec; }
  ts.push(acc); // the last keyframe rides the timeline total
  if (index >= ts.length) return base;
  const prev = ts[index - 1];
  // A middle keyframe must keep 1s from its right neighbor; the last one is
  // bounded only by the 15s timeline cap.
  const hasNext = index + 1 < ts.length;
  let nt = Math.max(prev + TWEEN_MIN_GAP_SEC, snapSec(t));
  if (hasNext) nt = Math.min(nt, ts[index + 1] - TWEEN_MIN_GAP_SEC);
  nt = Math.min(nt, TWEEN_MAX_TOTAL_SEC);
  const right = hasNext ? ts[index + 1] : TWEEN_MAX_TOTAL_SEC;
  return base.map((b, bi) => {
    if (bi === index - 1) return { ...b, durationSec: nt - prev };
    if (bi === index) return { ...b, startSec: nt, durationSec: right - nt };
    return b;
  });
}

export interface TweenKeyframe {
  id: string;
  name: string;
  artwork: string;
}

/** Limit the tween model lists to the models proven (via their live form
 *  schema) to accept a dedicated end-frame slot. Auto is never filtered —
 *  the submit path prefers end-frame models for it automatically. When
 *  nothing is proven (`null`/empty — forms unreadable or still warming), the
 *  full video list is kept so the dropdown never strands the user; the saved
 *  selection is always kept so a re-filter can't orphan it. */
export function filterTweenModels(
  videoModels: OpenArtModelChoice[],
  endFrameIds: string[] | null | undefined,
  savedModelId?: string
): OpenArtModelChoice[] {
  if (!endFrameIds?.length) return videoModels;
  const ids = new Set(endFrameIds);
  const out = videoModels.filter((m) => ids.has(m.id));
  if (savedModelId && savedModelId !== "auto" && !out.some((m) => m.id === savedModelId)) {
    const saved = videoModels.find((m) => m.id === savedModelId);
    if (saved) out.push(saved);
  }
  return out.length ? out : videoModels;
}

function tweenMediaUrl(prodId: string, rel: string): string {
  return `cascade-media://${prodId}/${encodeURIComponent(rel)}`;
}

function genLabel(g: GraphGenItem, i: number): string {
  const when = g.at ? new Date(g.at) : null;
  const date = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : "";
  return `Take ${i + 1}${g.model && g.model !== "auto" ? ` · ${g.model}` : ""}${date ? ` · ${date}` : ""}`;
}

function BlockPreview({ prodId, block, keyframes }: { prodId: string; block: TweenBlock; keyframes: TweenKeyframe[] }) {
  const sel = block.gens?.[block.genIndex ?? 0];
  const start = keyframes.find((k) => k.id === block.startRefId);
  const end = keyframes.find((k) => k.id === block.endRefId);
  if (sel?.path) {
    return (
      <video
        key={sel.path}
        className="prod-tween-preview-video"
        src={tweenMediaUrl(prodId, sel.path)}
        controls
        loop
        playsInline
        preload="metadata"
        title={sel.prompt || "Generated in-between"}
      />
    );
  }
  return (
    <div className="prod-tween-preview-keys">
      {start && <img src={start.artwork} alt={start.name} draggable={false} title={`Start: ${start.name}`} />}
      <span className="prod-tween-preview-arrow" title="No clip yet — showing keyframes">→</span>
      {end && <img src={end.artwork} alt={end.name} draggable={false} title={`End: ${end.name}`} />}
    </div>
  );
}

export const TweenTimelineModal = memo(function TweenTimelineModal(props: {
  prodId: string;
  shotNumber: string;
  /** Ordered keyframe ref ids (wired on the canvas). */
  refIds: string[];
  /** Persisted blocks (prompts, timing, history) — display is derived. */
  blocks: TweenBlock[];
  keyframes: TweenKeyframe[];
  model: string;
  resolution: string;
  videoModels: OpenArtModelChoice[];
  onModelOptions: (model: string, withImage: boolean) => Promise<VideoModelOptions | null>;
  onModelChange: (model: string) => void;
  onResolutionChange: (resolution: string) => void;
  /** Persist block edits (prompt, timing, history selection). */
  onBlocksChange: (blocks: TweenBlock[]) => void;
  /** Generate one block's clip (uses the persisted model/resolution). */
  onRunBlock: (blockId: string) => Promise<void>;
  busyBlock: string | null;
  /** Stitch every block's selected clip into the continuous shot. */
  onStitch: () => Promise<void>;
  stitching: boolean;
  stitched: boolean;
  reencoded: boolean;
  /** Pipe the stitched clip into the frame output node. */
  onPipeToOutput: () => void;
  piped: boolean;
  onClose: () => void;
}) {
  const {
    prodId, shotNumber, refIds, blocks, keyframes, model, resolution, videoModels,
    onModelOptions, onModelChange, onResolutionChange, onBlocksChange,
    onRunBlock, busyBlock, onStitch, stitching, stitched, reencoded,
    onPipeToOutput, piped, onClose,
  } = props;

  const [opts, setOpts] = useState<VideoModelOptions | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [drag, setDrag] = useState<{ index: number; t: number } | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  // Escape closes the timeline (the graph owns Escape otherwise — it yields
  // when this overlay is present).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    setOpts(null);
    if (model && model !== "auto") void onModelOptions(model, true).then((o) => { if (live) setOpts(o); }).catch(() => {});
    return () => { live = false; };
  }, [model, onModelOptions]);

  const resolutions = opts?.resolutions?.length ? opts.resolutions : ["480p", "720p", "1080p"];

  // Display blocks: derived from the wired order every render (instant even
  // before the save round-trip persists them), overlaid with the active drag.
  const display = useMemo(() => {
    const base = deriveTweenBlocksClient(refIds, blocks);
    if (!drag) return base;
    return applyKeyframeDrag(base, drag.index, drag.t);
  }, [refIds, blocks, drag]);

  const total = display.length ? display[display.length - 1].startSec + display[display.length - 1].durationSec : 0;
  const focus = display.find((b) => b.id === focusId) ?? display[0];
  const ready = display.filter((b) => b.gens?.[b.genIndex ?? 0]?.path).length;

  const keyTime = (id: string): number => {
    const i = refIds.indexOf(id);
    if (i <= 0) return 0;
    const b = display[i - 1];
    return b ? b.startSec + b.durationSec : 0;
  };

  const commitDrag = (index: number, t: number) => {
    if (index <= 0) return;
    onBlocksChange(applyKeyframeDrag(deriveTweenBlocksClient(refIds, blocks), index, t));
  };

  const onThumbPointerDown = (e: React.PointerEvent, index: number) => {
    if (index <= 0) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const move = (x: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      setDrag({ index, t: snapSec(((x - rect.left) / rect.width) * TWEEN_MAX_TOTAL_SEC) });
    };
    move(e.clientX);
    const up = (ev: PointerEvent) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (rect && rect.width > 0) commitDrag(index, ((ev.clientX - rect.left) / rect.width) * TWEEN_MAX_TOTAL_SEC);
      setDrag(null);
      window.removeEventListener("pointermove", moveListener);
      window.removeEventListener("pointerup", up);
    };
    const moveListener = (ev: PointerEvent) => move(ev.clientX);
    window.addEventListener("pointermove", moveListener);
    window.addEventListener("pointerup", up);
  };

  const saveDraft = (blockId: string) => {
    const draft = drafts[blockId];
    if (draft === undefined) return;
    const cur = display.find((b) => b.id === blockId);
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
    if (cur && draft.trim() !== cur.prompt) {
      onBlocksChange(display.map((b) => (b.id === blockId ? { ...b, prompt: draft } : b)));
    }
  };

  return (
    <div className="prod-tween-overlay" onClick={onClose}>
      <div className="prod-tween-panel" onClick={(e) => e.stopPropagation()}>
        <div className="prod-tween-head">
          <span className="prod-tween-title">Shot {shotNumber} — in-between timeline</span>
          <span className="prod-tween-total">{total.toFixed(0)}s / {TWEEN_MAX_TOTAL_SEC}s · {ready}/{display.length} blocks ready</span>
          <button className="prod-btn" onClick={onClose}>Close</button>
        </div>

        <div className="prod-tween-controls">
          <select className="prod-openart-select" value={model} onChange={(e) => onModelChange(e.target.value)} title="OpenArt video model">
            <option value="auto">Auto</option>
            {videoModels.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>)}
          </select>
          <select className="prod-openart-select" value={resolution} onChange={(e) => onResolutionChange(e.target.value)} title="Resolution">
            {resolutions.includes(resolution) ? null : <option value={resolution}>{resolution}</option>}
            {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <span className="prod-tween-spacer" />
          {stitched && (
            <span className="prod-tween-stitched" title={reencoded ? "Block codecs differed, so the preview was re-encoded. The assembly package still uses the original clips." : "Lossless stitch — no recompression."}>
              {reencoded ? "Stitched (preview re-encoded)" : "Stitched losslessly"}
            </span>
          )}
          <button className="prod-btn primary" disabled={stitching || !display.length || ready < display.length} onClick={() => { void onStitch(); }} title={ready < display.length ? "Generate every action block first" : "Stitch the selected clips into one continuous shot"}>
            {stitching ? "Stitching…" : "Stitch continuous shot"}
          </button>
          {stitched && !piped && (
            <button className="prod-btn" onClick={onPipeToOutput} title="Feed the stitched clip into the frame output node">
              Pipe to output
            </button>
          )}
        </div>

        <div className="prod-tween-preview">
          {focus
            ? <BlockPreview prodId={prodId} block={focus} keyframes={keyframes} />
            : <div className="prod-tween-preview-empty">Wire 2–5 keyframes into the in-betweener node to start a timeline.</div>}
        </div>

        {display.length > 0 && (
          <div className="prod-tween-track" ref={trackRef}>
            {display.map((b, i) => {
              const left = (b.startSec / TWEEN_MAX_TOTAL_SEC) * 100;
              const width = (b.durationSec / TWEEN_MAX_TOTAL_SEC) * 100;
              const start = keyframes.find((k) => k.id === b.startRefId);
              const sel = b.gens?.[b.genIndex ?? 0];
              return (
                <div
                  key={b.id}
                  className={"prod-tween-block" + (focus?.id === b.id ? " focus" : "")}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  onClick={() => setFocusId(b.id)}
                  title={`${start?.name ?? ""} → ${keyframes.find((k) => k.id === b.endRefId)?.name ?? ""} · ${b.durationSec}s`}
                >
                  <div className="prod-tween-block-label">{b.startSec.toFixed(0)}s → {(b.startSec + b.durationSec).toFixed(0)}s</div>
                  <textarea
                    className="prod-tween-prompt"
                    placeholder="Action leading to the next frame…"
                    value={drafts[b.id] ?? b.prompt}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [b.id]: e.target.value }))}
                    onBlur={() => saveDraft(b.id)}
                    onClick={(e) => e.stopPropagation()}
                    rows={2}
                  />
                  <div className="prod-tween-block-row" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="prod-btn primary prod-tween-go"
                      disabled={busyBlock !== null || !(drafts[b.id] ?? b.prompt).trim()}
                      onClick={() => { saveDraft(b.id); void onRunBlock(b.id); }}
                      title="Generate this block's in-between clip"
                    >
                      {busyBlock === b.id ? "Generating…" : "Submit block"}
                    </button>
                    <select
                      className="prod-openart-select prod-tween-takes"
                      value={sel ? String(b.genIndex ?? 0) : "key"}
                      onChange={(e) => {
                        const v = e.target.value;
                        onBlocksChange(display.map((x) => (x.id === b.id ? { ...x, genIndex: v === "key" ? undefined : Number(v) } : x)));
                      }}
                      title="View a previous generation, or the original keyframes"
                    >
                      <option value="key">Keyframes</option>
                      {(b.gens ?? []).map((g, gi) => (
                        <option key={gi} value={String(gi)}>{genLabel(g, gi)}</option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
            {refIds.map((id, i) => {
              const k = keyframes.find((x) => x.id === id);
              if (!k) return null;
              const t = keyTime(id);
              return (
                <div
                  key={id}
                  className={"prod-tween-key" + (i === 0 ? " first" : "")}
                  style={{ left: `calc(${(t / TWEEN_MAX_TOTAL_SEC) * 100}% - 22px)` }}
                  onPointerDown={(e) => onThumbPointerDown(e, i)}
                  title={i === 0 ? `${k.name} ( pinned at 0s)` : `Drag to retime — ${k.name}`}
                >
                  <img src={k.artwork} alt={k.name} draggable={false} />
                  <span>{t.toFixed(0)}s</span>
                </div>
              );
            })}
          </div>
        )}
        {display.length === 0 && (
          <div className="prod-tween-empty">Connect 2–5 reference images to the in-betweener node's keyframe sockets, then reopen the timeline.</div>
        )}
      </div>
    </div>
  );
});
