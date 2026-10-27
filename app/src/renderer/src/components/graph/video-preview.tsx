/**
 * Poster-first video preview for the node graph (perf phase 1).
 *
 * A mounted <video> demuxes and decodes its first frames at native
 * resolution even with preload="metadata" — with one live element per
 * video/edit/output/ref node, opening a take-rich shot (or landing a new
 * take) stalled the canvas behind a burst of decoders. This component
 * paints the cached middle-frame poster (fixed `?thumb=` tier, generated
 * main-side) and mounts the real <video> only on intent — hover for
 * reference nodes, a play-button click for generation nodes — with a small
 * global LRU cap on simultaneously live videos so a big graph can never
 * accumulate decoders again. While the viewport moves (graph/lod.tsx),
 * live videos unmount back to posters and hover-activation is suppressed:
 * nodes sliding under a stationary cursor mid-pan must not spin up
 * decoders. Mirrors the references panel's Perf 2.4 hover-mount.
 */
import { useCallback, useEffect, useReducer, useState } from "react";
import { refThumbUrl } from "../production/thumb-url.js";
import { GRAPH_PREVIEW_EDGE, useGraphLod } from "./lod.js";

/** Max <video> elements alive in the graph at once; the oldest activation
 *  unmounts (back to its poster) when a new one mounts. */
export const MAX_LIVE_NODE_VIDEOS = 3;

const liveOrder: string[] = [];
const listeners = new Set<() => void>();

function notifyLiveVideos(): void {
  for (const l of listeners) l();
}

/** Mark `id` live (most-recent), evicting the oldest beyond the cap. */
export function activateLiveVideo(id: string): void {
  const at = liveOrder.indexOf(id);
  if (at >= 0) liveOrder.splice(at, 1);
  liveOrder.push(id);
  while (liveOrder.length > MAX_LIVE_NODE_VIDEOS) liveOrder.shift();
  notifyLiveVideos();
}

/** Unmount `id`'s live video (back to poster). No-op when not live. */
export function deactivateLiveVideo(id: string): void {
  const at = liveOrder.indexOf(id);
  if (at < 0) return;
  liveOrder.splice(at, 1);
  notifyLiveVideos();
}

export function isLiveVideo(id: string): boolean {
  return liveOrder.includes(id);
}

/** Test seam — current live ids, oldest first. */
export function liveVideoIdsForTests(): string[] {
  return [...liveOrder];
}

/** Test seam — clear the registry between cases. */
export function resetLiveVideosForTests(): void {
  liveOrder.length = 0;
  notifyLiveVideos();
}

function useIsLiveVideo(id: string): boolean {
  const bump = useReducer((n: number) => n + 1, 0)[1];
  useEffect(() => {
    listeners.add(bump);
    return () => { listeners.delete(bump); };
  }, [bump]);
  return isLiveVideo(id);
}

/**
 * A clip tile that costs one small JPEG until played. `instanceId` must be
 * unique per mounted preview (node id scoped is enough). With
 * `hoverActivate`, hovering mounts + plays and leaving unmounts (reference
 * nodes); otherwise the play button mounts a controls-bearing <video>
 * that stays until evicted by the live cap or unmounted.
 */
export function VideoPreview({ instanceId, url, className, controls = false, hoverActivate = false, posterEdge }: {
  instanceId: string;
  url: string;
  className?: string;
  controls?: boolean;
  hoverActivate?: boolean;
  /** Fixed poster thumbnail tier (long edge). Defaults to the generator
   *  previews' tier; resizable hosts (ref/output tiles) pass the tile tier. */
  posterEdge?: number;
}) {
  const live = useIsLiveVideo(instanceId);
  const { interacting } = useGraphLod();
  const [posterAttempt, setPosterAttempt] = useState(0);
  const [posterFailed, setPosterFailed] = useState(false);
  useEffect(() => { setPosterAttempt(0); setPosterFailed(false); }, [url]);
  // A preview that leaves the canvas frees its decoder slot immediately.
  useEffect(() => () => { deactivateLiveVideo(instanceId); }, [instanceId]);
  // Viewport moving: unmount back to the poster so no decoder competes
  // with the gesture. Playback restarts only on fresh user intent.
  useEffect(() => { if (interacting) deactivateLiveVideo(instanceId); }, [interacting, instanceId]);

  const activate = useCallback(() => activateLiveVideo(instanceId), [instanceId]);
  const deactivate = useCallback(() => deactivateLiveVideo(instanceId), [instanceId]);
  const posterBase = refThumbUrl(url, posterEdge ?? GRAPH_PREVIEW_EDGE);
  const poster = posterBase + (posterAttempt ? `${posterBase.includes("?") ? "&" : "?"}r=${posterAttempt}` : "");

  if (live) {
    return (
      <video
        className={className}
        src={url}
        poster={posterFailed ? undefined : posterBase}
        controls={controls || undefined}
        muted
        loop
        playsInline
        preload="metadata"
        autoPlay
        draggable={false}
        onMouseLeave={hoverActivate ? deactivate : undefined}
      />
    );
  }
  return (
    <span className="prod-graph-video-poster nodrag" onMouseEnter={hoverActivate && !interacting ? activate : undefined}>
      {posterFailed
        ? <span className={(className ?? "") + " prod-graph-video-poster-blank"}>▶</span>
        : (
          <img
            className={className}
            src={poster}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => { if (posterAttempt < 2) setPosterAttempt(posterAttempt + 1); else setPosterFailed(true); }}
          />
        )}
      <button
        className="prod-graph-video-play nodrag"
        title="Play clip"
        onClick={(e) => { e.stopPropagation(); activate(); }}
      >
        ▶
      </button>
    </span>
  );
}
