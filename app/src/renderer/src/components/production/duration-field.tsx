/**
 * Clip-length dropdown shared by every video generation surface (the board
 * video panel, the node-graph video node, the edit-video node).
 *
 * Two model shapes exist: a CLOSED set of lengths (offered verbatim) and
 * an OPEN integer length (any whole seconds — expanded here into one
 * dropdown option per second across the model's range). Before a model's
 * live options arrive the closed fallback ladder shows; the snap helpers
 * only ever validate against REAL options, never the fallback, so a saved
 * off-ladder value (e.g. 7s on an open model) is never silently reset.
 */
import type { VideoModelOptions } from "../../../../shared/ipc.js";

/** Lengths shown before a model's live options arrive. */
export const FALLBACK_DURATIONS: number[] = [5, 10, 15, 20];

/** Widest range offered for an open model that publishes no bounds (the
 *  vendor enforces its real limits server-side; current models top out
 *  at 30s). */
const OPEN_DEFAULT_MIN = 1;
const OPEN_DEFAULT_MAX = 30;

/** Expand an open duration range into one option per step. */
export function expandDurationRange(range: { min?: number; max?: number; step?: number }): number[] {
  const min = typeof range.min === "number" && range.min > 0 ? Math.round(range.min) : OPEN_DEFAULT_MIN;
  const max = typeof range.max === "number" && range.max >= min ? Math.round(range.max) : OPEN_DEFAULT_MAX;
  const step = typeof range.step === "number" && range.step > 0 ? range.step : 1;
  const out: number[] = [];
  for (let n = min; n <= max && out.length < 200; n += step) out.push(Math.round(n));
  return out.length ? out : FALLBACK_DURATIONS;
}

/** The length list to offer: the model's closed set, its expanded open
 *  range, or the fallback ladder while options are unknown. */
export function durationOptionsOf(opts: VideoModelOptions | null | undefined): number[] {
  if (opts?.durations?.length) return opts.durations;
  if (opts?.durationRange) return expandDurationRange(opts.durationRange);
  return FALLBACK_DURATIONS;
}

/** True when the model takes any integer length in seconds. */
export function isOpenDuration(opts: VideoModelOptions | null | undefined): boolean {
  return !!opts?.durationRange;
}

/** Round and clamp a length into the model's published range bounds.
 *  Unbounded sides and closed/unknown models pass the value through
 *  (0 passes too — callers use it as the Auto sentinel). */
export function clampDurationSec(value: number, opts: VideoModelOptions | null | undefined): number {
  let n = Math.round(value);
  if (!Number.isFinite(n)) n = 0;
  const r = opts?.durationRange;
  if (!r) return n;
  if (typeof r.min === "number" && n > 0 && n < r.min) n = r.min;
  if (typeof r.max === "number" && n > r.max) n = r.max;
  return n;
}

/** Keep a selection valid when a model's real options arrive: closed
 *  models snap an off-list value to the first offered length; open models
 *  clamp into the published bounds; unknown options leave the value
 *  alone. `allowZero` preserves the edit-video Auto sentinel (0). */
export function snapDurationSec(
  current: number,
  opts: VideoModelOptions | null | undefined,
  allowZero = false
): number {
  if (!opts) return current;
  if (allowZero && current === 0) return 0;
  if (opts.durationRange) return clampDurationSec(current, opts);
  if (opts.durations?.length && !opts.durations.includes(current)) return opts.durations[0];
  return current;
}

export function DurationField({ opts, value, onChange, className = "prod-openart-select", auto = false, title }: {
  opts: VideoModelOptions | null | undefined;
  value: number;
  onChange: (durationSec: number) => void;
  className?: string;
  /** Offer the Auto choice (0 = keep source timing), for edit-video. */
  auto?: boolean;
  title?: string;
}) {
  const options = durationOptionsOf(opts);
  // A saved value outside the offered list still shows (never silently
  // reset); picking anything else from the dropdown replaces it.
  const list = value > 0 && !options.includes(value)
    ? [...options, value].sort((a, b) => a - b)
    : options;
  return (
    <select
      className={className}
      value={String(value)}
      title={title}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {auto && <option value="0">Auto</option>}
      {list.map((d) => <option key={d} value={d}>{d}s</option>)}
    </select>
  );
}
