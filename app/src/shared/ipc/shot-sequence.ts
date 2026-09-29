/**
 * Shot Sequence types + pure span math (Spec 06).
 *
 * Domain module of `shared/ipc.ts`; the barrel re-exports everything, so
 * `../shared/ipc.js` import paths are unchanged.
 *
 * A Shot Sequence is a span of storyboard shots played as ONE generated clip.
 * Its canvas is THE node graph (`NodeGraphModal`) — not a special canvas — so
 * the sequence carries its graph state in the exact `ProductionShot` shape a
 * shot uses (`graph`): each video node's take history, the output binding,
 * prompts, and the canvas layout all live there, and the pre-loaded video node
 * cites the member frames as `@[Shot NNNN]` tags. Everything here is
 * vendor-blind and side-effect-free — the renderer hosts the canvas on
 * `sequenceGraphShot`, main prunes/merges sequences with it, and the animatic
 * and export read the resolved output media.
 */
import type { GraphGenItem, GraphVideoNode, SequenceSegment } from "./graph.js";
import type { ProductionShot } from "./production.js";
import { refTagNames, removeRefTag } from "../prompt-grammar.js";

/** One shot sequence. Renderer-owned (created/edited through `saveField`) with
 *  main-owned generation history (inside `graph`), merged per entry by
 *  `applyRendererState`. Additive — absent on documents that never made one. */
export interface ShotSequence {
  /** Stable identity (`uid("seq")`). */
  id: string;
  /** Display label ("Sequence 01"). */
  name: string;
  /** Member shots in reading order — the span this sequence encompasses.
   *  A shot belongs to at most one sequence; creation rejects overlaps. */
  shotIds: string[];
  /** Replaces the member shots in the animatic + export while true (default).
   *  Disabled plays the members individually again. */
  enabled?: boolean;
  /** Mute the sequence's output clip in the animatic. */
  muted?: boolean;
  /** Accent palette key for the storyboard bar. */
  accent?: string;
  /** Animatic window in seconds; absent = the members' durations summed. */
  durationSec?: number;
  /** Slip offset into the output clip in seconds (mirrors the shot's
   *  `videoOffsetSec` — the window stays put while the source shifts). */
  videoOffsetSec?: number;
  createdAt?: string;
  /** The sequence canvas's graph state, in the SAME shape a shot uses — the
   *  node graph is not a special canvas, it is simply hosted here (`id` = the
   *  sequence id, `number` = its name). Only the graph/prompt fields are used;
   *  a sequence owns no board folder, so frames/clips it generates live under
   *  `out/sequences/<id>/`. */
  graph?: ProductionShot;
}

/** The resolved output media feeding the animatic/export. */
export interface SequenceOutputMedia {
  kind: "video" | "image";
  /** Workspace-relative path. */
  rel: string;
}

/** Minimal reference view `sequenceOutputMedia` resolves ref bindings against. */
export interface SequenceOutputRefView {
  id: string;
  media?: "video" | "audio";
  imagePath?: string;
  mediaPath?: string;
}

/** The storyboard bar's accent palette. `id` is what persists; `hex` is
 *  presentation only (so a palette tweak re-colors existing bars). Mirrors the
 *  moodboard frame palette so the product reads as one system. */
export const SEQUENCE_ACCENT_COLORS = [
  { id: "blue", label: "Blue", hex: "#4f8ef7" },
  { id: "violet", label: "Violet", hex: "#9a7bff" },
  { id: "pink", label: "Pink", hex: "#ef6ea8" },
  { id: "red", label: "Red", hex: "#e5534b" },
  { id: "orange", label: "Orange", hex: "#f0883e" },
  { id: "amber", label: "Amber", hex: "#e3b341" },
  { id: "green", label: "Green", hex: "#57ab5a" },
  { id: "teal", label: "Teal", hex: "#39c5bb" },
] as const;

export type SequenceAccentId = (typeof SEQUENCE_ACCENT_COLORS)[number]["id"];

export const SEQUENCE_DEFAULT_ACCENT: SequenceAccentId = "blue";

