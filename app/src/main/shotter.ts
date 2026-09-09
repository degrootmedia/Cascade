/**
 * 4-digit shot numbering. Numbers are a *derived* display layer over stable
 * shot ids: shots advance by 100 (0100, 0200, …) so up to 99 inserts fit
 * between neighbours without renumbering everything downstream.
 */
import type { ProductionScene, ProductionShot } from "../shared/ipc.js";

export const FIRST_NUMBER = "0100";
const STEP = 100;

function toInt(n: string): number {
  return parseInt(n, 10);
}

/** Is this a valid 4-digit shot number (0100..9999, strictly the NN00 grid or an insert)? */
export function isValidNumber(n: string): boolean {
  return /^\d{4}$/.test(n);
}

/** Next number on the main grid: "0100" -> "0200". */
export function nextNumber(prev: string): string {
  const n = toInt(prev) + STEP;
  if (n > 9999) throw new Error(`Shot numbers exhausted after ${prev}`);
  return String(n).padStart(4, "0");
}

/**
 * Mid-number for an insert between a and b ("0100","0200" -> "0150").
 * Returns null when the gap is exhausted (b - a <= 1) — the caller must
 * renumber the scene (or the whole show) instead.
 */
export function insertMid(a: string, b: string): string | null {
  const gap = toInt(b) - toInt(a);
  if (gap <= 1) return null;
  return String(toInt(a) + Math.floor(gap / 2)).padStart(4, "0");
}

/** All shots of a production, flattened in reading order. */
export function allShots(scenes: ProductionScene[]): ProductionShot[] {
  return scenes.flatMap((s) => s.shots);
}

/**
 * Re-derive every displayed number on the global 100-grid, walking scenes in
 * order. Used as the escape hatch when mid-number space runs out, or to clean
 * up a messy import.
 */
export function renumber(scenes: ProductionScene[]): void {
  let prev: string | null = null;
  for (const scene of scenes) {
    for (const shot of scene.shots) {
      const n: string = prev === null ? FIRST_NUMBER : nextNumber(prev);
      shot.number = n;
      prev = n;
    }
  }
}

/**
 * Insert a shot into a scene at `index`, choosing a mid-number when the
 * neighbours leave room ("0100"/"0200" -> "0150"). When there's no room — or
 * the insert is at the very front — the whole show is renumbered on the
 * 100-grid (ids keep everything stable through it). Mutates `scenes`.
 */
export function insertShotAt(
  scenes: ProductionScene[],
  sceneNumber: number,
  index: number,
  audio = "",
  visual = ""
): ProductionShot {
  const scene = scenes.find((s) => s.number === sceneNumber);
  if (!scene) throw new Error(`Scene ${sceneNumber} not found`);
  const at = Math.max(0, Math.min(index, scene.shots.length));

  // Flat position of the insert point (for cross-scene neighbours).
  let pos = 0;
  for (const s of scenes) {
    if (s.number === sceneNumber) break;
    pos += s.shots.length;
  }
  pos += at;

  const flat = allShots(scenes);
  const prev = pos > 0 ? flat[pos - 1].number : null;
  const next = pos < flat.length ? flat[pos].number : null;

  let number = "";
  if (prev === null) number = FIRST_NUMBER; // front insert: full renumber after
  else if (next === null) number = nextNumber(prev);
  else number = insertMid(prev, next) ?? "";

  const shot = newShot(number || "0000", audio, visual);
  scene.shots.splice(at, 0, shot);
  if (!number || prev === null) renumber(scenes); // gap exhausted / front insert
  return shot;
}

/** Validate a numbering pass; returns human-readable problems (empty = ok). */
export function validate(scenes: ProductionScene[]): string[] {
  const problems: string[] = [];
  const shots = allShots(scenes);
  let prev: number | null = null;
  for (const s of shots) {
    if (!isValidNumber(s.number)) {
      problems.push(`Shot ${s.id} has invalid number "${s.number}"`);
      continue;
    }
    const v = toInt(s.number);
    if (v < 100) problems.push(`Shot ${s.number} is below 0100`);
    if (prev !== null && v <= prev) problems.push(`Shot ${s.number} does not advance past ${String(prev).padStart(4, "0")}`);
    prev = v;
  }
  const ids = new Set(shots.map((s) => s.id));
  if (ids.size !== shots.length) problems.push("Duplicate shot ids — numbers can no longer be trusted");
  return problems;
}

