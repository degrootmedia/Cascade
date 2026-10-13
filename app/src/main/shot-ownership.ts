/**
 * The ProductionShot field-ownership table (architecture hardening
 * workstream 1, recommendation 6 of the brief).
 *
 * Until whole-project saves and mirrored fields are gone, the merge layer
 * (`mergeRendererShot` in productions.ts) must arbitrate every field a
 * renderer snapshot can carry. Its rules should be complete by construction —
 * this table classifies EVERY `ProductionShot` field, and the compile-time
 * `Record<keyof ProductionShot, …>` fails the build the moment a field is
 * added without a declared owner and merge policy (the same coverage-contract
 * pattern the Settings registry uses for settings keys).
 *
 * The merge layer derives its DENIED set from this table
 * (`SHOT_MERGE_DENIED_FIELDS`), so the documentation and the code cannot
 * drift apart. Adding a field therefore means answering four questions:
 * who owns it, how a whole-document save treats it, what the legacy merge
 * rule is, and whether it is persisted or derived.
 */
import type { ProductionShot } from "../shared/ipc.js";

/** Who may change the field's authoritative value. */
export type ShotFieldOwner = "main" | "renderer" | "command" | "derived" | "deprecated";

/** How a whole-document renderer save (`applyRendererState`) treats the field. */
export type ShotFieldMerge =
  /** Never accepted from a renderer save (the field lands in the DENIED set). */
  | "deny"
  /** Denied, then re-anchored main-side via `takeGenIndex` (a selected index). */
  | "index"
  /** Skipped in the generic copy loop; merged by a dedicated rule below it. */
  | "special"
  /** Renderer-owned: copied verbatim from the snapshot. */
  | "copy";

export interface ShotFieldPolicy {
  owner: ShotFieldOwner;
  merge: ShotFieldMerge;
  /** What the rule protects / why the field is owned where it is. */
  note: string;
}