export function normalizeSequenceAccent(raw: unknown): SequenceAccentId {
  return SEQUENCE_ACCENT_COLORS.some((c) => c.id === raw) ? (raw as SequenceAccentId) : SEQUENCE_DEFAULT_ACCENT;
}

/** The hex for a persisted accent key (unknown keys fall back to the default). */
export function sequenceAccentHex(raw: unknown): string {
  return SEQUENCE_ACCENT_COLORS.find((c) => c.id === normalizeSequenceAccent(raw))!.hex;
}

/** The next accent in the cycle — bars cycle colors as sequences are created. */
export function defaultSequenceAccent(existing: ShotSequence[]): SequenceAccentId {
  return SEQUENCE_ACCENT_COLORS[existing.length % SEQUENCE_ACCENT_COLORS.length].id;
}

/** "Sequence 01", "Sequence 02", … — bumping past any name already in use. */
export function nextSequenceName(existing: ShotSequence[]): string {
  const used = new Set(existing.map((s) => s.name));
  for (let i = 1; i <= 999; i++) {
    const name = `Sequence ${String(i).padStart(2, "0")}`;
    if (!used.has(name)) return name;
  }
  return `Sequence ${Date.now()}`;
}

/** Default segment length for a freshly seeded timeline (seconds). */
export const SEQUENCE_SEGMENT_DEFAULT_SEC = 3;

/**
 * Repair/normalize a sequence timeline. Segments stay in order; each segment's
 * `durationSec` is a whole number of seconds (min 1). A legacy stored segment
 * carrying a `startSec`/`endSec` range migrates to its length. Segments with no
 * shot id are dropped. Pure.
 */
export function normalizeSequenceSegments(segments: SequenceSegment[] | undefined): SequenceSegment[] {
  const out: SequenceSegment[] = [];
  for (const s of segments ?? []) {
    if (!s || typeof s.shotId !== "string" || !s.shotId) continue;
    const legacy = s as unknown as { startSec?: number; endSec?: number };
    const raw = Number.isFinite(s.durationSec)
      ? (s.durationSec as number)
      : typeof legacy.endSec === "number" && typeof legacy.startSec === "number"
        ? legacy.endSec - legacy.startSec
        : SEQUENCE_SEGMENT_DEFAULT_SEC;
    out.push({
      shotId: s.shotId,
      durationSec: Math.max(1, Math.round(Number.isFinite(raw) ? raw : SEQUENCE_SEGMENT_DEFAULT_SEC)),
      prompt: typeof s.prompt === "string" ? s.prompt : "",
    });
  }
  return out;
}

/** Total sequence length in seconds (the sum of the segments; 0 when empty). Pure. */
export function sequenceTotalDuration(segments: SequenceSegment[] | undefined): number {
  return (segments ?? []).reduce((n, s) => n + (Number.isFinite(s.durationSec) ? Math.max(0, Math.round(s.durationSec)) : 0), 0);
}

/** Seed a timeline for a span of member shots — each runs the member's own
 *  duration (or 3s). Pure. */
export function seedSequenceSegments(frames: { shotId: string; durationSec?: number }[]): SequenceSegment[] {
  return frames.map((f) => {
    const len = Number.isFinite(f.durationSec) && (f.durationSec as number) > 0 ? Math.round(f.durationSec as number) : SEQUENCE_SEGMENT_DEFAULT_SEC;
    return { shotId: f.shotId, durationSec: Math.max(1, len), prompt: "" };
  });
}

/** One vendor-prompt timeline line — the multi-shot framing form
 *  `"Hard Cut to Shot 2. 3 Seconds. Framing Reference <<<image_4>>>"` followed
 *  by the shot's prompt (`imageNumber` = the frame's 1-based position in the
 *  submitted reference list). Without a `shotNumber` it degrades to `"3s"`. */
