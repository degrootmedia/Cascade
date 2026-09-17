/**
 * Live per-config credit quotes (Higgsfield CLI `generate cost` preflight).
 *
 * One hook serves every Generate button: the caller passes the structural
 * price drivers (model / kind / resolution / duration / aspect / quality /
 * schema params) and gets `{ cost, pending }`. Prompt text and reference
 * bytes never travel — neither moves the price, so the probe sends a
 * constant placeholder and no media flags (zero uploads).
 *
 * Performance contract: debounced (400 ms default) + main-side cached
 * (5-min TTL) + gated to `higgsfield-cli:*` ids (no IPC at all for other
 * vendors) + stale-while-revalidate (the previous quote stays visible while
 * the next one resolves) + never throws (unreadable quotes resolve null and
 * the caller hides the price; submit is never blocked).
 */
import { useEffect, useRef, useState } from "react";
import type { CascadeApi, GenerationCostRequest } from "../../../../shared/ipc.js";

const QUOTABLE_PREFIXES = ["higgsfield-cli:", "higgsfield:"];

/** True when the model id can carry a live quote (Higgsfield CLI family).
 *  Anything else resolves null with zero spawns — the caller falls back to
 *  the static per-model `cost` overlay / balance line. */
export function isQuotableCostModel(model: string | undefined | null): boolean {
  const m = (model ?? "").trim();
  return QUOTABLE_PREFIXES.some((p) => m.startsWith(p));
}

/** Stable quote key: sorted params so key order never refires the probe. */
export function generationCostKey(req: GenerationCostRequest): string {
  const params = req.params
    ? Object.keys(req.params).sort().map((k) => `${k}=${JSON.stringify(req.params?.[k])}`)
    : [];
  return [
    req.model.trim(), req.kind, req.resolution ?? "", req.durationSec ?? "",
    req.aspectRatio ?? "", req.quality ?? "", ...params,
  ].join("|");
}

/** Human quote: integers bare, fractions trimmed (`32.5`, never `32.50`). */
export function formatGenerationCost(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** Aspect wire value for a quote: the caller's explicit `aspect_ratio` param
 *  wins, else the shared 16:9 default (mirrors `resolveAspectRatio` — the
 *  provider only emits it when the model lists it). */
export function costAspect(params?: Record<string, string | number | boolean | string[]>): string {
  const a = params?.aspect_ratio;
  return typeof a === "string" && a.trim() ? a : "16:9";
}

function cascade(): Pick<CascadeApi, "generationCost"> | null {
  const c = (globalThis as { cascade?: unknown }).cascade as
    | (Pick<CascadeApi, "generationCost"> & Record<string, unknown>)
    | undefined;
  return c && typeof c.generationCost === "function" ? c : null;
}

export interface GenerationCostState {
  /** Live quote, or the previous quote while `pending`, or null when unknown. */
  cost: number | null;
  /** A quote request is in flight (or debouncing). */
  pending: boolean;
}

export function useGenerationCost(
  req: GenerationCostRequest | null,
  opts?: { debounceMs?: number }
): GenerationCostState {
  const [cost, setCost] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const seq = useRef(0);
  const reqRef = useRef(req);
  reqRef.current = req;
  const key = req ? generationCostKey(req) : "";

  useEffect(() => {
    const cur = reqRef.current;
    if (!cur || !isQuotableCostModel(cur.model)) {
      seq.current += 1;
      setCost(null);
      setPending(false);
      return;
    }
    const id = ++seq.current;
    setPending(true);
    const snapshot = cur;
    const timer = setTimeout(() => {
      const c = cascade();
      if (!c) {
        if (seq.current === id) {
          setPending(false);
        }
        return;
      }
      c.generationCost(snapshot).then(
        (q) => {
          if (seq.current !== id) return;
          setCost(typeof q === "number" && Number.isFinite(q) && q >= 0 ? q : null);
          setPending(false);
        },
        () => {
          if (seq.current !== id) return;
          setCost(null);
          setPending(false);
        }
      );
    }, opts?.debounceMs ?? 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { cost, pending };
}