/** Move one shot to a new position (before `beforeShotId`, at the end of the
 *  production when null, or at the end of one scene when `endSceneNumber` is
 *  set with a null `beforeShotId`). Works across scenes — the shot is spliced
 *  out of its source scene and into the target scene at the insertion point,
 *  then every number on the global 100-grid is re-derived. Returns the moved
 *  shot plus a map of id→oldNumber so callers can relocate board folders. */
export function reorderShot(
  scenes: ProductionScene[],
  shotId: string,
  beforeShotId: string | null,
  endSceneNumber?: number
): { shot: ProductionShot; oldNumbers: Map<string, string> } {
  if (beforeShotId === shotId) throw new Error("Cannot move a shot before itself.");
  const oldNumbers = new Map<string, string>();
  for (const sc of scenes) for (const s of sc.shots) oldNumbers.set(s.id, s.number);

  // Locate source
  let source: ProductionShot | null = null;
  let sourceScene: ProductionScene | null = null;
  let sourceIdx = -1;
  for (const sc of scenes) {
    const i = sc.shots.findIndex((s) => s.id === shotId);
    if (i !== -1) { source = sc.shots[i]; sourceScene = sc; sourceIdx = i; break; }
  }
  if (!source || !sourceScene) throw new Error("Shot not found.");

  // Remove from source
  sourceScene.shots.splice(sourceIdx, 1);

  // Locate target insertion point after removal (so same-scene moves are stable)
  if (beforeShotId === null) {
    // End of one scene (its trailing gap), or end of the last scene when no
    // scene was named
    if (endSceneNumber != null) {
      const target = scenes.find((s) => s.number === endSceneNumber);
      if (!target) {
        // Scene gone — put it back and fail (keeps state consistent)
        sourceScene.shots.splice(sourceIdx, 0, source);
        throw new Error(`Scene ${endSceneNumber} not found.`);
      }
      target.shots.push(source);
    } else {
      const last = scenes[scenes.length - 1];
      if (!last) throw new Error("No scenes to insert into.");
      last.shots.push(source);
    }
  } else {
    let targetScene: ProductionScene | null = null;
    let targetIdx = -1;
    for (const sc of scenes) {
      const i = sc.shots.findIndex((s) => s.id === beforeShotId);
      if (i !== -1) { targetScene = sc; targetIdx = i; break; }
    }
    if (!targetScene) {
      // Target gone — put it back and fail (keeps state consistent)
      sourceScene.shots.splice(sourceIdx, 0, source);
      throw new Error("Target shot not found.");
    }
    targetScene.shots.splice(targetIdx, 0, source);
  }

  renumber(scenes);
  return { shot: source, oldNumbers };
}

/** New shot factory (id + placeholder text, number filled by the caller). */
export function newShot(number: string, audio = "", visual = ""): ProductionShot {
  return { id: crypto.randomUUID(), number, audio, visual };
}

/**
 * A blank starting skeleton for productions with no script to ingest: one
 * scene with five empty shots numbered on the 100-grid, ready for manual
 * editing (or a later re-ingestion).
 */
export function blankScenes(): ProductionScene[] {
  const shots: ProductionShot[] = [];
  let number = FIRST_NUMBER;
  for (let i = 0; i < 5; i++) {
    shots.push(newShot(number));
    number = nextNumber(number);
  }
  return [{ number: 1, title: "Scene 1", shots }];
}

/** Re-derive every scene ordinal 1..N in order. Scene numbers are display-only. */
function renumberSceneOrdinals(scenes: ProductionScene[]): void {
  scenes.forEach((s, i) => { s.number = i + 1; });
}

/**
 * Insert an empty scene after `afterSceneNumber` (0 = before the first scene,
 * null = at the end), then renumber every later scene ordinal 1..N. Shot
 * numbers are untouched. Returns the new scene.
 */
export function insertScene(
  scenes: ProductionScene[],
  afterSceneNumber: number | null
): ProductionScene {
  const scene: ProductionScene = { number: 0, title: "New Scene", shots: [] };
  if (afterSceneNumber === null) scenes.push(scene);
  else if (afterSceneNumber === 0) scenes.unshift(scene);
  else {
    const at = scenes.findIndex((s) => s.number === afterSceneNumber);
    if (at === -1) throw new Error(`Scene ${afterSceneNumber} not found`);
    scenes.splice(at + 1, 0, scene);
  }
  renumberSceneOrdinals(scenes);
  return scene;
}