export function sequenceSegmentLine(seg: SequenceSegment, shotNumber?: number, imageNumber?: number): string {
  const text = (seg.prompt ?? "").trim();
  const dur = Math.max(1, Math.round(seg.durationSec));
  if (shotNumber === undefined) return text ? `${dur}s: ${text}` : `${dur}s`;
  const head = `Hard Cut to Shot ${shotNumber}. ${dur} Seconds.` + (imageNumber !== undefined ? ` Framing Reference <<<image_${imageNumber}>>>` : "");
  return text ? `${head}\n${text}` : head;
}

/** Strip legacy member-frame citations (`@[Shot NNNN]`) from stored video-node
 *  prompts — frames are timeline segments now, not prompt tags. Pure. */
export function stripSequenceFrameTags(text: string): string {
  let out = text ?? "";
  for (const name of refTagNames(out)) {
    if (/^Shot\s+\d+$/i.test(name)) out = removeRefTag(out, name);
  }
  return out;
}

/** Why this span can't become a sequence right now, or null when it can. */
export function sequenceOverlapReason(shotIds: string[], sequences: ShotSequence[]): string | null {
  const unique = [...new Set(shotIds)];
  if (unique.length < 2) return "Select at least two consecutive frames for a shot sequence.";
  const owners = new Map<string, string>();
  for (const s of sequences) {
    for (const id of s.shotIds) if (!owners.has(id)) owners.set(id, s.name);
  }
  const owner = unique.map((id) => owners.get(id)).find(Boolean);
  if (owner) return `A selected frame already belongs to "${owner}" — a shot can be part of only one sequence.`;
  return null;
}

/** Assemble a fresh sequence over the span: pre-loaded with the member frames
 *  as cited image nodes and a video-generation node, the only difference from
 *  any other canvas. `frames` are the member frames in reading order — the
 *  label becomes the frame node's name and its `@[label]` prompt citation. */
export function createShotSequence(
  id: string,
  frames: { shotId: string; label: string; durationSec?: number }[],
  existing: ShotSequence[]
): ShotSequence {
  const seen = new Set<string>();
  const unique = frames.filter((f) => (seen.has(f.shotId) ? false : (seen.add(f.shotId), true)));
  const name = nextSequenceName(existing);
  return {
    id,
    name,
    shotIds: unique.map((f) => f.shotId),
    graph: {
      id,
      number: name,
      audio: "",
      visual: "",
      prompt: "",
      // The timed multi-shot timeline: one segment per member frame. The
      // ordinary video generator node carries the takes/picks/output.
      graphSequence: { segments: seedSequenceSegments(unique.map((f) => ({ shotId: f.shotId, durationSec: f.durationSec }))) },
      graphVideoNodes: [{ id: "vid0", prompt: "" }],
    },
    enabled: true,
    accent: defaultSequenceAccent(existing),
  };
}

/** The shot-shaped facade the node graph renders: `id` is the sequence id and
 *  `number` its name, with the stored graph fields layered underneath. */
export function sequenceGraphShot(seq: ShotSequence): ProductionShot {
  const base: ProductionShot = { id: seq.id, number: seq.name, audio: "", visual: "" };
  return { ...(seq.graph ?? {}), ...base };
}

/** The selected take on one of the sequence's video nodes — a GENERATED clip
 *  from the take history (`vid0` by default). This is what the delete flow
 *  preserves as a reference. */
export function sequenceSelectedTake(seq: ShotSequence, nodeId?: string): string | undefined {
  const nodes = seq.graph?.graphVideoNodes ?? [];
  const node = (nodeId ? nodes.find((n) => n.id === nodeId) : undefined) ?? nodes[0];
  const gens = node?.gens ?? [];
  if (!gens.length) return undefined;
  return gens[node?.genIndex ?? 0]?.path ?? gens[0]?.path;
}

/**
 * The media the sequence canvas's frame output node is bound to — what feeds
 * the animatic and the export. Mirrors the node graph's own output resolution
 * (`graphOutputSource` + the feeding node's selected take, tween output, or a
 * reference — including a member frame, which is a `seqframe:<shotId>`
 * reference id). `null` = unbound, so the animatic shows its slate.
 */
