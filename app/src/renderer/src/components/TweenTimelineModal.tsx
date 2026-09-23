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
import type { CliModelSchema, GenParams, GraphGenItem, OpenArtModelChoice, TweenBlock, VideoModelOptions } from "../../../shared/ipc.js";
import { closestResolution } from "./resolution.js";
import { ModelOptionsForm, type ModelOptionValues } from "./ModelOptionsForm.js";
import { seedModelOptionValues } from "./production/model-param-defaults.js";
import { GenerationCostSuffix } from "./production/generation-cost-label.js";
import { costAspect, isQuotableCostModel } from "./production/generation-cost.js";
import { GenerationMenu, useGenerationMenu } from "./generation-menu.js";

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
 *  schema, or the user's manual allowlist merged in upstream) to accept a
 *  dedicated end-frame slot. Strict: a resolved list (`[]` included) means
 *  ONLY those models are selectable — the submit path must ride the start/end
 *  roles. The full video list shows only while the probe is still pending
 *  (`null`/`undefined`), so the dropdown never strands on first paint. A
 *  saved selection outside the set is dropped; callers resolve the effective
 *  model to the first entry when submitting. */
export function filterTweenModels(
  videoModels: OpenArtModelChoice[],
  endFrameIds: string[] | null | undefined
): OpenArtModelChoice[] {
  if (!endFrameIds) return videoModels;
  const ids = new Set(endFrameIds);
  return videoModels.filter((m) => ids.has(m.id));
}

/** Whether a video model's live duration options cover a tween block length.
 *  Unknown options (null/undefined, or an empty durations list) mean
 *  compatible — the form couldn't be read, so the dropdown must not strand
 *  and blocks must not warn. Otherwise the block length (whole seconds, as
 *  the timeline snaps) must be one of the model's accepted lengths — e.g. a
 *  model with a 4s minimum reports [4,5,…] and a 2s block is incompatible. */
export function tweenSupportsDuration(
  opts: VideoModelOptions | null | undefined,
  durationSec: number
): boolean {
  if (!opts || !Array.isArray(opts.durations) || opts.durations.length === 0) return true;
  return opts.durations.includes(Math.round(durationSec));
}

/** Filter video models to those whose durations cover `requiredSeconds`.
 *  Unknown options (null/undefined, empty durations) pass through — the probe
 *  is pending, so the list must not strand. Otherwise the block length
 *  (rounded, as the timeline snaps) must be an accepted length. */
export function filterTweenModelsByDuration(
  videoModels: OpenArtModelChoice[],
  optsById: Record<string, VideoModelOptions | null | undefined>,
  requiredSeconds: number
): OpenArtModelChoice[] {
  return videoModels.filter((m) => {
    const o = optsById[m.id];
    if (o === undefined || o === null) return true;
    return tweenSupportsDuration(o, requiredSeconds);
  });
}

/** Human-readable summary of a model's accepted lengths ("4–15s" for a
 *  contiguous range, "4, 8s" for discrete picks, "" when unknown). */
export function tweenSupportedLabel(durations: number[] | undefined): string {
  if (!durations?.length) return "";
  const sorted = [...durations].sort((a, b) => a - b);
  let contiguous = sorted.length > 2;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) { contiguous = false; break; }
  }
  if (contiguous) return `${sorted[0]}–${sorted[sorted.length - 1]}s`;
  return `${sorted.join(", ")}s`;
}

function tweenMediaUrl(prodId: string, rel: string): string {
  return `cascade-media://${prodId}/${encodeURIComponent(rel)}`;
}

/** The take a block previews: the explicitly selected generation, or undefined
 *  to show the keyframes. A cleared selection (`genIndex` absent — the
 *  dropdown's "Keyframes" option, or a block that never generated) previews
 *  the keyframes; an out-of-range index also falls back to keyframes. The
 *  stitch input is separate — `tweenSelectedClips` still falls back to the
 *  newest take — so previewing keyframes never un-selects the take. */
export function tweenPreviewTake(block: TweenBlock): GraphGenItem | undefined {
  if (block.genIndex === undefined) return undefined;
  return block.gens?.[block.genIndex];
}

function genLabel(g: GraphGenItem, i: number): string {
  const when = g.at ? new Date(g.at) : null;
  const date = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : "";
  return `Take ${i + 1}${g.model && g.model !== "auto" ? ` · ${g.model}` : ""}${date ? ` · ${date}` : ""}`;
}

