/**
 * Item 3 model edits in app/src/shared/ipc/timeline.ts (CRLF-safe).
 */
import * as fs from "node:fs";
const p = "app/src/shared/ipc/timeline.ts";
let s = fs.readFileSync(p, "utf8");
const E = s.includes("\r\n") ? "\r\n" : "\n";
const J = (lines) => lines.join(E);
function rep(find, replace, label) {
  const n = s.split(find).length - 1;
  if (n !== 1) { console.log(`FAIL ${label}: ${n} matches`); process.exit(1); }
  s = s.replace(find, replace);
  console.log(`ok ${label}`);
}

// 1. durationSec on the model.
rep(
  J([
    "  /** Dissolves between adjacent clips (Item 8). Absent = all cuts. */",
    "  transitions?: TimelineTransition[];",
    "}",
  ]),
  J([
    "  /** Dissolves between adjacent clips (Item 8). Absent = all cuts. */",
    "  transitions?: TimelineTransition[];",
    "  /** Explicit total timeline length in seconds, set from the toolbar",
    "   *  length field. Readers use max(this, last clip end), so a longer",
    "   *  value pads the tail with empty space and a stale shorter value",
    "   *  never truncates clips. Absent = length is the last clip's end. */",
    "  durationSec?: number;",
    "}",
  ]),
  "interface durationSec",
);

// 2. normalize keeps it.
rep(
  "  return { version: 1, tracks, clips, ...(transitions.length ? { transitions } : {}) };",
  J([
    "  const durationSec = num((t as { durationSec?: unknown }).durationSec);",
    "  return {",
    "    version: 1, tracks, clips,",
    "    ...(transitions.length ? { transitions } : {}),",
    "    ...(durationSec != null && durationSec > 0 ? { durationSec } : {}),",
    "  };",
  ]),
  "normalize durationSec",
);

// 3. resolveTimeline: effective total + span tiling reach the explicit length.
rep(
  J([
    "  const visibleVideo = t.clips.filter((c) => {",
  ]),
  J([
    "  // Explicit length (toolbar mm:ss field) extends the timeline past",
    "  // the last clip with empty space; it never shortens it.",
    "  const explicitSec = num(t.durationSec) ?? 0;",
    "  if (explicitSec > totalSec) totalSec = explicitSec;",
    "  const spanExtent = Math.max(videoExtent, explicitSec);",
    "",
    "  const visibleVideo = t.clips.filter((c) => {",
  ]),
  "resolve explicit total",
);
rep(
  J([
    "  if (videoExtent > 0) {",
    "    const bounds = new Set<number>([0, videoExtent]);",
    "    for (const c of visibleVideo) {",
    "      bounds.add(Math.min(c.timelineStartSec, videoExtent));",
    "      bounds.add(Math.min(clipEndSec(c), videoExtent));",
    "    }",
  ]),
  J([
    "  if (spanExtent > 0) {",
    "    const bounds = new Set<number>([0, spanExtent]);",
    "    for (const c of visibleVideo) {",
    "      bounds.add(Math.min(c.timelineStartSec, spanExtent));",
    "      bounds.add(Math.min(clipEndSec(c), spanExtent));",
    "    }",
  ]),
  "resolve span tiling extent",
);

// 4. scaleTimelineToDuration scales the explicit length too.
rep(
  "  for (const tr of next.transitions ?? []) tr.durationSec *= f;",
  J([
    "  for (const tr of next.transitions ?? []) tr.durationSec *= f;",
    "  if (next.durationSec != null) next.durationSec *= f;",
  ]),
  "scale explicit length",
);

// 5. Length helpers + setter, after trackVolume/fadeOf.
rep(
  J([
    "const fadeOf = (v: number | undefined): number => {",
    "  const f = num(v);",
    "  return f != null && f > 0 ? f : 0;",
    "};",
  ]),
  J([
    "const fadeOf = (v: number | undefined): number => {",
    "  const f = num(v);",
    "  return f != null && f > 0 ? f : 0;",
    "};",
    "",
    "/** The timeline's effective total length: the last clip's end, or",
    " *  the explicit `durationSec` when that reaches further (empty tail). */",
    "export function timelineLengthSec(t: ProductionTimeline): number {",
    "  let end = 0;",
    "  for (const c of t.clips) end = Math.max(end, clipEndSec(c));",
    "  const explicit = num(t.durationSec) ?? 0;",
    "  return Math.max(end, explicit);",
    "}",
    "",
    "/** Set the explicit total length (toolbar mm:ss field). A value at",
    " *  or before the last clip's end CLAMPS: the field is dropped and",
    " *  the length is exactly that end — clips are never truncated.",
    " *  A longer value pads empty space after the last clip. Returns",
    " *  the input unchanged when nothing would change. */",
    "export function setTimelineDuration(t: ProductionTimeline, sec: number): ProductionTimeline {",
    "  if (!Number.isFinite(sec) || sec < 0) return t;",
    "  let lastEnd = 0;",
    "  for (const c of t.clips) lastEnd = Math.max(lastEnd, clipEndSec(c));",
    "  const next = structuredClone(t);",
    "  if (sec <= lastEnd + 1e-9) delete next.durationSec;",
    "  else next.durationSec = sec;",
    "  return (next.durationSec ?? null) === (t.durationSec ?? null) ? t : next;",
    "}",
    "",
    "/** Format seconds as the length field's `mm:ss` (zero-padded;",
    " *  minutes keep counting past 59). Rounds to the nearest second. */",
    "export function formatTimelineLength(totalSec: number): string {",
    "  const s = Math.max(0, Math.round(Number.isFinite(totalSec) ? totalSec : 0));",
    "  const m = Math.floor(s / 60);",
    "  return `${String(m).padStart(2, \"0\")}:${String(s % 60).padStart(2, \"0\")}`;",
    "}",
    "",
    "/** Parse the length field's text: `mm:ss` (minutes any size,",
    " *  seconds 0-59) or a plain number of seconds. Anything else is",
    " *  null — the field reverts to the current length. */",
    "export function parseTimelineLength(text: string): number | null {",
    "  const v = text.trim();",
    "  if (!v) return null;",
    "  const mmss = /^(\\d+):([0-5]?\\d)$/.exec(v);",
    "  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);",
    "  if (/^\\d+(\\.\\d+)?$/.test(v)) return Number(v);",
    "  return null;",
    "}",
  ]),
  "length helpers",
);

fs.writeFileSync(p, s, "utf8");
console.log("done");