export function sequenceOutputMedia(
  seq: ShotSequence,
  ctx: { shots: readonly SequenceShotView[]; refs?: readonly SequenceOutputRefView[] }
): SequenceOutputMedia | null {
  const g = seq.graph;
  if (!g?.graphOutputSource) return null;
  if (g.graphOutputSource === "videogen") {
    const rel = sequenceSelectedTake(seq, g.graphOutputVideoNodeId);
    return rel ? { kind: "video", rel } : null;
  }
  if (g.graphOutputSource === "imagegen") {
    const sel = (g.graphImageGens ?? [])[g.graphImageGenIndex ?? 0] ?? g.graphImageGens?.[0];
    return sel?.path ? { kind: "image", rel: sel.path } : null;
  }
  if (g.graphOutputSource === "editgen") {
    const node = (g.graphEditNodes ?? []).find((n) => n.id === g.graphOutputEditNodeId) ?? g.graphEditNodes?.[0];
    const sel = (node?.gens ?? [])[node?.genIndex ?? 0] ?? node?.gens?.[0];
    return sel?.path ? { kind: "image", rel: sel.path } : null;
  }
  if (g.graphOutputSource === "upscale") {
    const sel = (g.graphUpscale?.gens ?? [])[g.graphUpscale?.genIndex ?? 0] ?? g.graphUpscale?.gens?.[0];
    return sel?.path ? { kind: "image", rel: sel.path } : null;
  }
  if (g.graphOutputSource === "tween") {
    return g.graphTweenOutput ? { kind: "video", rel: g.graphTweenOutput } : null;
  }
  if (g.graphOutputSource === "editvideo") {
    const sel = (g.graphEditVideoGens ?? [])[g.graphEditVideoGenIndex ?? 0] ?? g.graphEditVideoGens?.[0];
    return sel?.path ? { kind: "video", rel: sel.path } : null;
  }
  if (g.graphOutputSource === "ref" && g.graphOutputRefId) {
    // A member frame cited as a reference node (`seqframe:<shotId>`).
    const frameShotId = /^seqframe:(.+)$/.exec(g.graphOutputRefId)?.[1];
    if (frameShotId) {
      const shot = ctx.shots.find((s) => s.id === frameShotId);
      return shot?.artwork ? { kind: "image", rel: shot.artwork } : null;
    }
    const ref = ctx.refs?.find((r) => r.id === g.graphOutputRefId);
    if (!ref) return null;
    if (ref.media === "video" && ref.mediaPath) return { kind: "video", rel: ref.mediaPath };
    return ref.imagePath ? { kind: "image", rel: ref.imagePath } : null;
  }
  return null;
}

/** The output clip when the binding is a video (image bindings resolve to
 *  undefined) — the sequence's `videoPath` in animatic terms. */
export function sequenceVideoPath(
  seq: ShotSequence,
  ctx: { shots?: readonly SequenceShotView[]; refs?: readonly SequenceOutputRefView[] } = {}
): string | undefined {
  const media = sequenceOutputMedia(seq, { shots: ctx.shots ?? [], refs: ctx.refs });
  return media?.kind === "video" ? media.rel : undefined;
}

/** Store a freshly generated clip on one of the sequence's video nodes
 *  (newest first, selected), creating the node when absent. Mirrors
 *  `recordGraphVideoGen`. */
export function recordSequenceVideoGen(seq: ShotSequence, nodeId: string, rel: string, prompt: string, model: string): void {
  const g = (seq.graph ??= { id: seq.id, number: seq.name, audio: "", visual: "" });
  const id = nodeId || "vid0";
  const nodes = (g.graphVideoNodes ??= []);
  let node = nodes.find((n) => n.id === id);
  if (!node) {
    node = { id, prompt: "" };
    nodes.push(node);
  }
  const item: GraphGenItem = { path: rel, prompt, model, at: new Date().toISOString() };
  node.gens = [item, ...(node.gens ?? [])];
  node.genIndex = 0;
}

