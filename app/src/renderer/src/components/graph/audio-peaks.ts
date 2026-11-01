/**
 * Waveform peaks for audio reference tiles: a pure min/max downsample of
 * channel 0 (the animatic's `voPeaks` math, extracted) plus a cached,
 * concurrency-bounded decode hook. Decoding fetches the whole file, so
 * peaks are computed once per (revision-busted) media URL and shared by
 * every tile showing that reference. A decode failure resolves to null —
 * the tile then shows a flat progress bar and playback is unaffected.
 */
import { useEffect, useState } from "react";

export interface AudioPeaks {
  mins: Float32Array;
  maxs: Float32Array;
}

/** Downsample one PCM channel into `bucketCount` min/max buckets. Empty or
 *  degenerate input yields empty arrays (callers render a flat bar). */
export function computePeaks(channel: ArrayLike<number>, bucketCount: number): AudioPeaks {
  const len = channel.length;
  const want = Math.floor(bucketCount);
  if (!len || !(want > 0)) return { mins: new Float32Array(0), maxs: new Float32Array(0) };
  const n = Math.min(want, len);
  const mins = new Float32Array(n);
  const maxs = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    const s0 = Math.floor((b * len) / n);
    const s1 = Math.max(s0 + 1, Math.floor(((b + 1) * len) / n));
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = s0; j < s1 && j < len; j++) {
      const v = channel[j];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    mins[b] = Number.isFinite(lo) ? lo : 0;
    maxs[b] = Number.isFinite(hi) ? hi : 0;
  }
  return { mins, maxs };
}

/** Fixed decode resolution: tiles aggregate buckets down to their pixel
 *  columns at draw time, so one cache entry serves every tile size. */
const PEAK_BUCKETS = 512;
/** Whole-file decodes are heavy; never run more than this many at once. */
const MAX_CONCURRENT_DECODES = 2;

const peaksCache = new Map<string, AudioPeaks>();
const failedUrls = new Set<string>();
const inflight = new Map<string, Promise<AudioPeaks | null>>();
let activeDecodes = 0;
const decodeWaiters: Array<() => void> = [];

function acquireDecodeSlot(): Promise<void> {
  if (activeDecodes < MAX_CONCURRENT_DECODES) {
    activeDecodes++;
    return Promise.resolve();
  }
  return new Promise((resolve) => decodeWaiters.push(resolve));
}

function releaseDecodeSlot(): void {
  const next = decodeWaiters.shift();
  if (next) next();
  else activeDecodes = Math.max(0, activeDecodes - 1);
}

async function decodePeaks(url: string): Promise<AudioPeaks | null> {
  await acquireDecodeSlot();
  try {
    const resp = await fetch(url);
    const ab = await resp.arrayBuffer();
    if (!ab.byteLength) return null;
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    try {
      const buf = await ctx.decodeAudioData(ab.slice(0));
      return computePeaks(buf.getChannelData(0), PEAK_BUCKETS);
    } finally {
      await ctx.close().catch(() => {});
    }
  } catch {
    return null;
  } finally {
    releaseDecodeSlot();
  }
}

/** Peaks for a cascade-media audio URL (null while decoding / on failure). */
export function useAudioPeaks(url: string | undefined): AudioPeaks | null {
  const [peaks, setPeaks] = useState<AudioPeaks | null>(() => (url ? peaksCache.get(url) ?? null : null));
  useEffect(() => {
    if (!url) { setPeaks(null); return; }
    const cached = peaksCache.get(url);
    if (cached) { setPeaks(cached); return; }
    if (failedUrls.has(url)) { setPeaks(null); return; }
    let cancelled = false;
    let job = inflight.get(url);
    if (!job) {
      job = decodePeaks(url).then((result) => {
        inflight.delete(url);
        if (result) peaksCache.set(url, result);
        else failedUrls.add(url);
        return result;
      });
      inflight.set(url, job);
    }
    void job.then((result) => { if (!cancelled) setPeaks(result); });
    return () => { cancelled = true; };
  }, [url]);
  return peaks;
}
