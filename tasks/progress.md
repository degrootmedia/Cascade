# Progress log

Append a few lines at the end of every session: completed, blocked, next.

## 2026-10-31 - harness-improvements
- Completed: H1 (stop gate, auto-format, lint), H2 (rules in CASCADE.md + tasks/batch-preamble.md), H3 (lessons split; guards in app/test/lessons-guards.test.ts).
- Blocked: nothing. Two lessons (magicPrompts single-writer, model capability classification) still have no automated check.
- Next: finish H4 (scoreboard), then H5 reviewer, then H6 UI verification kit.

## 2026-11-02 - graphite theme + icon sets (user request, outside batch-state)
- Completed: third theme "Graphite" (neutral #151517/#1b1b1c/#2c2c2e, white text) and switchable icon sets in Settings → Appearance: original set named "Colorful", new "Minimal" single-color outline set (25 glyphs in assets/icons/minimal/, CSS-mask tinted by --icon-tint: white on dark/graphite, #333 on Light XSI). iconSet persisted like theme (settings.json + localStorage boot cache + detached window). Tests: theme/theme-css/icons/settings-panel extended, all green; full app suite 2117 passed with only the 2 pre-existing lessons-guards failures (group node equality, magicDismissedRefs rebase) already red at session start; ui:verify clean + live probe of graphite/minimal/light tint and persistence.
- Blocked: nothing.
- Next: H5 fresh-eyes reviewer remains the open batch item.

## 2026-11-02 - animatic-expansion A1
- Completed: A1 multi-track timeline data model (shared/ipc/timeline.ts), Production.timeline field + persistence seams, assemblyPlanFromTimeline with fixture plan/EDL equality; batch reseeded to animatic-expansion (A1 passing). Gate: tsc clean; full vitest 2141 passed, 2 failures both A/B-proven pre-existing on HEAD (lessons-guards: `group` node equality left for its own batch; rebase copy-list fixed by registering timeline + magicDismissedRefs).
- Blocked: nothing.
- Next: A2 — split/trim/slip/roll/slide/ripple + linked clips as pure ops on the model.

## 2026-11-02 - animatic-expansion A2
- Completed: A2 pure edit ops in shared/ipc/timeline.ts (split/playhead-split, trim+ripple, slip, roll, slide, move, delete+ripple, link/unlink; linkId + singleton pruning). Tests: timeline-ops.test.ts 27 (red-first). Gate: tsc clean; full vitest 2164 passed / 1 failed (pre-existing `group` guard); prompt-focus-switch + tween failed to collect in the full run (sandbox EPERM, known flake) and pass alone 54/54.
- Blocked: nothing.
- Next: A3 — timeline UI essentials (track headers, gestures, snapping, selection, waveforms/filmstrips, undo/redo), then the Phase 1 fresh-eyes reviewer gate.

## 2026-11-02 - animatic-expansion A3
- Completed: A3 TimelineEditor (production/timeline-editor.tsx) mounted in Step 4: track headers, frame-grid playhead, zoom, selection (click/shift/marquee), A2 ops behind drags with live clamped previews, snapping toggle, ripple toggle+scope, S split, Delete, undo/redo via saveField, add track/clip-from-shot, filmstrips + waveform canvases. Tests: timeline-editor.test.ts 5/5. Gate: tsc clean; full vitest 2174 passed / 1 failed (pre-existing `group` guard); build clean; ui:verify exit 0 no renderer errors (tasks/screenshots/2026-11-02T14-43-28-695Z; first attempt hit a harness screenshot timeout with a clean app, retry passed).
- Blocked: Phase 1 reviewer gate needs GAB_API_KEY (absent in agent env; attempted, exits 1 by design). Operator: `cd core && npm run review -- --spec <expansion spec>` before Phase 2.
- Next: A4 — per-clip constant speed + reverse (shared timing lands here).

## 2026-11-02 - animatic-expansion A4
- Completed: A4 constant speed + reverse end to end: speed/reversed model fields, derived durations via clipSpeed, shared source-time mapping, A2 ops speed-aware, setClipSpeed op, assembly speed carriage (setpts/atempo/reverse in buildNormalizeArgs, EDL notes, manifest flags, JSX comments, renderTimelineAnimatic), editor Speed presets + Reverse + labels. Tests: timeline-speed.test.ts 14, timeline-render-ffmpeg.test.ts 2 (real FFmpeg, ASSEMBLY_E2E=1: exact 10s + reverse pixel order), editor +1. Gate: tsc clean; full vitest 2182 passed / 1 failed (pre-existing `group` guard).
- Blocked: reviewer gate still pending operator GAB_API_KEY run.
- Next: A5 — speed ramps as keyframed curves + ramp editor UI.

## 2026-11-02 - animatic-expansion A5
- Completed: A5 speed ramps: speedCurve model with closed-form integral timing (duration/source mapping exact), curve-aware split/slip/trim/roll/slide, setClipSpeedCurve, piecewise setpts render expression + average-tempo audio + opt-in minterpolate, ramp editor on the clip (dots, double-click add, alt-click delete, presets per keyframe). Tests: timeline-ramp 12, ramp E2E 2 (real FFmpeg integral duration + pixels), editor 7. Gate: tsc clean; full vitest 2153/1 (pre-existing group guard; editor suite collection-flaked in-run, passes alone).
- Blocked: reviewer gate still pending operator GAB_API_KEY run.
- Next: A6

## 2026-11-02 - animatic-expansion A6
- Completed: A6 proxies + preview rewire: 720p proxies under `out/proxies` (short GOP, faststart, mtime freshness, ledger-recorded generation job), provably never consumed by render (assembly plan pinned to originals while proxies exist on disk). Preview now reads `resolveTimeline` via an `AnimaticTimeline` override mode: proxies preferred, `sourceAt` maps through speed/reverse/ramps exactly, playback rate follows the source curve, legacy gestures inert in timeline mode. VO/music preview beds come from timeline role clips (first audible each until A7/A9); legacy bed paths preserved. Gate: tsc clean; full vitest 2213 (1 pre-existing `group` guard; one run had a 2nd collection flake, passed on rerun); build + ui:verify pass.
- Blocked: reviewer gate still pending operator GAB_API_KEY run.
- Next: A7 — audio editing basics (gain, fades, meters, pitch).

## 2026-11-02 - animatic-expansion A7
- Completed: A7 audio basics: clip fades/pitchMode + track volume in the model with one shared `clipGainAt`; pure `setClipAudio`/`setTrackVolume`; split/trim fade integrity. Render encodes gain/fades post-retime (default args byte-identical), preserve-pitch via atempo and opt-in natural via asetrate; beds fade in the mix. Preview plays the same gain curves (beds + embedded video audio) with a transport meter from decoded bed buffers. Editor gains volume line, corner fade handles, track slider, and a Pitch preserved/shifted toggle. Gate: tsc clean; full vitest 2236 (1 pre-existing `group` guard); ASSEMBLY_E2E 7/7 (fade-end near silence; 440 Hz kept at 2x preserve, ~880 Hz natural); build + ui:verify pass.
- Blocked: reviewer gate still pending operator GAB_API_KEY run.
- Next: A8 cross-dissolve transitions as timeline data.

## 2026-11-02 - animatic-expansion A8
- Completed: A8 cross-dissolves as timeline data (centered convention): handle-aware set/remove op (refuses past known handles, editor clamps and states the max), resolver blend spans, ops prune/remap integrity, plan blend events rendered via dual Pass-A segments + xfade/acrossfade, EDL `D` transitions, JSX opacity crossfade layers, manifest flags. Preview stacks the outgoing clip under a fading-in incoming (video↔video; stills cut in preview only). Removal restores the exact prior timeline. Gate: tsc clean; full vitest 2254 (1 pre-existing `group` guard, name-verified); ASSEMBLY_E2E 9/9 (dissolve midpoint measures both sources, duration unchanged); build + ui:verify pass.
- Blocked: reviewer gate still pending operator GAB_API_KEY run.
- Next: A9 assembly/render integration (progress, cancel, ledger; shipping path onto the timeline).

## 2026-11-02 - animatic-expansion A9
- Completed: A9 render integration: shipping assemble/render read the unified timeline plan (seeded in-memory for legacy productions); one render pipeline with a generalized audio mix (every audible clip, not just beds); renders are ledger jobs with progress and cooperative cancel (ffmpeg killed mid-flight); tmp-then-rename output so cancels never present a partial render.mp4. Gate: tsc clean; full vitest 2262 (1 pre-existing `group` guard); ASSEMBLY_E2E 11/11 incl. every-feature acceptance render; build + ui:verify pass. Two existing tests updated for the intended contracts (additive plan audioEvents; tmp output path).
- Blocked: reviewer gate still pending operator GAB_API_KEY run.
- Next: A10 FCPXML export + export report.

## 2026-11-02 - animatic-expansion A10
- Completed: A10 FCPXML 1.10 export from the timeline model (spine/lanes, timeMaps with exact end frames, dissolves, levels/fades) + saved/logged export report, wired into assemble(). Gate: tsc clean; full vitest 2267 (sole failure = pre-existing `group` guard); build + ui:verify pass. Manual FCP/Resolve import remains operator-side (A14).
- Blocked: reviewer gate still pending operator GAB_API_KEY run.
- Next: A11 Premiere XML (xmeml) export + report.

## 2026-11-02 - animatic-expansion A11
- Completed: A11 Premiere XML (xmeml v5) from the timeline model: frame-exact clipitems, time-remap speeds (negative reverse), average-speed ramps (stated), centered dissolves, audio level/fade keyframes, saved + logged export report via assemble(). Gate: tsc clean; full vitest 2272 (sole pre-existing `group` failure); build + ui:verify pass.
- Blocked: reviewer gate still pending operator GAB_API_KEY run.
- Next: A12 EDL per track + ramp baking.

## 2026-11-02 - animatic-expansion A12
- Completed: A12 per-video-track CMX3600 EDLs with M2 motion lines and ramp baking (keyframe-split constant-speed segments; exact total duration and source consumption), flattened EDL gains M2 too, saved + logged EDL report via assemble(). Gate: tsc clean; full vitest 2277 (sole pre-existing `group` guard, name-verified); build + ui:verify pass.
- Blocked: reviewer gate still pending operator GAB_API_KEY run.
- Next: A13 After Effects JSX native time remapping for ramps.

## 2026-11-02 - animatic-expansion A13
- Completed: A13 JSX native time remapping: ramped layers get ADBE Time Remapping keyframes from the curve integral (endpoints exact, reversed descending), dissolve layers included; constant speeds unchanged. Gate: tsc clean; full vitest 2280 (sole pre-existing `group` guard); build + ui:verify pass.
- Blocked: reviewer gate still pending operator GAB_API_KEY run.
- Next: A14 torture-test fixture + manual round-trip checklist (final item).

## 2026-11-02 - animatic-expansion A14 (batch complete)
- Completed: A14 torture fixture + golden exports for every format + gated golden render + `docs/animatic-export-roundtrip.md` manual checklist. The fixture caught and fixed a real render hang (muted+reversed areverse over infinite silence). Final gate: tsc clean; full vitest 2284 (sole pre-existing `group` guard failure, present before the batch); ASSEMBLY_E2E 16/16; build + ui:verify pass. **Batch `animatic-expansion` A1–A14 complete.**
- Blocked (operator-side, unchanged): Phase 1 fresh-eyes reviewer (`GAB_API_KEY`), manual FCP/Premiere/Resolve/AE round-trips per the checklist.
- Next: none in this batch.

## 2026-11-03 - old animatic strip replaced by the multi-track timeline
- Completed: the deprecated shot-strip `AnimaticTimeline` is deleted. Step 4 is now one surface: `TimelinePreview` (extracted monitor: pooled videos, dissolve blend layer, beds, transport, meter, VO waveform) above `TimelineEditor`, sharing one playhead owned by the Step 4 `TimelineSection` (preview playback moves the editor playhead; editor scrubs seek + pause the preview). Timeline materializes (seed + save) on Step 4 open; `reconcileTimelineShotMedia` follows regenerated shot/sequence media kind-for-kind; `syncTimelineBeds` follows VO/music import/replace/remove (path-change gated so editor bed deletions stay deleted). Parity: `scaleTimelineToDuration` powers editor "Fit to VO" / "Fit total" and the VO-panel Fit button; per-clip mute toggle via `setClipAudio {muted}`. Removed: strip JSX/gestures/zoom/waveform-scroll, workspace shot-edit callbacks (`updateDurations`, offsets, sequence variants, `fitShotsToTotal`, `removeShotVideo`, shot/sequence mute toggles), helper modules `animatic-slip/edit/snap.ts` + their tests, 38 dead CSS rules, dead `videoStillSrc` thumb path. New/updated tests: timeline-scale-reconcile (12), timeline-preview-component (4), timeline-editor +3 (13), animatic-video-thumb rewritten. Gates: tsc clean; full vitest 2271 passed / 1 failed (sole pre-existing `group` guard; deleted strip tests account for the count delta vs 2284); ASSEMBLY_E2E 16/16; build + ui:verify pass (harness cannot reach Step 4 in a fresh profile - layout proven by component tests, manual visual check still worthwhile). Not committed.

## 2026-11-03 - Notion Bugs 2 and 4 (magic prompt on style change; suite prompt sticking)
- Completed: Item 1 (#2): `setGraphStyle`/`updateShotStyle` re-rendered the composer via `renderShotPrompt` (reads stored `shot.prompt`), swapping Magic text back to the original on every style change; new `rerenderComposerForStyle` in ProductionWorkspace preserves the displayed/magic content and re-derives only the Style paragraph. Item 2 (#4): earlier fix only covered generation-landing resync; the remaining cause was echo suppression in `TriplePrompt`/`PromptContentEditor` (+ graph `usePromptNodeDraft`) treating any previously-emitted text as an echo forever, so re-selecting a history entry whose prompt was typed in the same panel never updated the box. Suppression is now focus-gated (caret protection only while focused; unfocused = genuine navigation). Regression tests: graph-style-live +1 (magic + graph style change, refetch held back, stored magic entry survives blur-commit), suite-prompt-display +1 (type two prompts, click E1/E2/E1, panel+caption exact each time). Gates: typecheck clean for touched files (sole error pre-existing in untracked timeline-preview-component.test.ts, A/B-proven via stash); full vitest 2274 passed / 1 failed (sole pre-existing `group` guard) / 15 skipped; build clean. Not committed.
- Blocked: nothing.
- Next: none in this batch.