/** One projected timeline slot: a single shot, or a collapsed sequence. */
export interface SequenceTimelineItem {
  kind: "shot" | "sequence";
  /** Shot id, or `seq:<sequenceId>`. */
  id: string;
  /** Shot number, or the sequence name. */
  number: string;
  durationSec: number;
  /** For shots: the board frame (the thumbnail bust). For sequences: the
   *  output's held still when the output is an image, else the first member's
   *  frame as the clip poster; `undefined` = slate. */
  artwork?: string;
  /** The output clip (video outputs only). */
  videoPath?: string;
  muted?: boolean;
  /** Slip offset into the clip in seconds (absent = 0). */
  videoOffsetSec?: number;
  /** Set for `kind: "sequence"`. */
  sequenceId?: string;
  /** Member shot ids (the shot itself for `kind: "shot"`). */
  shotIds: string[];
}

/** The minimal shot shape the projection reads. Structural so the animatic can
 *  pass its flat list without importing `Production`. */
export interface SequenceShotView {
  id: string;
  number: string;
  durationSec?: number;
  artwork?: string;
  videoPath?: string;
  muted?: boolean;
  videoOffsetSec?: number;
  /** Disabled shots are dropped from the projection (animatic + export). */
  disabled?: boolean;
}

/**
 * Repair a persisted slip offset: a finite, non-negative source position, or
 * undefined when absent/unusable (absent = play from the top). Pure so the
 * projection, the read repair, and the renderer's drag clamp share it.
 */
export function sanitizeVideoOffset(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.round(raw * 10) / 10;
}

export function sequenceTimelineId(sequenceId: string): string {
  return `seq:${sequenceId}`;
}

export function parseSequenceTimelineId(id: string): string | null {
  return id.startsWith("seq:") ? id.slice(4) : null;
}

/**
 * Project the flat shot list into animatic/export slots: every enabled
 * sequence whose members sit in one contiguous run of the list collapses into
 * a single item at the run's first slot (the span's frames are replaced), and
 * everything else passes through as shot items.
 *
 * Contiguity is a guard, not a nicety: a span broken by a later reorder plays
 * its shots individually (like a disabled sequence) instead of hiding an
 * unrelated shot that landed between the members. The block shows the
 * sequence's OUTPUT media (the frame output node's binding): a clip plays over
 * the window, a still is held, and an unbound output projects a pure slate
 * block — the same placeholder a blank shot gets.
 */
