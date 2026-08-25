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

/** New shot factory (id + placeholder text, number filled by the caller). */
export function newShot(number: string, audio = "", visual = ""): ProductionShot {
  return { id: crypto.randomUUID(), number, audio, visual };
}
