/**
 * Reroute points: layout-only elbow points on connection wires. A point is
 * stored in the wire's waypoint chain (`GraphLayout.waypoints[edgeId]`); a
 * point carrying an `id` is SHARED by every wire whose chain holds that id,
 * which is how a bundle's trunk works (source -> shared point, then fan-out).
 * Nothing here touches graph nodes or edges.
 */
export interface RerouteXY { x: number; y: number }
export interface RerouteWaypoint extends RerouteXY { id?: string }

export interface Seg { a: RerouteXY; b: RerouteXY }

/** Intersection of segments p->p2 and q->q2, or null. */
export function segmentIntersection(p: RerouteXY, p2: RerouteXY, q: RerouteXY, q2: RerouteXY): RerouteXY | null {
  const rx = p2.x - p.x, ry = p2.y - p.y;
  const sx = q2.x - q.x, sy = q2.y - q.y;
  const den = rx * sy - ry * sx;
  if (den === 0) return null;
  const t = ((q.x - p.x) * sy - (q.y - p.y) * sx) / den;
  const u = ((q.x - p.x) * ry - (q.y - p.y) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p.x + t * rx, y: p.y + t * ry };
}

/** First crossing of the gesture polyline with a wire polyline. */
export function polylineCrossing(line: RerouteXY[], wire: RerouteXY[]): RerouteXY | null {
  for (let i = 0; i < line.length - 1; i++) {
    for (let j = 0; j < wire.length - 1; j++) {
      const hit = segmentIntersection(line[i], line[i + 1], wire[j], wire[j + 1]);
      if (hit) return hit;
    }
  }
  return null;
}

export interface WireCrossing {
  edgeId: string;
  /** Identity of the source OUTPUT (node + port): only equal keys bundle. */
  sourceKey: string;
  pos: RerouteXY;
  /** Index in the wire's waypoint list where the new point goes. */
  index: number;
}

/**
 * Plan the waypoint patch for a gesture. Wires sharing a source output (and
 * insertion slot) get ONE shared point at the average crossing; different
 * sources never share a point. `current` is each edge's existing chain;
 * `newId` mints point ids. Returns a full replacement chain per touched edge.
 */
export function planReroutes(
  crossings: WireCrossing[],
  current: Record<string, RerouteWaypoint[]>,
  newId: () => string
): Record<string, RerouteWaypoint[]> {
  const groups = new Map<string, WireCrossing[]>();
  for (const c of crossings) {
    const key = `${c.sourceKey}#${c.index}`;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }
  const out: Record<string, RerouteWaypoint[]> = {};
  for (const list of groups.values()) {
    const pos = {
      x: list.reduce((s, c) => s + c.pos.x, 0) / list.length,
      y: list.reduce((s, c) => s + c.pos.y, 0) / list.length,
    };
    const point: RerouteWaypoint = { id: newId(), ...pos };
    for (const c of list) {
      const chain = out[c.edgeId] ?? (current[c.edgeId] ?? []).map((p) => ({ ...p }));
      const at = Math.max(0, Math.min(chain.length, c.index));
      // Later groups on the same edge shift past earlier insertions.
      chain.splice(at, 0, { ...point });
      out[c.edgeId] = chain;
    }
  }
  return out;
}

/** Move the point `id` (every wire sharing it) or a single anonymous point. */
export function moveReroute(
  all: Record<string, RerouteWaypoint[]>,
  edgeId: string,
  index: number,
  pos: RerouteXY
): Record<string, RerouteWaypoint[]> {
  const target = all[edgeId]?.[index];
  if (!target) return {};
  const out: Record<string, RerouteWaypoint[]> = {};
  for (const [eid, chain] of Object.entries(all)) {
    const next = chain.map((p, i) =>
      (target.id ? p.id === target.id : eid === edgeId && i === index) ? { ...p, x: pos.x, y: pos.y } : p
    );
    if (next.some((p, i) => p !== chain[i])) out[eid] = next;
  }
  return out;
}

/** Delete the point `id` from every wire sharing it (or one anonymous point). */
export function removeReroute(
  all: Record<string, RerouteWaypoint[]>,
  edgeId: string,
  index: number
): Record<string, RerouteWaypoint[]> {
  const target = all[edgeId]?.[index];
  if (!target) return {};
  const out: Record<string, RerouteWaypoint[]> = {};
  for (const [eid, chain] of Object.entries(all)) {
    const next = chain.filter((p, i) => !(target.id ? p.id === target.id : eid === edgeId && i === index));
    if (next.length !== chain.length) out[eid] = next;
  }
  return out;
}