export function applyShotSequences(
  shots: SequenceShotView[],
  sequences: ShotSequence[],
  refs?: readonly SequenceOutputRefView[]
): SequenceTimelineItem[] {
  // Disabled shots are removed from the animatic/export entirely — they never
  // occupy a slot, and sequences prune them like dead members (collapsing
  // over the survivors).
  const live = shots.filter((s) => !s.disabled);
  const index = new Map<string, number>();
  live.forEach((s, i) => {
    if (!index.has(s.id)) index.set(s.id, i);
  });
  const consumed = new Set<string>();
  const at = new Map<number, SequenceTimelineItem>();
  for (const seq of sequences) {
    if (!seq || seq.enabled === false) continue;
    const idxs = [...new Set(seq.shotIds)]
      .map((id) => index.get(id))
      .filter((i): i is number => i !== undefined)
      .sort((a, b) => a - b);
    if (!idxs.length) continue;
    if (idxs.some((i) => consumed.has(live[i].id))) continue;
    let contiguous = true;
    for (let k = 1; k < idxs.length; k++) {
      if (idxs[k] !== idxs[k - 1] + 1) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;
    const members = idxs.map((i) => live[i]);
    const durationSec =
      typeof seq.durationSec === "number" && Number.isFinite(seq.durationSec) && seq.durationSec > 0
        ? seq.durationSec
        : members.reduce((n, s) => n + (s.durationSec ?? 3), 0);
    const media = sequenceOutputMedia(seq, { shots: live, refs });
    at.set(idxs[0], {
      kind: "sequence",
      id: sequenceTimelineId(seq.id),
      number: seq.name || "Sequence",
      durationSec,
      // Image output: the still is held for the window (and is the strip
      // poster). Video output: the clip plays and the first member's frame is
      // the poster. Unbound: no poster — a pure slate block.
      artwork: media ? (media.kind === "image" ? media.rel : members[0].artwork) : undefined,
      videoPath: media?.kind === "video" ? media.rel : undefined,
      muted: seq.muted,
      videoOffsetSec: sanitizeVideoOffset(seq.videoOffsetSec),
      sequenceId: seq.id,
      shotIds: members.map((s) => s.id),
    });
    for (const s of members) consumed.add(s.id);
  }
  const out: SequenceTimelineItem[] = [];
  live.forEach((s, i) => {
    const seqItem = at.get(i);
    if (seqItem) {
      out.push(seqItem);
      return;
    }
    if (consumed.has(s.id)) return;
    out.push({
      kind: "shot",
      id: s.id,
      number: s.number,
      durationSec: s.durationSec ?? 3,
      artwork: s.artwork,
      videoPath: s.videoPath,
      muted: s.muted,
      videoOffsetSec: sanitizeVideoOffset(s.videoOffsetSec),
      shotIds: [s.id],
    });
  });
  return out;
}

/**
 * Read-side repair of a persisted `shotSequences` array (it can come from an
 * old or hand-edited file): dead member ids are pruned, duplicates dropped,
 * accents/durations repaired, the legacy flat `videoNodes`/`output`/
 * `graphLayout` model folds into `graph`, and sequences left with no live
 * member vanish. Their clips are preserved by the write-side
 * `removeShotSequence` paths (bar delete, last-member shot delete, re-ingest),
 * which save the video as a reference first — this stays pure and never
 * touches files. Outdated panels count as live members (the caller includes
 * them), so a re-ingest preserves sequences whole.
 */
export function normalizeShotSequences(
  raw: unknown,
  liveShotIds: ReadonlySet<string>,
  liveRefIds?: ReadonlySet<string>
): ShotSequence[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ShotSequence[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    if (!id || seen.has(id)) continue;
    const shotIds = [...new Set((Array.isArray(e.shotIds) ? e.shotIds : []).filter((s): s is string => typeof s === "string" && liveShotIds.has(s)))];
    if (!shotIds.length) continue;
    const seq: ShotSequence = {
      id,
      name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : "Sequence",
      shotIds,
      accent: normalizeSequenceAccent(e.accent),
    };
    if (e.enabled !== undefined) seq.enabled = e.enabled !== false;
    if (e.muted !== undefined) seq.muted = !!e.muted;
    if (typeof e.durationSec === "number" && Number.isFinite(e.durationSec) && e.durationSec > 0) seq.durationSec = e.durationSec;
    const offset = sanitizeVideoOffset(e.videoOffsetSec);
    if (offset != null) seq.videoOffsetSec = offset;
    if (typeof e.createdAt === "string") seq.createdAt = e.createdAt;
    // The graph state (the sequence canvas). A stored one is kept as-is
    // (main-owned generation history must survive); the legacy flat model
    // (top-level `videoNodes` + `output` + `graphLayout`) folds into it.
    const keepInput = (s: unknown): s is string =>
      typeof s === "string" && s.length > 0 && (liveShotIds.has(s) || liveRefIds === undefined || liveRefIds.has(s));
    if (e.graph && typeof e.graph === "object") {
      const g = { ...(e.graph as ProductionShot) };
      g.id = id;
      g.number = seq.name;
      if (Array.isArray(g.graphVideoNodes)) {
        g.graphVideoNodes = g.graphVideoNodes
          .filter((n): n is GraphVideoNode => !!n && typeof n === "object" && typeof (n as GraphVideoNode).id === "string")
          .map((n) => (Array.isArray(n.refIds) ? { ...n, refIds: [...new Set(n.refIds.filter(keepInput))] } : n));
      }
      seq.graph = g;
    } else {
      const legacyNodes = Array.isArray(e.videoNodes)
        ? e.videoNodes.filter((n): n is GraphVideoNode => !!n && typeof n === "object" && typeof (n as GraphVideoNode).id === "string")
        : [];
      const legacyOutput = (e.output ?? null) as Record<string, unknown> | null;
      const legacyLayout = e.graphLayout && typeof e.graphLayout === "object" ? e.graphLayout : undefined;
      if (legacyNodes.length || legacyOutput || legacyLayout) {
        const g: ProductionShot = { id, number: seq.name, audio: "", visual: "" };
        if (legacyNodes.length) {
          g.graphVideoNodes = legacyNodes.map((n) => (Array.isArray(n.refIds) ? { ...n, refIds: [...new Set(n.refIds.filter(keepInput))] } : n));
        }
        if (legacyOutput && typeof legacyOutput === "object") {
          if (legacyOutput.kind === "videogen" && typeof legacyOutput.nodeId === "string") {
            g.graphOutputSource = "videogen";
            g.graphOutputVideoNodeId = legacyOutput.nodeId;
          } else if (legacyOutput.kind === "ref" && typeof legacyOutput.refId === "string") {
            g.graphOutputSource = "ref";
            g.graphOutputRefId = legacyOutput.refId;
          } else if (legacyOutput.kind === "frame" && typeof legacyOutput.shotId === "string") {
            g.graphOutputSource = "ref";
            g.graphOutputRefId = `seqframe:${legacyOutput.shotId}`;
          }
        }
        if (legacyLayout) g.graphLayout = legacyLayout as ProductionShot["graphLayout"];
        seq.graph = g;
      }
    }
    // The timed timeline is the sequence canvas's prompt structure. A stored
    // one is repaired; a legacy sequence (no timeline yet) seeds one from its
    // members and strips the old `@[Shot NNNN]` frame citations (frames are
    // timeline segments now, not prompt tags). Every sequence canvas also shows
    // the video generator node (its takes/picks/output ride it).
    const g = seq.graph ?? (seq.graph = { id, number: seq.name, audio: "", visual: "" });
    const stored = g.graphSequence?.segments
      ? normalizeSequenceSegments(g.graphSequence.segments.filter((s) => liveShotIds.has(s.shotId)))
      : [];
    if (stored.length) {
      g.graphSequence = { segments: stored };
    } else {
      g.graphSequence = { segments: seedSequenceSegments(shotIds.map((shotId) => ({ shotId }))) };
      if (Array.isArray(g.graphVideoNodes)) {
        g.graphVideoNodes = g.graphVideoNodes.map((n) => ({ ...n, prompt: stripSequenceFrameTags(n.prompt ?? "") }));
      }
    }
    if (!Array.isArray(g.graphVideoNodes) || g.graphVideoNodes.length === 0) {
      g.graphVideoNodes = [{ id: "vid0", prompt: "" }];
    }
    out.push(seq);
    seen.add(id);
  }
  return out;
}

/** One measured storyboard card the sequence bar spans. */
export interface SequenceCardRect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** One bar segment: the union band of a grid row of selected cards. */
export interface SequenceBarSpan {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Group measured cards into grid rows and return one span per row (leftmost
 * left → rightmost right). The storyboard grid reflows as cards wrap, so the
 * bar is computed from the cards' actual rects — one spanning bar per row that
 * survives any window width / frame-size change. Rows group by vertical
 * overlap: same-row cards share a top edge under CSS grid stretch.
 */
export function sequenceBarSpans(rects: SequenceCardRect[]): SequenceBarSpan[] {
  const sorted = rects
    .filter((r) => Number.isFinite(r.left) && Number.isFinite(r.top) && r.right > r.left && r.bottom > r.top)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const rows: SequenceCardRect[][] = [];
  for (const r of sorted) {
    const cy = (r.top + r.bottom) / 2;
    const row = rows.find((rs) => {
      const top = Math.min(...rs.map((x) => x.top));
      const bottom = Math.max(...rs.map((x) => x.bottom));
      return cy >= top && cy < bottom;
    });
    if (row) row.push(r);
    else rows.push([r]);
  }
  return rows.map((rs) => ({
    left: Math.min(...rs.map((r) => r.left)),
    top: Math.min(...rs.map((r) => r.top)),
    right: Math.max(...rs.map((r) => r.right)),
    bottom: Math.max(...rs.map((r) => r.bottom)),
  }));
}
