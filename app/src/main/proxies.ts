/**
 * Preview proxies (Animatic Editor Expansion, Item 6).
 *
 * A proxy is a 720p, fast-decode sibling of a timeline video source,
 * stored at `out/proxies/<name>-<hash>.mp4` inside the production
 * folder. Preview prefers a READY proxy (present and at least as new
 * as its source) and falls back to the original otherwise, so editing
 * never waits for generation. Render and export NEVER read proxies:
 * the assembly plan only ever references original media, and this
 * module is not imported by it. Proxies are bookkeeping-free by design
 * (not in the media registry): deleting `out/proxies` at any time is
 * safe — the worst case is a regenerate.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Production, ProductionTimeline, ProxyGenerationResult } from "../shared/ipc.js";
import { assetPath } from "./pipeline.js";

export const PROXY_DIR = "out/proxies";
export const PROXY_HEIGHT = 720;

/** Deterministic proxy path for a source: stable across sessions, one
 *  file per source path (hash suffix disambiguates same-named files). */
export function proxyRelFor(srcRel: string): string {
  const base = (srcRel.split("/").pop() ?? "clip").replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9-_]+/g, "-") || "clip";
  const hash = createHash("sha1").update(srcRel).digest("hex").slice(0, 8);
  return `${PROXY_DIR}/${base}-${hash}.mp4`;
}

/** The unique video source rel paths a timeline references. */
export function timelineVideoSources(timeline: ProductionTimeline | undefined): string[] {
  if (!timeline) return [];
  return [...new Set(
    timeline.clips
      .filter((c) => c.sourceKind === "video" && !!c.srcRel)
      .map((c) => c.srcRel!)
  )].sort();
}

/**
 * Pure args for one proxy encode: downscale to at most 720p (never
 * upscale), short GOP for fast scrubbing/seeking, faststart moov.
 */
export function buildProxyArgs(srcAbs: string, outAbs: string): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", srcAbs,
    "-vf", `scale=-2:'min(${PROXY_HEIGHT},ih)'`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-g", "24", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart",
    outAbs,
  ];
}

/** A proxy is ready when it exists and is at least as new as its source. */
export function proxyIsFresh(p: Production, srcRel: string): boolean {
  try {
    const srcM = fs.statSync(assetPath(p, srcRel)).mtimeMs;
    const proxyM = fs.statSync(assetPath(p, proxyRelFor(srcRel))).mtimeMs;
    return proxyM >= srcM;
  } catch {
    return false;
  }
}

/** Ready proxies for the given sources (or the timeline's, by default). */
export function listReadyProxies(p: Production, srcRels?: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of srcRels ?? timelineVideoSources(p.timeline)) {
    if (proxyIsFresh(p, rel)) out[rel] = proxyRelFor(rel);
  }
  return out;
}

export type ProxyRunFfmpeg = (args: string[]) => Promise<void>;

/**
 * Encode every stale/missing proxy for the given sources (sequential:
 * one encode at a time keeps the machine responsive). Per-file failures
 * are collected, never fatal — the original previews meanwhile.
 */
export async function generateProxies(
  p: Production,
  srcRels: readonly string[],
  run: ProxyRunFfmpeg,
  emit: (msg: string) => void
): Promise<ProxyGenerationResult> {
  let generated = 0;
  let fresh = 0;
  const failed: string[] = [];
  const todo = srcRels.filter((rel) => {
    if (proxyIsFresh(p, rel)) {
      fresh++;
      return false;
    }
    return true;
  });
  let done = 0;
  for (const rel of todo) {
    const proxyRel = proxyRelFor(rel);
    const outAbs = assetPath(p, proxyRel);
    try {
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      await run(buildProxyArgs(assetPath(p, rel), outAbs));
      generated++;
    } catch {
      failed.push(rel);
      try { fs.rmSync(outAbs, { force: true }); } catch { /* partial file cleanup is best effort */ }
    }
    done++;
    emit(`Proxies: ${done}/${todo.length} (${rel.split("/").pop() ?? rel})`);
  }
  return { generated, fresh, failed, proxies: listReadyProxies(p, srcRels) };
}