function BlockPreview({ prodId, block, keyframes }: { prodId: string; block: TweenBlock; keyframes: TweenKeyframe[] }) {
  const sel = tweenPreviewTake(block);
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
  /** Ordered keyframe source ids (wired on the canvas): reference ids or the
   *  image/edit node sentinels. */
  refIds: string[];
  /** Persisted blocks (prompts, timing, history) — display is derived. */
  blocks: TweenBlock[];
  keyframes: TweenKeyframe[];
  model: string;
  resolution: string;
  videoModels: OpenArtModelChoice[];
  onModelOptions: (model: string, withImage: boolean) => Promise<VideoModelOptions | null>;
  /** The selected model's full option schema (Advanced panel). */
  onModelSchema: (model: string) => Promise<CliModelSchema | null>;
  onModelChange: (model: string) => void;
  onResolutionChange: (resolution: string) => void;
  /** Persisted advanced/variant params (keyed by canonical flag; aspect
   *  ratio lives under `aspect_ratio`). */
  params: GenParams;
  onParamsChange: (params: GenParams) => void;
  /** Persist block edits (prompt, timing, history selection). */
  onBlocksChange: (blocks: TweenBlock[]) => void;
  /** Permanently delete a block's selected take (right-click the take list).
   *  The workspace confirms and blocks takes still feeding the stitch. */
  onDeleteGen?: (rel: string) => void;
  /** Copy a block's selected take into the production as a new reference. */
  onSaveAsRef?: (rel: string) => void;
  /** Generate one block's clip. `model` is the dropdown's CURRENT selection
   *  (effectiveModel) — passed explicitly so the submission can never diverge
   *  from what the user sees selected, even when the persisted pick fell back
   *  to the first listed model. Also rides the block's displayed length (it
   *  can be newer than the last save after a keyframe drag). */
  onRunBlock: (blockId: string, durationSec: number, model: string, params?: GenParams) => Promise<void>;
  busyBlock: string | null;
  /** Stitch every block's selected clip into the continuous shot. */
  onStitch: () => Promise<void>;
  /** Undo the stitch — back to the individual block clips. */
  onUnstitch: () => Promise<void>;
  stitching: boolean;
  stitched: boolean;
  reencoded: boolean;
  /** Media URL of the stitched continuous clip (null when unstitched). When a
   *  stitch exists it is what the preview plays; unstitching returns the
   *  preview to the individual block clips. */
  stitchUrl: string | null;
  /** Pipe the stitched clip into the frame output node. */
  onPipeToOutput: () => void;
  piped: boolean;
  onClose: () => void;
}) {
  const {
    prodId, shotNumber, refIds, blocks, keyframes, model, resolution, videoModels,
    onModelOptions, onModelSchema, onModelChange, onResolutionChange,
    params, onParamsChange, onBlocksChange, onDeleteGen, onSaveAsRef,
    onRunBlock, busyBlock, onStitch, onUnstitch, stitching, stitched, reencoded,
    stitchUrl, onPipeToOutput, piped, onClose,
  } = props;

  const [opts, setOpts] = useState<VideoModelOptions | null>(null);
  const [schema, setSchema] = useState<CliModelSchema | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [drag, setDrag] = useState<{ index: number; t: number } | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const genMenu = useGenerationMenu();

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
    setSchema(null);
    if (model) {
      void onModelOptions(model, true).then((o) => { if (live) setOpts(o); }).catch(() => {});
      void onModelSchema(model).then((s) => {
        if (!live) return;
        setSchema(s);
        // Seed the configured per-surface defaults (a persisted block value wins).
        const seeded = seedModelOptionValues(s, model, "video:tween", params as ModelOptionValues);
        if (seeded !== params) onParamsChange(seeded as GenParams);
      }).catch(() => {});
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, onModelOptions, onModelSchema]);

  // Duration options for EVERY listed model (image-to-video form — the tween
  // always submits start+end frames). The per-model cache in NodeGraphModal
  // makes this cheap; pending entries stay absent so unknown models never
  // ghost or warn until their real options arrive.
  const [allOpts, setAllOpts] = useState<Record<string, VideoModelOptions | null>>({});
  const modelIdsKey = videoModels.map((m) => m.id).join(",");
  useEffect(() => {
    let live = true;
    setAllOpts({});
    const ids = videoModels.map((m) => m.id).filter(Boolean);
    if (!ids.length) return () => { live = false; };
    void Promise.all(ids.map(async (id) => {
      try {
        const o = await onModelOptions(id, true);
        if (live) setAllOpts((prev) => (prev[id] !== undefined ? prev : { ...prev, [id]: o }));
      } catch {
        if (live) setAllOpts((prev) => (prev[id] !== undefined ? prev : { ...prev, [id]: null }));
      }
    }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelIdsKey, onModelOptions]);

  const resolutions = opts?.resolutions?.length ? opts.resolutions : ["480p", "720p", "1080p"];

  // When a different model's options arrive, re-pick the persisted resolution
  // to the closest one the model supports (the timeline persists it, so the
  // stale value must not survive as a phantom dropdown entry).
  useEffect(() => {
    if (opts && resolutions.length && !resolutions.includes(resolution)) {
      onResolutionChange(closestResolution(resolution, resolutions));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts]);

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
  // The model actually driving generation: exactly what the dropdown displays.
  // The list is already filtered to the global provider's end-frame models
  // upstream; when the persisted pick isn't in it (legacy "auto", or saved
  // under a different provider) the dropdown falls back to the first listed
  // model — and `effectiveModel` is what submits, so display and submission
  // can never diverge. Block warnings and dropdown ghosting both key off its
  // live duration options; unknown options (still loading, or an empty
  // durations list) never warn/ghost.
  const effectiveModel = videoModels.some((m) => m.id === model) ? model : (videoModels[0]?.id ?? model);
  const selectedOpts = allOpts[effectiveModel] ?? opts;

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
          <select
            className="prod-openart-select"
            value={videoModels.some((m) => m.id === model) ? model : (videoModels[0]?.id ?? "")}
            onChange={(e) => onModelChange(e.target.value)}
            title="Video model"
            disabled={videoModels.length === 0}
          >
            {videoModels.map((m) => {
              const mo = allOpts[m.id];
              const bad = !!focus && mo !== undefined && !tweenSupportsDuration(mo, focus.durationSec);
              const supported = tweenSupportedLabel(mo?.durations);
              return (
                <option
                  key={m.id}
                  value={m.id}
                  disabled={bad}
                  title={bad ? `${m.description ? `${m.description} — ` : ""}Doesn't support the selected ${focus.durationSec}s block${supported ? ` (supports ${supported})` : ""}.` : m.description}
                >
                  {bad ? `${m.displayName} (no ${focus.durationSec}s)` : m.displayName}
                </option>
              );
            })}
          </select>
          {videoModels.length === 0 && (
            <span className="hint">No end-frame video models available — add ids in Settings → Media generation.</span>
          )}
          <select className="prod-openart-select" value={resolution} onChange={(e) => onResolutionChange(e.target.value)} title="Resolution">
            {resolutions.includes(resolution) ? null : <option value={resolution}>{resolution}</option>}
            {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <ModelOptionsForm
            schema={schema}
            value={params as ModelOptionValues}
            onChange={(next) => onParamsChange(next as GenParams)}
            exclude={["resolution", "duration", "length", "seconds"]}
            compact
            persistKey="cascade.modelOptions.advanced.tween"
          />
          <span className="prod-tween-spacer" />
          {stitched && (
            <span className="prod-tween-stitched" title={reencoded ? "Block codecs differed, so the preview was re-encoded. The assembly package still uses the original clips." : "Lossless stitch — no recompression."}>
              {reencoded ? "Stitched (preview re-encoded)" : "Stitched losslessly"}
            </span>
          )}
          {stitched ? (
            <button className="prod-btn primary" disabled={stitching} onClick={() => { void onUnstitch(); }} title="Undo the stitch — back to the individual block clips so you can view, edit, and re-stitch">
              {stitching ? "Reverting…" : "Undo stitch"}
            </button>
          ) : (
            <button className="prod-btn primary" disabled={stitching || !display.length || ready < display.length} onClick={() => { void onStitch(); }} title={ready < display.length ? "Generate every action block first" : "Stitch the selected clips into one continuous shot"}>
              {stitching ? "Stitching…" : "Stitch continuous shot"}
            </button>
          )}
          {stitched && !piped && (
            <button className="prod-btn" onClick={onPipeToOutput} title="Feed the stitched clip into the frame output node">
              Pipe to output
            </button>
          )}
        </div>

        <div className="prod-tween-preview">
          {stitched && stitchUrl ? (
            <video
              key={stitchUrl}
              className="prod-tween-preview-video"
              src={stitchUrl}
              controls
              loop
              playsInline
              preload="metadata"
              title="Stitched continuous shot — undo the stitch to preview individual blocks"
            />
          ) : focus
            ? <BlockPreview prodId={prodId} block={focus} keyframes={keyframes} />
            : <div className="prod-tween-preview-empty">Wire 2–5 keyframes (references or generated frames) into the in-betweener node to start a timeline.</div>}
        </div>

        {display.length > 0 && (
          <div className="prod-tween-track" ref={trackRef}>
            {display.map((b, i) => {
              const left = (b.startSec / TWEEN_MAX_TOTAL_SEC) * 100;
              const width = (b.durationSec / TWEEN_MAX_TOTAL_SEC) * 100;
              const start = keyframes.find((k) => k.id === b.startRefId);
              const sel = tweenPreviewTake(b);
              const badLength = !tweenSupportsDuration(selectedOpts, b.durationSec);
              const supported = tweenSupportedLabel(selectedOpts?.durations);
              // Per-block compatible set: end-frame list already applied
              // upstream; here filter by this block's duration. Pending probes
              // (null/undefined) pass through as "checking compatibility".
              const compatible = filterTweenModelsByDuration(videoModels, allOpts, b.durationSec);
              const probePending = videoModels.some((m) => allOpts[m.id] === undefined);
              const noneFit = !probePending && videoModels.length > 0 && compatible.length === 0;
              const blocked = badLength || noneFit;
              return (
                <div
                  key={b.id}
                  className={"prod-tween-block" + (focus?.id === b.id ? " focus" : "")}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  onClick={() => setFocusId(b.id)}
                  onContextMenu={(e) => { if (sel) genMenu.open(e, sel.path, { src: tweenMediaUrl(prodId, sel.path), media: "video" }); }}
                  title={`${start?.name ?? ""} → ${keyframes.find((k) => k.id === b.endRefId)?.name ?? ""} · ${b.durationSec}s`}
                >
                  <div className="prod-tween-block-label">{b.startSec.toFixed(0)}s → {(b.startSec + b.durationSec).toFixed(0)}s</div>
                  {probePending && (
                    <div className="prod-tween-block-warn" title="Duration options are still loading.">
                      Checking compatibility…
                    </div>
                  )}
                  {noneFit && (
                    <div
                      className="prod-tween-block-warn"
                      title={`No listed model supports a ${b.durationSec}s block — retime the block or pick another model.`}
                    >
                      {`No model supports a ${b.durationSec}s block.`}
                    </div>
                  )}
                  {badLength && !noneFit && (
                    <div
                      className="prod-tween-block-warn"
                      title={`The chosen model supports ${supported || "other lengths"} — retime the block or pick another model.`}
                    >
                      The chosen model doesn't support this block length.
                    </div>
                  )}
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
                      disabled={busyBlock !== null || !(drafts[b.id] ?? b.prompt).trim() || blocked}
                      onClick={() => { setFocusId(b.id); saveDraft(b.id); void onRunBlock(b.id, b.durationSec, effectiveModel, params); }}
                      title={noneFit ? `No model supports a ${b.durationSec}s block. Retime the block or pick another model.` : badLength ? `The chosen model doesn't support a ${b.durationSec}s block${supported ? ` — it supports ${supported}` : ""}. Retime the block or pick another model.` : "Generate this block's in-between clip"}
                    >
                      {busyBlock === b.id ? "Generating…" : <>Submit block<GenerationCostSuffix req={isQuotableCostModel(effectiveModel) ? {
                        model: effectiveModel, kind: "video", resolution, durationSec: b.durationSec,
                        aspectRatio: costAspect(params), ...(Object.keys(params).length ? { params: { ...params } } : {}),
                      } : null} /></>}
                    </button>
                    <select
                      className="prod-openart-select prod-tween-takes"
                      value={sel ? String(b.genIndex ?? 0) : "key"}
                      onChange={(e) => {
                        const v = e.target.value;
                        onBlocksChange(display.map((x) => (x.id === b.id ? { ...x, genIndex: v === "key" ? undefined : Number(v) } : x)));
                      }}
                      onContextMenu={(e) => {
                        if (sel) genMenu.open(e, sel.path, { src: tweenMediaUrl(prodId, sel.path), media: "video" });
                      }}
                      title="View a previous generation, or the original keyframes (right-click for the selected take's options)"
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
          <div className="prod-tween-empty">Connect 2–5 keyframes — reference images, the image node's frame, or the edit node's output — to the in-betweener node's sockets, then reopen the timeline.</div>
        )}
      </div>
      <GenerationMenu menu={genMenu.menu} onClose={genMenu.close} onSaveAsReference={onSaveAsRef} onDelete={onDeleteGen} />
    </div>
  );
});