export const SHOT_FIELD_OWNERSHIP: Record<keyof ProductionShot, ShotFieldPolicy> = {
  id: { owner: "main", merge: "deny", note: "Stable identity — survives renumbering and reordering." },
  number: { owner: "main", merge: "deny", note: "Derived 4-digit display number; renumbering owns it." },
  audio: { owner: "renderer", merge: "copy", note: "Script column A — user-entered text." },
  visual: { owner: "renderer", merge: "copy", note: "Script column B — user-entered text." },
  artwork: { owner: "command", merge: "deny", note: "The ref-output store (a ref-piped frame has no node history) plus the legacy read for unpiped docs. Written main-side only by the ref-output write-through (applyRefToOutput/importBoard*) and the one-time load migration — never by a renderer save; every surface resolves the pipe live." },
  artworkHistory: { owner: "main", merge: "deny", note: "Frame history recorded by main's recordBoardArtwork; a stale echo must not truncate it." },
  videoPath: { owner: "command", merge: "deny", note: "The ref-output store (a dropped clip) plus the legacy read for unpiped docs. Written main-side only by the ref-output write-through and the load migration — never by a renderer save." },
  muted: { owner: "renderer", merge: "copy", note: "Animatic block mute toggle." },
  videoOffsetSec: { owner: "renderer", merge: "copy", note: "Animatic slip offset (right-drag)." },
  durationSec: { owner: "renderer", merge: "copy", note: "Planned screen time." },
  style: { owner: "renderer", merge: "copy", note: "Per-shot style pick (id, or legacy raw text)." },
  styleNone: { owner: "renderer", merge: "copy", note: "User picked None for this shot's style." },
  refIds: { owner: "renderer", merge: "copy", note: "Explicitly attached reference ids." },
  refExcluded: { owner: "renderer", merge: "copy", note: "Auto-matched references the user unchecked." },
  prompt: { owner: "renderer", merge: "copy", note: "Board prompt override (also written main-side for auto-derived prompts)." },
  promptManual: { owner: "renderer", merge: "copy", note: "Hand-edited prompt marker — survives re-ingestion." },
  includeBrandIdentity: { owner: "renderer", merge: "copy", note: "Opt-in brand inclusion in the board prompt." },
  refPromptOverrides: { owner: "renderer", merge: "copy", note: "Per-reference prompt overrides for this frame." },
  graphLayout: { owner: "renderer", merge: "copy", note: "Canvas positions/sizes/collapsed/viewport — viewport preferences." },
  graph: { owner: "renderer", merge: "copy", note: "Stored graph wiring (nodes + edges); normalized on read." },
  graphImageGens: { owner: "main", merge: "deny", note: "Image node's stored outputs — generation results." },
  graphImageGenIndex: { owner: "main", merge: "index", note: "Image node's selected take; re-anchored by takeGenIndex." },
  graphImageParams: { owner: "renderer", merge: "copy", note: "Image node's advanced params." },
  graphImageModel: { owner: "renderer", merge: "copy", note: "Image node's own model pick." },
  graphImageResolution: { owner: "renderer", merge: "copy", note: "Image node's own resolution pick." },
  graphVideoGens: { owner: "deprecated", merge: "deny", note: "Migrated into graphVideoNodes[0] on load; main owns the fold." },
  graphVideoGenIndex: { owner: "deprecated", merge: "index", note: "Migrated into graphVideoNodes[0].genIndex; re-anchored by takeGenIndex." },
  graphVideoPrompt: { owner: "deprecated", merge: "copy", note: "Migrated into graphVideoNodes[0].prompt; stripped post-merge by migrateVideoNodes." },
  graphVideoModel: { owner: "deprecated", merge: "copy", note: "Migrated into graphVideoNodes[0].model; stripped post-merge." },
  graphVideoResolution: { owner: "deprecated", merge: "copy", note: "Migrated into graphVideoNodes[0].resolution; stripped post-merge." },
  graphVideoDurationSec: { owner: "deprecated", merge: "copy", note: "Migrated into graphVideoNodes[0].durationSec; stripped post-merge." },
  graphVideoParams: { owner: "deprecated", merge: "copy", note: "Migrated into graphVideoNodes[0].params; stripped post-merge." },
  graphVideoNodes: { owner: "renderer", merge: "special", note: "Node membership is renderer-owned; each surviving node's gens/genIndex stay main-owned (mergeGraphNodes)." },
  graphOutputVideoNodeId: { owner: "renderer", merge: "copy", note: "Which video node feeds the output (pipe selection)." },
  graphEditNodes: { owner: "renderer", merge: "special", note: "Edit-node membership is renderer-owned; gens/genIndex stay main-owned (mergeGraphNodes)." },
  graphOutputEditNodeId: { owner: "renderer", merge: "copy", note: "Which edit node feeds the output (pipe selection)." },
  graphVideoSourceEditNodeId: { owner: "deprecated", merge: "copy", note: "Migrated into graphVideoNodes[*].source." },
  graphEditGens: { owner: "deprecated", merge: "deny", note: "Migrated into graphEditNodes[0].gens on load." },
  graphEditGenIndex: { owner: "deprecated", merge: "copy", note: "Migrated into graphEditNodes[0].genIndex; stripped post-merge." },
  graphEditPrompt: { owner: "renderer", merge: "copy", note: "The classic Edit-frame popup's draft prompt." },
  graphEditImageSource: { owner: "deprecated", merge: "copy", note: "Migrated into graphEditNodes[0].source." },
  graphEditSourceRefId: { owner: "deprecated", merge: "copy", note: "Migrated into graphEditNodes[0].source." },
  graphVideoRefIds: { owner: "deprecated", merge: "copy", note: "Migrated into graphVideoNodes[*].refIds." },
  graphImageToVideo: { owner: "deprecated", merge: "copy", note: "Migrated into graphVideoNodes[*].source." },
  graphEditToVideo: { owner: "deprecated", merge: "copy", note: "Migrated into graphVideoNodes[*].source." },
  graphVideoSourceRefId: { owner: "deprecated", merge: "copy", note: "Migrated into graphVideoNodes[*].source." },
  graphTweenRefIds: { owner: "renderer", merge: "copy", note: "In-betweener keyframe source ids (pruned by syncTweenBlocks)." },
  graphTweenBlocks: { owner: "renderer", merge: "special", note: "Block membership/prompts/timing are renderer-owned; each block's gens/genIndex stay main-owned (mergeTweenBlocks)." },
  graphTweenModel: { owner: "renderer", merge: "copy", note: "In-betweener model pick." },
  graphTweenResolution: { owner: "renderer", merge: "copy", note: "In-betweener output resolution." },
  graphEditVideoGens: { owner: "deprecated", merge: "deny", note: "Migrated into graphVideoNodes (ev0); main owns the fold." },
  graphEditVideoGenIndex: { owner: "deprecated", merge: "index", note: "Migrated into graphVideoNodes (ev0.genIndex); re-anchored by takeGenIndex." },
  graphEditVideoPrompt: { owner: "deprecated", merge: "deny", note: "Legacy flat edit-video field — a stale echo could re-synthesize a deleted ev0 (migrateEditVideoNodes' guard)." },
  graphEditVideoModel: { owner: "deprecated", merge: "deny", note: "Legacy flat edit-video field (see graphEditVideoPrompt)." },
  graphEditVideoResolution: { owner: "deprecated", merge: "deny", note: "Legacy flat edit-video field (see graphEditVideoPrompt)." },
  graphEditVideoParams: { owner: "deprecated", merge: "deny", note: "Legacy flat edit-video field (see graphEditVideoPrompt)." },
  graphEditVideoRefIds: { owner: "deprecated", merge: "deny", note: "Legacy flat edit-video field (see graphEditVideoPrompt)." },
  graphEditVideoSourceRefId: { owner: "deprecated", merge: "deny", note: "Legacy flat edit-video field (see graphEditVideoPrompt)." },
  graphVideoToEditVideo: { owner: "deprecated", merge: "deny", note: "Legacy flat edit-video field (see graphEditVideoPrompt)." },
  graphTweenParams: { owner: "renderer", merge: "copy", note: "In-betweener advanced params (aspect_ratio lives here)." },
  graphCameraGrid: { owner: "renderer", merge: "special", note: "Camera-grid state: renderer owns wiring/picks; main owns sheetPath/sheetAt/generation (mergeCameraGrid)." },
  graphUpscale: { owner: "renderer", merge: "special", note: "Upscale state: renderer owns wiring/picks; main owns gens/genIndex (mergeUpscale)." },
  graphSequence: { owner: "renderer", merge: "copy", note: "Sequence-canvas timeline (segments); merged via mergeShotSequences for the sub-document." },
  graphTweenOutput: { owner: "main", merge: "deny", note: "The stitched tween clip — written by main's stitch/unstitch; a stale echo must not revert it." },
  graphTweenReencoded: { owner: "main", merge: "deny", note: "Stitch codec flag — main-only; the renderer never writes it." },
  graphStyleConnected: { owner: "renderer", merge: "copy", note: "Style plug state for the image prompt (composer)." },
  graphVideoStyleConnected: { owner: "deprecated", merge: "copy", note: "Migrated into graphVideoNodes[*].styleConnected." },
  graphEditStyleConnected: { owner: "deprecated", merge: "copy", note: "Migrated into the edit node's styleConnected." },
  graphOutputSource: { owner: "renderer", merge: "copy", note: "Which node is piped into the output. (Workstream 2 moves selection onto a dedicated command.)" },
  graphOutputRefId: { owner: "renderer", merge: "copy", note: "The reference feeding the output when graphOutputSource === \"ref\"." },
  graphMigrated: { owner: "main", merge: "deny", note: "One-time migration marker — main-only." },
  pendingImageGen: { owner: "main", merge: "deny", note: "Async vendor job contingency — written by providers, reclaimed by recheckBoard." },
  pendingVideoGen: { owner: "main", merge: "deny", note: "Async vendor job contingency — written by providers, reclaimed by recheckVideo." },
  disabled: { owner: "renderer", merge: "copy", note: "Storyboard hide toggle." },
  outdated: { owner: "main", merge: "deny", note: "Set by ingest's archiveShotsToOutdated; the renderer never writes it." },
  outdatedAt: { owner: "main", merge: "deny", note: "Archive timestamp — main-only." },
};

