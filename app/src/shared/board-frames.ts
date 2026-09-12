import type { ProductionShot } from "./ipc.js";

/** All selectable stills, including node generations that were never primary. */
export function boardFrameHistory(shot: ProductionShot): string[] {
  const editGens = [
    ...(shot.graphEditGens ?? []),
    ...(shot.graphEditNodes ?? []).flatMap((n) => n.gens ?? []),
  ];
  const generations = [...(shot.graphImageGens ?? []), ...editGens]
    .sort((a, b) => {
      const aTime = Date.parse(a.at);
      const bTime = Date.parse(b.at);
      // Undated legacy entries sort last; ties retain the existing node order.
      if (!Number.isFinite(aTime)) return Number.isFinite(bTime) ? 1 : 0;
      if (!Number.isFinite(bTime)) return -1;
      return bTime - aTime;
    });
  const paths = [
    ...generations.map((g) => g.path),
    ...(shot.artworkHistory ?? []),
    ...(shot.videoPath && shot.artwork ? [shot.artwork] : []),
  ];
  return [...new Set(paths.filter((rel) => rel && (shot.videoPath || rel !== shot.artwork)))];
}