/** Fields a whole-document renderer save may never write — derived from the
 *  table so `mergeRendererShot`'s DENIED set and the classification cannot
 *  drift apart. */
export const SHOT_MERGE_DENIED_FIELDS: (keyof ProductionShot)[] = (
  Object.keys(SHOT_FIELD_OWNERSHIP) as (keyof ProductionShot)[]
).filter((k) => SHOT_FIELD_OWNERSHIP[k].merge === "deny");

/** Denied selection indexes, re-anchored main-side via `takeGenIndex`. */
export const SHOT_INDEX_FIELDS: (keyof ProductionShot)[] = (
  Object.keys(SHOT_FIELD_OWNERSHIP) as (keyof ProductionShot)[]
).filter((k) => SHOT_FIELD_OWNERSHIP[k].merge === "index");

/** Fields merged by a dedicated rule — skipped in `mergeRendererShot`'s
 *  generic copy loop (`artwork`/`videoPath` mirrors + the per-node/block
 *  state merges). Derived from the table so the merge and the classification
 *  cannot drift. */
export const SHOT_SPECIAL_FIELDS: (keyof ProductionShot)[] = (
  Object.keys(SHOT_FIELD_OWNERSHIP) as (keyof ProductionShot)[]
).filter((k) => SHOT_FIELD_OWNERSHIP[k].merge === "special");
