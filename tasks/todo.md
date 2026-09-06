# Assembly Page (Step 5) â€” PLAN

Build Step 5 "Assembly" (currently a placeholder at `ProductionWorkspace.tsx:2327â€“2333`)
into the editor-handoff + render step: gather full-res media into an export folder, write an
EDL, write an After Effects rebuild script, and render the animatic to MP4.

**Status: IMPLEMENTED.**

## Context / decisions (already settled)

- **ffmpeg**: `ffmpeg-static` bundled, with system-`ffmpeg` fallback (`app/src/main/ffmpeg.ts`,
  `resolveFfmpeg()`). No ffmpeg/ffprobe today â€” this is all new machinery.
- **Export folder**: `out/assembly/` inside the production folder (reuses `assets.outDir` +
  a new `assets.assemblyDir: "assembly"`). Media gathered under `out/assembly/media/`
  (`shots/`, `clips/`, `audio/`). Render â†’ `out/assembly/render.mp4`.
- **Sources are all workspace-relative and already present**: board frames at
  `shot.artwork` (full-res original resolvable via `originalForJpegRel`), clips at
  `shot.videoPath`, timing at `shot.durationSec ?? 3`, `muted` per clip, audio at
  `p.voiceoverPath`/`p.musicPath` + volumes. Ordered sequence = `scenes.flatMap(s => s.shots)`.
- **Rule that mirrors the timeline**: a shot with a `videoPath` plays as a clip (still copied
  alongside for the storyboard); a shot with only `artwork` is a still; a shot with neither is
  **skipped** with a warning in the manifest (no black frames, no shifted timing â€” timeline is
  recomputed over included events only).
- **One deep module, all pure logic testable**: `app/src/main/assembly.ts`. String builders
  (EDL / AEScript / manifest / ffmpeg argv) are pure; `assemble()` does the copy+write I/O;
  `renderAnimatic()` takes an injected `runFfmpeg` so it's fakeable in tests.

## Data model (`app/src/shared/ipc.ts` + `productions.ts`)

- [x] `ProductionAssembly` interface: `{ fps, width, height, exportDir, assembledAt?,
      renderPath?, renderedAt?, totalSec?, skippedShots? }` â€” defaults `24 / 1920 / 1080`.
- [x] `Production.assembly?: ProductionAssembly` + `assets.assemblyDir` ("assembly");
      back-filled in `productions.ts` `normalize` + `applyRendererState`; `out/assembly/`
      scaffolded in `newProduction`.
- [x] No per-shot schema changes â€” everything derives from existing fields.

## New module `app/src/main/assembly.ts` (pure core, unit-tested)

- [x] `assemblyPlan(p)` â€” ordered events with cumulative `startSec`/`endSec`; stills resolve
      the full-res original (`originalForJpegRel`) falling back to `shot.artwork`; clips from
      `videoPath`; dedupe by `srcRel`; no-media shots â†’ `skipped[]`; audio with volumes.
- [x] `buildEdl(plan, fps, title)` â€” CMX3600 NON-DROP FRAME: 8-char reels (`SHOT0100`,
      `VOICE`, `MUSIC`), stills source in=out=`00:00:00:00`, clips source out =
      `min(probed, dur)` frames, cumulative record timecodes, `* FROM CLIP NAME:` comments,
      VO/music as A-track events. CRLF.
- [x] `buildAeScript(plan, cfg, exportRoot)` â€” ExtendScript `.jsx`: new project, comp at
      wÃ—hÃ—fpsÃ—totalSec; imports media relative to the script (`$.fileName`), layers per event
      with `startTime`/`outPoint`, `muted` â†’ `audioEnabled=false`, `20*log10(volume)` dB
      levels for VO/music beds; saves `Assembly.aep` next to the script. Paths escaped.
- [x] `buildManifest(plan, cfg, opts)` â€” markdown: per-shot mapping, skips, runtime/fps/res.
- [x] `buildNormalizeArgs` / `buildConcatList` / `buildConcatArgs` / `buildMixArgs` â€” pure
      argv builders for the 3-pass pipeline (below).
- [x] `assemble(p, cfg, emit, deps)` â€” I/O: copies media into `media/{shots,clips,audio}`,
      writes the 4 artifacts, probes clip/audio lengths when ffmpeg resolves, persists
      `p.assembly` bookkeeping. E2E-tested over a temp production folder.
- [x] `renderAnimatic(p, cfg, emit, deps)` â€” 3-pass pipeline via injected
      `runFfmpeg`/`probe`; per-shot progress lines; temp segments always cleaned up;
      returns the render rel path.

## ffmpeg seam `app/src/main/ffmpeg.ts`

- [x] `resolveFfmpeg()` â€” `ffmpeg-static` first (dev node_modules; packaged via the
      `app.asar` â†’ `app.asar.unpacked` swap + `asarUnpack`), then `resources/ffmpeg/`, then
      `ffmpeg` on `PATH`. Guards the Electron-only `process.resourcesPath`.
- [x] `runFfmpeg(bin, argv, emit?)` â€” spawn, stderr tail on non-zero exit.
- [x] `probeMedia(bin, path)` â€” `ffmpeg -i` `Duration:` + audio-stream detection; null-safe.

## Render pipeline (3-pass, robust to mixed stills+clips)

- [x] Pass A â€” normalize each event to a uniform h264/yuv420p + aac segment of exactly
      `durationSec` at the target size (stills `-loop 1`; short clips `tpad`-cloned to their
      duration; muted/audio-less clips get an `anullsrc` silent track so every segment has
      video+audio and Pass B can `-c copy`).
- [x] Pass B â€” concat demuxer (`-safe 0` list file) with `-c copy` â†’ premix.
- [x] Pass C â€” `amix` VO + music (per-bed `volume=`) over the base track; no beds â†’ copy
      through; writes `out/assembly/render.mp4`.
- [x] `_render/` temp segments removed after C (also on failure).

## Wiring (`app/src/main/index.ts` + `shared/ipc.ts`)

- [x] `runProductionStep` widened to `step: 3 | 4 | 5`.
- [x] `production:assemblyBuild(id, cfg?)` â€” `runProductionStep(5, ...)`, no API key needed;
      marks `status[5]="done"`.
- [x] `production:assemblyRender(id)` â€” `runProductionJob`; hard error when no ffmpeg;
      `status[5]` running â†’ done / error; sets `renderPath`/`renderedAt`.
- [x] `production:assemblyOpenFolder(id)` â€” `shell.openPath` on the export folder.
- [x] CascadeApi + 3 `ipcContract` entries + 3 `handle()`s (drift guards enforce parity).

## Renderer â€” `app/src/renderer/src/components/production/assembly.tsx`

- [x] `AssemblyPanel({ prod, onApply, log })`: fps select (24/25/30) + resolution select
      (1080/1440/2160p, default 1080p) â†’ `cfg`; **Build package**; **Render MP4** (disabled
      until built); live log (`ProdLog`); `cascade-media://â€¦render.mp4` preview; **Open
      export folder**; runtime/skip/rendered readouts.
- [x] Replaced the Step 5 placeholder block in `ProductionWorkspace.tsx` with the panel
      (StepFooter already hides at step 5).

## Packaging

- [x] `ffmpeg-static` added to `app/package.json` deps (externalized by
      `externalizeDepsPlugin`); `electron-builder.json` gains `asarUnpack:
      node_modules/ffmpeg-static/**` so the binary lives outside the asar.

## Tests (`app/test/assembly.test.ts` + `assembly-ffmpeg.test.ts`)

- [x] `assemblyPlan` (ordering, full-res original resolution, clip precedence, still gathered
      alongside clips, default 3s, dedupe, skip+warn, audio config, clip-only shots).
- [x] `buildEdl` (header/FCM, reels, still src 00:00:00:00, cumulative record tc, probe-clamped
      clip srcOut, comment lines, VO/music A-track events).
- [x] `buildAeScript` (comp args, relative media base, in/out points, muted flag, dB levels,
      project save, path escaping).
- [x] `buildManifest` / `buildNormalizeArgs` / `buildConcat*` / `buildMixArgs` (stills `-loop 1`,
      mutedâ†’silence, `tpad`, `apad`, volumes, output path).
- [x] `assemble` e2e over a temp production folder: tree created, media copied, 4 artifacts
      written, config persisted, probe â†’ probed EDL.
- [x] `renderAnimatic` with a fake `runFfmpeg`: exact call sequence + argv, temp cleanup,
      "nothing to render" guard.
- [x] `assembly-ffmpeg.test.ts` â€” real-ffmpeg e2e smoke (skips unless `ASSEMBLY_E2E=1`):
      stills + clip + VO + music render a playable 3.5s mp4 with audio.

## Verify

- [x] `npm run typecheck` + `npm test` (118 tests) + `npm run build` pass.
- [x] Real-binary smoke: `ASSEMBLY_E2E=1 npx vitest run test/assembly-ffmpeg.test.ts` â†’
      playable `render.mp4` (3.5s, has audio).
- [ ] Manual: build package on a real production â†’ export folder with all media + 4 artifacts;
      open EDL in Resolve/Premiere; run JSX in After Effects â†’ comp rebuilds; Render MP4 â†’
      playable `render.mp4` with VO/music mixed and muted clips silent.

## Review

Implemented across `app/src/shared/ipc.ts`, `app/src/main/{productions,assembly,ffmpeg,index}.ts`,
`app/src/renderer/src/components/production/{assembly.tsx,ProductionWorkspace.tsx}`, `styles.css`,
`app/package.json`, `electron-builder.json`, `CONTEXT.md`. Typecheck + full test suite + build
pass clean; the real-ffmpeg e2e smoke test renders a playable mp4.

- **Deep module** â€” `assembly.ts` keeps every decision (plan mapping, EDL/AEScript/manifest
  text, ffmpeg argv) in pure builders behind a small surface; `assemble`/`renderAnimatic` take
  an injected `run`/`probe` seam, so the whole pipeline is unit-tested without ffmpeg and
  smoke-tested with it.
- **Robust render** â€” every segment is normalized to identical h264/aac streams (silence for
  muted/audio-less clips, `tpad` clone for short clips), so Pass B `-c copy` never hits a
  stream mismatch; clip audio is baked into the base track and VO/music `amix` on top.
- **Muted semantics** â€” honored in the AEScript (`audioEnabled = false`) and the render
  (silent segment); EDL clips also clamp source-out to probed length.
- **Editor handoff** â€” media paths in the `.jsx` are relative to the script, so the export
  folder is portable to another machine.
- **Note (not re-litigated)**: `renderAnimatic` re-probes clip lengths at render time rather
  than trusting the build-time probe, because `p` may change between build and render; the
  probe is cheap.
- **Restart required** â€” main process changed (new IPC channels + schema back-fill).

---

# Draggable reference-tag chips in the prompt text boxes

The `@[Name]` reference tags in the prompt content box are now little **purple chips**
(`#a78bfa`, matching the node graph's reference color) instead of plain text, and they can be
**dragged to anywhere in the paragraph**.

## What changed
- New `PromptContentEditor.tsx`: a contenteditable replacement for the content `<textarea>`.
  The plain text stays the single source of truth â€” chips are a live view, and every edit
  (typing, paste, chip drag) serializes back to text and fires the normal prompt-save flow.
  `@[Name]` chips render as non-editable `inline-block` spans; dragging one moves the tag to
  the drop caret (native drag events + `caretRangeFromPoint`).
- `TriplePrompt` uses it for the content box (Style/Brand boxes stay textareas â€” tags only
  live in content). Exposes a textarea-compatible handle (`selectionStart/End`,
  `setSelectionRange`, `caretRect`, `isActive`) so the existing `@` autocomplete, caret math,
  Enter handling, and blur cleanup keep working. `onContentKeyDown` is now `HTMLDivElement`.
- `ReferencePromptEditor`: `contentRef` typed to the new handle; the autocomplete menu is now
  anchored to the actual caret rect (accurate with variable-width chips) instead of the old
  `column * 8` heuristic; blur cleanup uses `isActive()`.
- CSS: `.prompt-tag-chip` (purple, `cursor: grab`, dragging state), `.prompt-content-editor`
  (`white-space: pre-wrap`, `overflow-y: auto`, `:empty::before` placeholder), and a
  min-height for the node graph composer's box (replaces the old `rows`-driven height).
- The `contentRows` prop was removed (textareas were the only consumers).

## Verify
- [x] npm run typecheck + build
- [ ] Manual: type a prompt with `@[Name]`, see purple chips; drag a chip to reorder; type `@`
      and confirm the autocomplete + blur cleanup still behave; composer box edits/saves.

## Notes
- Chips only appear in the Content box (Style/Brand never contain tags).
- Dragging a chip within the box moves it; dragging it out and dropping on the canvas is a
  no-op (the tag stays put).

---

# References on disk + organized boards + video refs viewable + no design folder

User requests (4 items):

## 1. Video references are actually viewable
- Video refs were copied to `references/` but only ever shown as a â–¶ glyph. The node
  graph's ref node now renders a playable `<video>` (hover to play) via a new `mediaUrl`
  (`cascade-media://`) on the ref node data; the Step 2 category cards do the same
  (`.prod-ref-video`, hover-to-play) for `media === "video"` refs.

## 2. Image references copied to the project folder (full path-only migration)
- Image refs were inline data URLs in the JSON. Now every reference image lives as a file in
  `references/`: new `CustomRef/CharacterSheet/ProductRef.imagePath`, a new
  `production:addReferenceImage` IPC (data URL â†’ file, MIME-derived extension, collision
  handled), and `production:removeReferenceFile` (unlink on reference/image removal).
- **Migration** (`migrateReferenceArtwork`, runs on load): legacy `artwork` data URLs on
  characters/products/references are written out to `references/` and cleared. Generation
  resolves artwork at call time via `refArtworkDataUrl` (reads `imagePath` from disk);
  the UI shows refs via `cascade-media://` URLs (`promptRefsForShot`, category cards).

## 3. boards/ organized per shot
- New layout: `boards/<shot>/shot-<shot>-<tag>.jpg` + `boards/<shot>/originals/â€¦` (was a
  flat pile + one `originals/`). `boardJpegRelPath`/`boardOriginalRelPath`/`writeBoardFrame`
  changed; `relocateBoardLayout` (runs on load) moves existing flat files (artwork, history,
  node-gen paths) and the archived originals into the per-shot folders, idempotently.

## 4. Don't create the unused design/ folder
- `assets.designDir` removed from the type, normalize defaults, and the scaffold loop.

## Verify
- [x] npm run typecheck + build
- [ ] Manual: dropping a video on the canvas shows a playable video in the node + Step 2 card
- [ ] Manual: image refs (picked/dropped/frame-drop) land in references/ as files, display correctly, generate fine
- [ ] Manual: existing flat boards/ files migrate into per-shot folders on load; frames still show
- [ ] Manual: new production has no design/ folder

## Review

- **Restart required** (main process changed: new IPCs, migrations).
- Typecheck + build clean.

---

# Node Graph: refâ†’output, multi-target image pipe, video-option cache, extra video refs

User requests (4 items) on the storyboard node graph (`NodeGraphModal.tsx`):

## 1. Reference nodes can feed the frame output node
- `graphOutputSource` union gains `"ref"` + new `graphOutputRefId?: string`.
- New IPC `production:applyGraphRefOutput(id, shotId, refId)`: image ref (artwork data URL)
  â†’ `writeBoardFrame` + `recordBoardArtwork` (JPEG to boardsDir); video ref (`mediaPath`)
  â†’ `shot.videoPath = mediaPath`. **Piping a ref into the output applies it to the shot**
  (user's call: "also apply to the shot").
- Output node preview: image ref â†’ data URL `<img>`; video ref â†’ `cascade-media://` `<video>`.
- Edge `e-ref-out` when `graphOutputSource === "ref"`; connect refâ†’output routes to the new
  `pipeRefToOutput`; disconnect via output's in-out drag-off (existing `unpipeOutput`, now
  also clears `graphOutputRefId`) or ref-node source drag-off.
- Audio refs are rejected as output sources (`isValidConnection`).

## 2. Image gen node pipes to video gen AND output simultaneously
- Replace `graphImageOutTarget` (`"videogen" | "output"`) with `graphImageToVideo?: boolean`.
  Migration in `migrateBoardArtwork` (productions.ts): `graphImageOutTarget === "videogen"`
  â†’ `graphImageToVideo = true`; always delete the old field.
- Output feed stays single-source (`graphOutputSource`); the image node can now ALSO feed the
  video node at the same time (`graphImageToVideo && graphOutputSource === "imagegen"`).
- `pipeImageToVideo` no longer clears `graphOutputSource`; new `unpipeImageToVideo` only
  clears `graphImageToVideo`; `unpipeImageGen` (source drag-off) disconnects BOTH pipes.

## 3. Cache video model resolution/length options at app open
- Main-process module cache `videoOptionsCache: Map<"model|withImage", VideoModelOptions|null>`
  in `index.ts`; `production:videoModelOptions` reads/writes it (extract `fetchVideoModelOptions`).
- Warm-up: `production:openArtModels` fires background prefetch for every video-capable model
  in both modes after listing. Renderer caches (NodeGraphModal) now hit the instant main cache.

## 4. Always-open additional reference sockets on the video gen node
- New `graphVideoRefIds?: string[]` (ref ids feeding the node's extra reference inputs, in order).
- Node renders per-connected-ref sockets (`in-vref-<i>`) + one always-open socket
  (`in-vref-open`), composer-style (labels + `useUpdateNodeInternals`), below the main
  `in-image` frame pipe. Connect via open socket appends; drag-off removes; select+Delete works.
- Only refs with `artwork` (image refs) connect; video/audio refs rejected.
- `generateVideoNode` opts gain `refIds?: string[]`; main resolves to `{name, dataUrl}` and
  passes them into `openArtVideoGen` as extra uploaded visual references (before prompt tags).
- `hasImageSource` for the video node's options fetch = image pipe OR any extra ref connected.

## Verify
- [x] npm run typecheck + build
- [ ] Manual: refâ†’output previews image/video AND updates storyboard/animatic; unpipe ref blanks output
- [ ] Manual: image node piped to both video node + output at once (both edges visible)
- [ ] Manual: opening a shot graph shows resolution/length instantly (warmed cache)
- [ ] Manual: connecting refs to video node's open socket grows the socket list; gen uploads them

## Review

Implemented across `app/src/shared/ipc.ts`, `app/src/main/{index,productions}.ts`,
`app/src/preload/index.ts`, `app/src/renderer/src/components/{NodeGraphModal,ProductionWorkspace}.tsx`,
and `styles.css`. Typecheck + build clean.

- **Ref â†’ output**: `graphOutputSource` gains `"ref"` + `graphOutputRefId`. New IPC
  `production:applyGraphRefOutput` applies the ref to the shot (image â†’ `writeBoardFrame` +
  `recordBoardArtwork`; video â†’ `videoPath`). Output node previews the ref (data-URL `<img>` for
  images, `cascade-media://` `<video>` for video refs via `GraphRef.mediaPath`). Audio refs are
  rejected at connect time. Unpipe via the output's in-out drag-off (existing `unpipeOutput`, now
  clears `graphOutputRefId`) or the ref node's source drag-off. Stale/deleted refs never dangle â€”
  the `e-ref-out`/`e-vref-` edges are guarded by a membership check.
- **Multi-target image pipe**: `graphImageOutTarget` replaced by `graphImageToVideo?: boolean`
  (migrated in `migrateBoardArtwork`; the old field is deleted). The image node feeds the video
  node and/or the output independently (`graphImageToVideo` + `graphOutputSource === "imagegen"`).
  `pipeImageToVideo` no longer clears the output feed; new `unpipeImageToVideo` unbinds only the
  video pipe; `unpipeImageGen` (source drag-off) disconnects both. `unpipeOutput` no longer touches
  the video pipe.
- **Video options cache**: main-process cache keyed `model|withImage` with a null-result TTL
  (2 min) so transient form failures self-heal while successful options stay instant for the
  session. `production:openArtModels` fires a background prewarm for every video model Ã— both modes
  after a successful model list (MCP is guaranteed connected at that point). Both the node graph
  and the classic video modal now populate instantly.
- **Extra reference sockets on the video node**: new `graphVideoRefIds?: string[]`. The node
  renders Prompt / Source (main image pipe) / one socket per connected ref / one always-open
  Reference socket (composer pattern: labels, `useUpdateNodeInternals`, `padding-left: 84px`
  gutter). Connecting through the open socket appends the ref id; drag-off or select+Delete
  removes it. Only refs with `artwork` (image refs) connect. `generateVideoNode` accepts
  `refIds`; main resolves them to `{name, dataUrl}` and `openArtVideoGen` uploads them as extra
  visual references (before prompt `@[name]` tags). The node's `hasImageSource` flag â€” which
  drives the mode-aware option fetch â€” is true when the image pipe OR any extra ref is wired.
- **Migration note**: `graphImageOutTarget` â†’ `graphImageToVideo` happens on `loadProduction`;
  requires an app restart (main process changed).

## Review (round 3: storyboard mirrors the output node)

- **Storyboard = output node.** The storyboard card is now a strict mirror of the graph's
  frame output node. Piping a gen node in with no generation yet clears `artwork`/`videoPath`
  so the frame goes blank ("no frame") instead of showing a stale frame â€” the reported bug
  (videogen piped but empty â†’ old frame lingered). Pipe transitions also clear the stale
  cross-kind field: imagegen takes over â†’ `videoPath` cleared; videogen takes over â†’ `artwork`
  cleared; a ref pipe clears whichever field the other media kind left behind.
- **Video-only shots render in the storyboard** â€” `BoardCard` dropped the `shownImg`
  gate on the `<video>` branch, so a shot whose output is a video clip shows the clip's
  first frame even with no `artwork` (previously "no frame"). `videoFailed` now resets when
  `shot.videoPath` changes, and the zoom button is enabled for video-only shots.
- Renderer-only change â€” no main-process restart needed for this round.
- Typecheck + build clean.

## Review (round 2: classic-flow auto-hook + node video options)

- **Classic flows auto-hook into the node view** â€” the round-21 strict model kept the
  storyboard frame owned by the output pipe, so classic regeneration on an unpiped shot
  landed in the node's history but never reached the storyboard/output (and `editBoard` /
  `importBoards` bypassed the model inconsistently by forcing `shot.artwork`). New shared
  helpers `hookImageGenToOutput` / `hookVideoGenToOutput` (pipeline.ts) run after every
  classic generation records into the node: when nothing is piped they bind the gen node as
  the output feed and apply the newest frame/clip; when that node is already the feed they
  still auto-apply the new generation; a deliberate `videogen`/`ref` pipe is never displaced.
  Wired into `generateBoards` (batch + regenerate + submit-frame), `importBoards`,
  `editBoard`, and the classic `generateVideo`. `editBoard`/`importBoards` dropped their
  unconditional `recordBoardArtwork` so every classic flow follows the same pipe rule.
- **Video node options corrected** â€” the node always animates a source frame (the piped
  frame or the shot's own), so it now always probes the **image-to-video** form
  (`onModelOptions(model, true)`) instead of gating on `hasImageSource` (which only tracked
  the image pipe and wrongly fell back to text-to-video options). The classic `VideoGenModal`
  does the same (`videoModelOptions(model, true)`) so both surfaces agree. The node also
  gained the modal's selection-validation effect (a new option set re-validates the current
  resolution/duration) and its richer fallback lists (`["480p","720p","1080p"]` / `[5,10,15,20]`)
  instead of the sparse `["1080p"]`/`[5]`.
- **Restart required** â€” main process changed (new pipeline helpers + hooks).
- Typecheck + build clean.

---

# Animatic Page Rework (Step 4)

Step 4 becomes two sections: **(1) generate VO per shot** using an audio model, **(2) drag-to-time timeline with realtime playback**. Stays a single step in nav; the existing per-shot grid table is replaced.

## Audio model plumbing
- [x] Add `AudioModelInfo` type (`id`, `displayName`, `voice?`) in `app/src/shared/ipc.ts`
- [x] Add `production:listAudioModels` IPC â€” re-queries `gab.ai/v1/models` with a `capabilities.audio && capabilities.text` filter (TTS candidates), modeled on the text filter at `app/src/main/index.ts:388-409`
- [x] Expose via preload (`window.cascade.listAudioModels()`)

## Data model
- [x] `Production.assets.voiceoverDir?` (default `"voiceover"`) â€” back-fill in `productions.ts` normalize + scaffold
- [x] `Production.voiceover?` = `{ model }` (mirrors `openArt` config)
- [x] `ProductionShot.voiceoverPath?` (workspace-relative; absence = no VO yet)

## Section 1 â€” VO generation
- [x] `production:generateVoiceover(prodId, shotId)` IPC: fetch TTS audio â†’ write to `voiceoverDir/vo-shot-NNNN-<tag>.mp3` via `assetPath`; new `voiceoverRelPath` helper alongside `boardRelPath` at `pipeline.ts:468`
- [x] VO model picker at top of Step 4 (copy storyboard model picker at `ProductionWorkspace.tsx:891-903`)
- [x] Per-shot "Generate VO" button: **disabled (grayed) when `shot.audio.trim() === ""`**; enabled otherwise
- [x] Inline `<audio controls>` + "Regenerate" when `shot.voiceoverPath` is set

## Section 2 â€” timeline + realtime playback
- [x] Replace grid table with horizontal strip: one block per shot, width âˆ `durationSec`
- [x] Each block shows shot number + `AnimaticThumb`; **"no frame" slate placeholder** when `!shot.artwork` (reuse `.prod-timeline-thumb.blank`)
- [x] Draggable right-edge handle per block â†’ sets `durationSec` (pointer events, `setPointerCapture`, pxâ†’sec from strip width / total runtime)
- [x] Realtime playback: `AudioContext` schedules per-shot decoded VO buffers sequentially; `requestAnimationFrame` advances a playhead and swaps a preview pane to the current shot's frame; shots without VO play silent
- [x] Play / Pause / Stop + scrubber + mm:ss readout
- [x] Per-shot transition (`cut`/`dissolve`/`fade`/`wipe`) shown as a badge on the block; crossfade between thumbs for non-cut

## Polish
- [x] Total runtime readout keeps using `formatRuntime`
- [x] All new fields ride the existing `saveField` round-trip; production JSON back-fills cleanly on old files

## Open questions (need your call before I implement)
1. **TTS endpoint** â€” gab.ai audio endpoint shape is unconfirmed; most likely `POST /v1/audio/speech` (OpenAI-compatible). I'll probe first; fall back to MCP-server pattern if it doesn't exist.
2. **Cut-drag model** â€” each block's right edge independent (simpler, total runtime changes) **vs.** shared cut-point between two blocks (Premiere-style, redistributes). **Recommend independent for V1.**
3. **Shots with no VO on the timeline** â€” play their slice silent (visual only) **vs.** require a default beat. **Recommend silent for V1.**

## Verify
- [x] `npm run typecheck`
- [x] `npm run build`
- [x] Manual: no-audio shot shows disabled button; with-VO shot plays in its slice; drag updates `durationSec` and persists across reload

## Review

Implemented across `app/src/shared/ipc.ts`, `app/src/main/{productions,pipeline,index}.ts`, `app/src/preload/index.ts`, `app/src/renderer/src/components/ProductionWorkspace.tsx`, and `app/src/renderer/src/styles.css`. Typecheck and build both pass clean.

- `AudioModelInfo` filter uses `capabilities.audio === true` (matches `gpt-4o-mini-tts`, `qwen-audio-3-0-tts-flash`; correctly skips `multitalk-avatar-tts` which is video-only despite the name).
- TTS endpoint is the single `VOICEOVER_ENDPOINT` constant in `pipeline.ts` â€” assumed `https://gab.ai/v1/audio/speech` with an OpenAI-style `{model, input, voice}` body. One-line change if the real shape differs.
- Cut-drag model: independent per-block right edges (V1 recommendation). Total runtime changes as you drag; the auto-time button still works to re-plan everything.
- No-VO shots: play silent (V1 recommendation); the preview pane still shows their frame/slate on its slice.
- Step 4 panel uses `prod-storyboard-panel` (max-width: none) so the strip has room to breathe.

## Review (v2: batch VO, per-model voices, compact preview, music import)

- **Batch VO** â€” replaced the per-shot list with a single "Generate all voiceovers" button. `production:generateAllVoiceovers` walks every shot with a non-empty `audio` line, calls `generateVoiceover` per shot, and surfaces per-shot results in the existing production log. Shots with no dialogue are skipped silently; a "X of Y lines voiced (N silent)" hint next to the button reflects progress without graying anything.
- **Per-model voices** â€” `AudioModelInfo.voices` is now populated per-model via `voicesForModel(modelId)` in `pipeline.ts`. Heuristic matchers: `elevenlabs` â†’ their stock voice library, `qwen`/`multitalk` â†’ `default/male/female`, everything else â†’ the OpenAI set. When the model changes, `setVoiceoverModel` falls back to the first available voice if the current one isn't in the new set, so the picker is always in a valid state. The voice `<select>` re-renders against the new list on every model change.
- **Compact preview** â€” `.prod-animatic-preview` now has `max-height: 220px` plus `align-self: center` so it sits in the middle of the available width. The image still uses `object-fit: contain` so frames letterbox instead of cropping. Transport sits directly below.
- **Music** â€” new `assets.musicDir` (default `"music"`, scaffolded), new `Production.musicPath` + `Production.musicVolume` (default 0.5 on first import). New IPCs: `production:importMusic` (native picker, copies to `musicDir/music.<ext>`, supported: mp3/wav/m4a/aac/ogg/flac), `production:musicFile` (data URL), `production:removeMusic` (unlink + clear). UI: a "Music" section above the timeline with the file name, an inline `<audio controls>`, a volume slider, Replace and Ã— buttons. During playback the music is decoded once into an `AudioBuffer`, looped via `BufferSource.loop = true`, and routed through a `GainNode` so the slider takes effect live. Silent (no-music) playback is unchanged.
- All four issues addressed; typecheck and build clean.

## Review (v3: single VO, side-by-side, resizable preview, draggable playhead, waveform, cuts-only)

- **Single-VO model** â€” `voiceoverPath` moved from `ProductionShot` to `Production`. `generateVoiceover` now sends every non-empty shot dialogue joined with `\n` in one TTS call and writes one file (`voiceoverDir/voiceover-<tag>.mp3`). Per-shot `transition` field and its `<select>` are gone â€” all cuts are hard cuts. `animaticPrompt` + `animaticMarkdown` updated; `planAnimatic` no longer touches transition. The save handler strips the legacy fields on the way in, so any old data on disk cleans up on the next save.
- **Side-by-side panels** â€” `prod-animatic-panels` is a 2-column grid (collapses to 1 column under 900px) that holds the Voiceover and Music sections. Both have the same chrome: header label, controls row, optional inline player + remove button, and a path hint.
- **Generate / Import / Fit to VO** â€” the Voiceover section has a primary "Generate" button, a secondary "Importâ€¦" / "Replaceâ€¦" button, and a "Fit to VO" button that appears once a VO exists. `fitShotsToTotal(sec)` rescales every shot's `durationSec` proportionally so the total equals the VO length, in a single `saveField` call.
- **Primary button design system** â€” a global `button.primary` rule was added at the top of the Step 4 CSS block so the Generate / Play buttons follow the rest of the app's accent styling regardless of their container. The old scoped rules (`.prod-create .primary`, `.prod-boards-controls .primary`, `.modal-actions .primary`) remain for the call sites that were using them.
- **Resizable preview** â€” the preview pane is no longer `aspect-ratio`-locked. Its height is driven by a `useState` (default 220px) and a `.prod-animatic-preview-resize` handle at the bottom edge that captures pointer drag and clamps to 80â€“640px. The handle shows a thin grab bar on hover.
- **Draggable playhead** â€” the scrubber bar (and its head) now use `pointerdown` / `pointermove` / `pointerup` with `setPointerCapture`. The cursor is `grab` â†’ `grabbing`. A vertical `.prod-animatic-playhead` line is overlaid on the timeline strip itself, independent of the scrubber, so the playhead position is visible directly on the block row.
- **Waveform** â€” the VO's `AudioBuffer` is decoded once and downsampled to ~2px columns; a `<canvas>` inside the strip draws a centered vertical bar per column in the accent color, behind the shot blocks. The canvas redraws on VO change, on strip resize, and on duration change. `min/max` peaks per chunk give it real visual punch.
- **Playback** â€” the whole animatic now plays off a single decoded VO buffer; music is decoded and looped underneath as before (with a live gain ref). The playhead is driven by `audioContext.currentTime` so visuals stay in lockstep with audio.
- **Timeline total anchoring** â€” when a VO exists, `total = voDuration`; the timeline respects the VO length. When the user drags a shot's right edge, that shot's duration changes freely and the total updates. "Fit to VO" re-anchors everything to the VO length in one click (and the transport row also surfaces a Fit to VO button when `|voDuration - sumDur| > 0.1s`).
- Typecheck and build both pass clean.

## Review (v4: strip seekable, editable total, JPEG storyboards)

- **Strip + scrubber each seek using their own rect** â€” the previous bug was that the scrubber's seek math used the strip's `getBoundingClientRect()`, so the cursor's percentage on the narrower scrubber mapped to a different percentage on the wider strip and the playhead lagged the cursor. The seek helpers now take the ref whose rect defines the coordinate system, and the strip itself is also seekable (click or drag anywhere on the strip moves the playhead). The shot handle calls `e.stopPropagation()` so dragging a handle doesn't bubble to the strip's seek.
- **Editable total** â€” the "playhead / total" label in the transport row exposes the total as a clickable button. Click â†’ inline `<input>` â†’ type `mm:ss`, `hh:mm:ss`, `1m30s`, `45s`, or a plain number of seconds â†’ Enter commits â†’ `fitShotsToTotal(sec)` rescales every shot. Escape cancels. The total is now always `sum(shot.durationSec)`; the VO and the strip are decoupled, with the waveform drawn at the VO's true scale over the first `voBuffer.duration` seconds of the strip (post-VO tail has no waveform).
- **JPEG storyboards** â€” every generated/imported/edited frame is now written twice: the original (PNG for model output, original ext for imports) goes to `boardsDir/originals/`, and a 90-quality JPEG goes to `boardsDir/`. `shot.artwork` points at the JPEG. `writeBoardFrame(p, shot, bytes, ext)` in `pipeline.ts:498` is the single entry point used by `generateBoards`, `importBoards`, and `editBoard` in `main/index.ts`. The `boardImage` and `boardThumbnail` IPCs were already re-encoding to JPEG on read, so no changes were needed there â€” they just read the now-JPEG file at `shot.artwork` and serve it back. `editBoard` now picks the right input MIME from the file extension instead of hardcoding `image/png`.
- **One-time PNG â†’ JPEG migration** â€” `loadProduction` runs `migrateBoardArtwork` on every load, which calls `migrateBoardArtworkToJpeg` per shot + per history entry. It only acts when `shot.artwork` ends in `.png`; otherwise it's a no-op. The legacy PNG is renamed into `boardsDir/originals/`, the JPEG is written to `boardsDir/`, and the shot's path is updated. The migrated JSON is persisted in place so the very next read sees the new layout.
- **Playhead clamp** â€” when seeking past the end of the VO buffer (e.g. total > voDuration) and pressing play, `BufferSource.start(t0, playhead)` would throw. The play() helper now clamps `playhead` to `[0, voBuffer.duration]` before the call.
- Typecheck and build both pass clean.

## Review (v5: bigger preview, working inline audio)

- **Preview default doubled** â€” `useState(220)` â†’ `useState(440)`. The drag-to-resize handle still clamps 80â€“640px.
- **Working inline audio** â€” the previous `<audio controls>` elements next to the VO and Music imports weren't actually playable. The IPCs return multi-MB base64 data URLs (`data:audio/mpeg;base64,â€¦`); some Chromium versions reject these for `<audio>` past a few hundred KB, leaving the transport looking like a static bar. Added a small `useObjectUrl(dataUrl)` hook in `ProductionWorkspace.tsx:1338` that fetches the data URL, wraps it in a `Blob`, and returns a streamable `blob:` object URL; the previous object URL is revoked on cleanup or when the data URL changes. The AnimaticTimeline receives the same blob URL (its `fetch(voUrl)` / `fetch(musicUrl)` work identically with blob URLs and are much faster to decode). CSS: `.prod-music-player` now sizes naturally (`height: 32px; min-width: 280px; max-width: 360px; flex: 0 1 auto`) so the native controls aren't clipped.
- **Auto-included in the animatic** â€” pressing the big Play in the transport row already schedules the VO buffer (decoded once into an `AudioBuffer`) and the music buffer (decoded + looped under a `GainNode`) into the same `AudioContext`. With the inline `<audio controls>` now working too, users can preview the VO and music independently OR hear them together in the animatic.
- Typecheck and build both pass clean.

---

# Reference Simplification

---

# Reference Simplification

- [x] Inspect reference ingestion, custom reference, and storyboard prompt flows
- [x] Replace automatic ingest references with a script suggestions panel
- [x] Simplify custom references to image and name
- [x] Add storyboard prompt reference tags and autocomplete
- [x] Run typecheck/build and review the diff

## Review

Implemented and verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Follow-up Review

- Removed legacy custom descriptions from prompt generation and persistence normalization.
- Removed the storyboard refs menu and reference thumbnail strip.
- Frame drops now target the storyboard frame; tagged references provide assignment.
- Autocomplete is positioned near the caret and constrained to the viewport.
- The full-prompt button stays at the lower edge of the prompt field.

## Alias Removal Review

- Removed generated `Reference images by id` text from displayed and submitted prompts.
- Kept legacy-clause stripping so previously saved prompts are cleaned when read.
- Confirmed submission order: `shotReferences` orders artwork, each upload returns `visualReference`, its `id` (or fallback URL) is mapped from `@imageN`, and the mapped value is passed in `visualReferences` to MCP.
- Moved the expand control into the prompt header, opposite the shot number.

## Persistent Prompt And Categories

- Replaced the modal expand prompt with a permanently visible storyboard side panel.
- Kept storyboard content undimmed; clicking any prompt focuses that shot in the side panel.
- Kept ingest discoveries as unassigned suggestions and moved them above manual references in Design.
- Added user-created reference categories with drag-and-drop between category groups.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Layout And Prompt Review

- Expanded storyboard panel width to use the full workspace, keeping the editor on the right.
- Restored script visual/audio direction below the side-panel prompt.
- Removed the redundant prompt field below each frame.
- Replaced copy with a hover magnify control.
- Added persisted Include Brand Identity behavior for each shot.
- Removed duplicate custom-reference rendering and styled category panels with hover-only upper-right deletion.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Frame Controls And Drop Review

- Removed the over-frame magnify control; clicking a frame selects its prompt and clicking the image enlarges it.
- Added a frame-size slider below the storyboard grid.
- Tightened the side panel height and restyled the brand toggle as a switch.
- Added desktop image-file drops to category panels.
- Added spacing below the visual-style list.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Final Frame Interaction Review

- Fixed the frame-size slider to the bottom of the window.
- Removed magnify cursor and image enlargement from frame clicks; frame clicks now only select the prompt.
- Restored hover visibility for edit, regenerate, and import controls.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Prompt And Selection Review

- Removed the eight-reference autocomplete cap.
- Made the prompt textarea fill the flexible portion of the side panel while script direction fits below it.
- Added an accent outline to the selected storyboard frame.
- Restricted category-card dragging to the image itself and reduced reference-name text size.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Interaction Follow-up

- Restored a dedicated hover-only magnify button for frame enlargement.
- Added selected-prompt refresh after storyboard generation/regeneration.
- Incomplete `@` mentions are removed when the editor loses focus.
- Moved MCP logs below storyboard frames and the zoom control.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Style And Categories Review

- Style selection now refreshes the active prompt while preserving non-style text.
- Reference popup now includes all available artwork references.
- Added category renaming through the category header field.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Thumbnail And Category Review

- Style dropdown now updates the selected shot's Style section and refreshes the side panel.
- Added JPEG thumbnail IPC conversion at 480px/quality 72; original project files remain unchanged and full-resolution loading remains available for enlargement.
- Added category renaming in the category header.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Dropped Frame Tag Review

- Dropped storyboard frames now append their generated `@[Frame N]` tag to the destination prompt.
- Existing generated prompt content is preserved when adding the tag.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Duplicate And Model Review

- Dropped frames now reuse an existing matching `Frame N` reference and avoid duplicate tags.
- Storyboard model selection now exposes Auto and image-capable models only.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Storyboard Controls Review

- Removed Import Frames and Scan Import Folder controls from the storyboard page.
- Added hover-only lower-right deletion for the selected shot frame, deleting its current asset while retaining prompt/reference state.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Frame Action Review

- Restored per-frame import and magnify controls with fixed positions.
- Kept frame deletion lower-right and hover-only; empty frames keep the delete control hidden.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Explicit Reference Submission Review

- Kept human `@[name]` tags in the prompt display; transport-only conversion now occurs in the MCP generator.
- Added hover thumbnails for tagged-reference chips.
- Added a Submit frame button to the side panel.
- Restricted generation references to names explicitly tagged in the shot prompt, excluding legacy text matches and shot associations.
- Stabilized prompt refresh by returning the human prompt form from the display IPC path.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Brand Toggle Review

- Manual prompts now add/remove a generated `Brand identity:` section when toggled.
- The toggle is positioned in the prompt-panel header to the right of the shot name.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Manual Prompt Regression Review

- Style changes now replace only a `Style:` paragraph anywhere in a manually edited prompt.
- Turning brand identity off removes only the generated brand paragraph, preserving custom text and tags.
- Submit frame uses the standard reference-panel button styling.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Global Model And Prompt Stability Review

- Serialized prompt saves and made generation wait for the latest queued prompt.
- Prompt selection now reloads from the saved source instead of trusting a card's stale local copy.
- Added the existing model picker to the top navigation so it is available in Chat and Production Assistant.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Prompt Blank-State Review

- Added per-shot prompt caching so switching frames does not briefly show another shot's prompt.
- Added serialized-refresh retries after generation so transient null reads do not blank the side panel.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Model Menu Review

- Top-navigation model menu now opens downward instead of using the chat-footer direction.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Timeline Improvements Round 2 (mute buttons, cut perf, wheel zoom)

### 1. Per-clip mute (speaker button on each block)
- [x] Add `muted?: boolean` to `ProductionShot` (`app/src/shared/ipc.ts`) â€” persists automatically since `production:save` spreads shots (`main/index.ts:704`)
- [x] Parent helper `toggleShotMuted(shotId)` beside `updateDurations` (saveField scenes patch)
- [x] New `AnimaticTimeline` prop `onToggleMute`; inline-SVG speaker/mute button top-right of each `.prod-animatic-block`; `e.stopPropagation()` on pointerdown (lesson 17)
- [x] Applied to pooled `<video>` elements declaratively so playback honors it immediately

### 2. Black flash between clips â†’ per-shot video pool
Root cause: ONE shared `<video>` gets its `src` swapped per shot so Chromium reopens/demuxes/decodes while `.prod-animatic-video{background:#000}` paints black.
- [x] Pool: one `<video>` per shot-with-video, absolutely stacked in preview, visibility toggled by `activeIdx` (no reload on cuts)
- [x] Refactored single `shotVideoRef` sync effects to a `Map<shotId, video>` of refs
- [x] Memoized `boardThumbnail` data URLs (module-level key cache) â€” used by strip + preview layers
- [x] LRU cap 12 mounted videos (Â±2 window around active); evict least-recently-active beyond that
- Answer: NO timeline rewrite needed.

### 3. Mouse-wheel zoom anchored at playhead
- [x] `zoom` state 1..24, pps = (viewportW/total)*zoom via ResizeObserver width capture
- [x] Strip switched flex-% layout â†’ absolute-positioned content sized `total*pps` px inside an `overflow-x:auto` scroll frame
- [x] NATIVE non-passive wheel listener on strip-wrap (React root wheel is passive; preventDefault won't work otherwise); preserve playhead's screen X across zoom steps, clamp scrollLeft
- [x] Waveform canvas maps timeâ†’(t*pps âˆ’ scrollLeft), rAF-throttled redraw on scroll, plus one-time PCMâ†’peak-bucket downsample so follow-playback redraws stay cheap
- [x] Strip seek math gains scrollLeft branch (transport scrubber stays full-range overview)
- [x] Auto-follow playhead while playing when zoomed (suppressed during drag-scrub); manual seek snaps into view
- [x] Reset zoom to fit when prodId changes

### Verify
- [x] npm run typecheck + build pass
- [ ] Manual dev-run walkthrough pending user test: play across cut boundaries, mute toggle persists after reload, wheel zoom near t=0/end, drag handles at high zoom

Review:
- Note: the "â–¶ video" badge on blocks was replaced by the speaker button itself (it only renders on clips that have a video, so it doubles as the indicator).
- Note: preview cold-load of a never-opened clip can still flash briefly once (first approach / after LRU eviction); neighbours are proactively mounted Â±2 to mask this during normal linear playback.

## Storyboard modal + naming (review)
- [x] Video-gen dialog: removed "OpenArt didn't report a cost for this model." note
- [x] Credits line now shows the OpenArt account balance (via new openart_account_get MCP call) instead of Gab.ai credits; hidden when OpenArt isn't connected
- [x] Renamed "Storyboards" -> "Storyboard" everywhere (ProductionWorkspace.tsx x6, ipc.ts comment)
- [x] Verified: npm run typecheck + npm run build pass

### Fix round 2 (user report: credits not showing)
- Root cause: shared parseJsonObject cut replies at the FIRST }, so any reply with a
  nested object ({"user":{...},"credits":N}) parsed to null and the IPC silently
  returned null -> renderer hid the credits line.
- Fix: parse first { .. last } with full-JSON-first strategy; verified all
  existing callers (openArtHistoryId PENDING replies, creation polling) still work.
- Verified live: SDK client + stored tokens -> account_get returns credits 99849.
- App needs a dev restart to pick up the main-process change.

---

# Storyboard Node Graph (visual prompt construction)

A button in the prompt side panel opens a node graph for the focused shot. The graph is a
**projection + editor over `shot.prompt`** (source of truth stays the prompt text with
`@[Name]` tags + `promptManual`), so `pipeline.ts` boardPrompt/openArtPrompt, history,
and the export fallback all keep working untouched. OpenArt MCP stays host-side; the graph
just composes prompt + refs and triggers the existing IPCs.

## Layout model (constrained, prompt-centric)

```
[Ref: Character X]â”€â”€â”
[Ref: Product Y] â”€â”€â”€â”¼â”€â”€â–¶ [Prompt composer] â”€â”€â–¶ [Output: frame | generate image | generate video]
[Style node]     â”€â”€â”€â”¤
[Brand node]     â”€â”€â”€â”˜
```

- Ref nodes = `@[Name]` tags found in `shot.prompt` (plus an "available" tray of untagged refs)
- Style node shows the resolved style (read-only display + per-shot style select)
- Brand node mirrors `includeBrandIdentity` (edit â†’ existing toggle IPC)
- Composer node = prompt body text (edit â†’ `saveShotPrompt` flow, serialized queue)
- Output node = current artwork thumbnail + history count + generate/regen buttons
- OpenArt MCP: output node's generate actions call existing `regenBoard` / video-gen paths;
  no direct rendererâ†’MCP calls (approval gating + token mapping stay in main)

## Phase 1 â€” Read-only graph
- [x] Add `@xyflow/react` dep to `app/package.json`
- [x] `NodeGraphModal.tsx` renderer component: React Flow canvas, modal overlay chrome
- [x] Build nodes/edges from `shot.prompt` tags + `promptRefsForShot` + styles + brand
- [x] Ref thumbnails via existing `boardThumbnail`/ref artwork data URLs (lazy, cached)
- [x] Sidepanel button opens graph for `promptShotId`

## Phase 2 â€” Editing (two-way sync with prompt text)
- [x] Connect refâ†’composer = insert `@[Name]` tag; disconnect = remove tag (paragraph-safe)
- [x] Composer node textarea edits prompt through the same serialized save queue as the sidepanel
- [x] Brand node toggle reuses existing brand toggle handler
- [x] Graph and sidepanel textarea stay in sync when modal open

## Phase 3 â€” Drag-drop files + generate
- [x] Drop image/video/audio onto canvas â†’ create `CustomRef` (image: data URL, â‰¤15MB, reuse
      existing pattern; video/audio: flag for on-disk storage follow-up) + connect + insert tag
      *(implemented for images; video/audio drops surface a hint â€” see review)*
- [x] Output node: "Generate frame" (regenBoard) + "Video" (VideoGenModal path)
- [x] Artwork/history refresh while modal open (bust-aware thumbnail refetch)

## Phase 4 â€” Optional polish (defer unless trivial)
- [ ] Per-node prompt overrides, style-override node, audio refs feeding video-gen
- [ ] On-disk storage for large video/audio refs (CustomRef schema addition + cascade-media://)

## Verify
- [x] `npm run typecheck` + `npm run build`
- [ ] Manual: graph matches sidepanel tags 1:1; connect/disconnect updates prompt text;
      edit in composer updates sidepanel; drop file creates ref + tag; generate works

## Review

Implemented in `app/src/renderer/src/components/NodeGraphModal.tsx` (new), wired through
`app/src/renderer/src/components/ProductionWorkspace.tsx` + `styles.css`. Typecheck and
build pass clean.

- **Graph = prompt projection.** Nodes derive from `shot.prompt` each render: tagged refs
  (in tag order, incl. dangling "missing" tags shown dashed so they can be cleaned up),
  untagged refs (dimmed, connectable), style, brand, composer, output. The prompt text
  stays the source of truth; no pipeline changes.
- **Connect/disconnect three ways:** drag an edge from a ref to the composer, use the ï¼‹/Ã—
  buttons on ref nodes, or select a ref edge + Backspace (nodes are `deletable: false`;
  structural style/brand/output edges are not deletable). `addRefTag` appends
  `\n\n@[Name]` (idempotent, case-insensitive); `removeRefTag` strips all occurrences and
  collapses blank lines â€” token-scoped, no end-of-string wildcards (lesson).
- **Composer edits** flow through the same wiring as the sidepanel textarea:
  `setFocusedPrompt` + `promptCacheRef` + serialized `saveShotPrompt`; `regenBoard`
  already flushes the save queue before generating. Textarea uses React Flow's
  `nodrag`/`nowheel` so typing/dragging don't fight.
- **File drops** create a `CustomRef` via a new shared `attachReferenceToPrompt` helper
  (extracted from `dropFrameAsReference`, which now delegates to it) and tag the prompt.
  Dropped files keep their filename (minus extension, â‰¤60 chars) as the ref name and reuse
  an existing same-named ref â€” same semantics as frame drops.
- **Scope note:** only image drops are accepted for now; audio/video drops show a hint
  ("later pass") because `CustomRef.artwork` is an inline data-URL image â€” video/audio
  needs the Phase 4 on-disk storage + `cascade-media://` work to avoid multi-MB JSON.
- **OpenArt MCP** is reached through the existing host-side paths only (regenBoard â†’
  `openArtImageGen`; Videoâ€¦ opens the existing modal â†’ `runVideoGen`). No rendererâ†’MCP
  calls; approval gating and `@imageN` token mapping stay in main.
- User node positions persist per modal session (positions map overrides the default
  column layout); `fitView` on open. React Flow attribution kept visible (MIT license).

## Graph layout persistence (round 2)

- Node graph canvas state now saves **per shot** in the production JSON:
  `ProductionShot.graphLayout?: GraphLayout` (`app/src/shared/ipc.ts`) =
  `{ positions?: Record<nodeId, {x,y}>, viewport?: {x,y,zoom} }`. New shot fields ride the
  existing `production:save` shot-spread (main/index.ts:706) â€” no main-process change.
- Restore: positions initialize from the saved map (default column layout fills the rest);
  `defaultViewport` restores pan/zoom and `fitView` is skipped when a saved viewport exists.
- Save points: one write per **drag gesture** (final position change with `dragging !== true`,
  via `saveLayoutRef` so the handler stays stable), and on **pan/zoom end** (`onMoveEnd`).
  Parent `saveGraphLayout(shotId, layout)` merges into `shot.graphLayout` via `saveField`.
- Saved positions are pruned to currently-live node ids so deleted references don't leave
  stale entries in the JSON. Typecheck + build pass clean.
- Interaction round: left-drag moves nodes, right-drag pans (`panOnDrag={[2]}`), Controls
  cluster and React Flow attribution removed (`proOptions`).

## Interaction round 3 (selection, layout, dedicated sockets)

- **Box select** â€” `selectionOnDrag` (left-drag on empty canvas draws the selection rect,
  right-drag still pans); node `select` changes now applied via a `selectedNodes` set so
  box-selected groups drag together; selected nodes get an accent outline (CSS).
- **Default layout split** â€” unused refs keep the x=0 column; tagged refs get their own
  column one step right (`TAGGED_X = REF_W + 56`), closer to the prompt node; composer
  moved to x=620, output x=1040 to clear the new column. Saved user positions still win.
- **Dedicated composer inputs** â€” composer renders one `Position.Left` target handle per
  connected reference (`in-ref-<i>`, evenly spread vertically), plus dedicated style
  (`in-style`, top edge) and brand (`in-brand`, bottom edge) sockets. Ref edges bind
  `targetHandle: in-ref-<i>`; style/brand edges bind their sockets and are
  `reconnectable: false`.
- **Drag-away disconnect** â€” ref edges are reconnectable (`onReconnect` no-op â€” edges are
  prompt-derived so any reconnect snaps back); `onReconnectEnd` removes the tag when the
  edge end is dropped away from any handle (`!connectionState.isValid`). Note:
  `OnReconnectEnd` type isn't exported by @xyflow/react â€” callback typed inline with
  exported `HandleType`/`FinalConnectionState`.
- Typecheck + build pass clean.

## Socket naming/color round (round 4)

- All composer input sockets now sit on the **left edge** (style/brand moved off the
  top/bottom edges), spread evenly: Style top, one socket per Reference in prompt order,
  Brand bottom.
- Sockets are **named + color-coded** by input type: Reference = accent, Style = violet
  `#a78bfa`, Brand = amber `#f59e0b` (CSS vars `--graph-socket-*` on `.prod-graph-canvas`,
  shared by handles, labels, and edge strokes). Labels render in a reserved gutter
  (`.prod-graph-composer { padding-left: 84px }`) so they never cover prompt text.
- Edges stroke-match their socket color; output edge keeps the default.
- Typecheck + build pass clean.

## Always-open reference drop node (round 5)

- New `dropzone` node type (`NodeGraphModal.tsx`): a dashed, always-present "Drop an image
  here to add a reference" node in the left column (below brand; `STRUCTURAL_IDS` includes
  it so its position persists + is pruned correctly).
- Dropping an image onto it creates the reference, tags it into the prompt, **and seeds the
  new ref node at the drop position** (dropzone's live `positionAbsoluteX/Y`) in the same
  production save â€” `attachReferenceToPrompt` gained `opts {refId, position}` and
  `addFileReference` a `position` param; refId is generated in the caller so the seed and
  the new `CustomRef.id` match.
- Drop onto bare canvas still works (previous behavior, no position seed); non-image drops
  on the node surface the same "images only" hint. Highlights on dragover. Non-image drop
  hint uses `showHint` (moved above the nodes memo â€” it was used before declaration).
- Typecheck + build pass clean.

## Drop node removed; media refs + open input (round 6 â€” supersedes round 5)

User clarification: no drop node; any image/video/audio dropped on the canvas auto-becomes
a reference; the prompt node needs an always-open Reference input; left column ordered
style-top â†’ refs-middle â†’ brand-bottom to mirror the prompt's sockets; style = green;
node output handles/edges colored to match their input sockets.

- **Dropzone node removed** (component, types, nodeTypes, CSS). `onDropFile` now passes the
  raw `File` to the parent; the canvas routes by MIME â€” image â†’ data URL ref, video/audio â†’
  new `production:addReferenceMedia` IPC.
- **Video/audio refs on disk** (lesson 23 â€” no media base64 in JSON): `CustomRef.media`
  ("video" | "audio") + `CustomRef.mediaPath` (workspace-relative); new
  `assets.referencesDir` (default "references", normalize/scaffold backfill); handler
  preserves the original filename with music-import-style collision handling. Nodes render
  a â™ª/â–¶ glyph instead of a thumbnail; sidepanel chips + autocomplete get the same glyph
  (`RefMediaGlyph`). Generation paths filter refs to those with `artwork`
  (pipeline.ts:397,687; index.ts:1396), so media refs are safely skipped until
  video-gen upload wiring lands (follow-up).
- **Always-open Reference input** on the prompt node: composer renders tagged sockets +
  one extra hollow socket (`in-ref-open`, class `socket-ref open`); connecting through it
  adds the tag like any other â€” the edge snaps to its own socket and the open one remains.
- **Left column order** matches the prompt's input order: Style at top (y=20), reference
  band in the middle (`REF_COL_TOP` = 116; unused refs left column, tagged refs at
  TAGGED_X), Brand at the bottom of the column.
- **Output matches input**: source handles on ref/style/brand nodes now carry the socket
  classes (`socket-ref/style/brand`); edge strokes already matched. Style color changed to
  green `#34d399` (`--graph-socket-style`).
- **Requires a dev restart** â€” main process changed (new IPC + assets backfill).
- Typecheck + build pass clean.

## Selection fix, bezier edges, zoom lightbox, drag-off polish (round 7)

- **Box-select bug** (`autoPanOnSelection={false}`): with selection auto-pan on (RF
  default), dragging the rect near the canvas edge auto-scrolls the viewport under the
  fixed rect â€” nodes flicker in/out of selection ("flashes") and a runaway pan sweeps the
  rect across the whole graph ("selects the whole graph"). Disabling it fixes both.
- **Curved edges**: dropped `type: "smoothstep"` (RF default = bezier curves) and set
  `connectionLineType={ConnectionLineType.Bezier}` so the drag-preview line curves too.
- **Magnifier on ref nodes**: hover ðŸ” button (inline SVG, `nodrag`) on image refs opens
  the existing `prod-ref-lightbox` (reused styles; `prod-graph-lightbox` z-index 120 so it
  stacks over the graph overlay). Escape closes the lightbox first, then the graph.
  Buttons live in a `prod-graph-ref-actions` row next to the Ã—/ï¼‹ toggle.
- **Drag-off disconnect reliability**: added explicit `edgesReconnectable` and
  `reconnectRadius={20}` (was default 10 â€” the end anchors were easy to miss, which read
  as "can't drag off"). The round-3 `onReconnectEnd` removal logic is unchanged; hint text
  now teaches "drag an edge end away from its socket to disconnect".
- Typecheck + build pass clean.

## Selection flash root-caused; drag-from-socket disconnect (round 8)

**Box-select flash â€” root cause found in RF source** (`react/dist/esm/index.js`):
`commitUserSelectionRect` calls `getSelectionChanges(nodeLookup, ids, /* mutateItem */ true)`
â€” React Flow **mutates `node.selected` directly on our node objects** ("the onNodesChange
callback comes too late here" â€” their comment) and the store notification renders those
flags immediately. Our previous design re-derived every node object each render with
`selected` from a separate `selectedNodes` set + recreated objects on identity-churning
deps, so RF's in-place flags and our derived flags raced â†’ whole-graph flash as the rect
touched a new node.

- **Fix â€” canonical controlled pattern**: persistent `nodes` state; `onNodesChange` =
  `applyNodeChanges(changes, nodesRef.current)` in one pass (position/select/dimension all
  applied the same way RF expects); derived definitions (prompt tags, refs, styles,
  thumbnail) reconciled in via effect that **preserves `position`, `selected`, `measured`**
  for surviving ids. Deleted: `positions`/`positionsRef`/`selectedNodes` bespoke tracking.
- **Node identity stabilization**: parent callbacks (new identity every render) now route
  through a `stable` ref-wrapper object, so node data objects only change when real inputs
  change (prompt, refs, styles, thumbnail) â€” no more `replace` churn per render.
- Layout saves unchanged (drag-stop â†’ `onSaveLayout({ positions })`, now read straight off
  the applied node state; no pruning needed since state only holds live nodes).
- **Drag-from-socket disconnect** (`onConnectEnd`): dragging FROM a composer reference
  input (`fromHandle.type === "target"`, id `in-ref-<i>`) and dropping on empty canvas
  (`!state.isValid`) removes that reference's tag. Dropping on a valid handle still lands
  as a normal connect. This is the exact "drag the connection off of the input" gesture â€”
  prior rounds only covered grabbing the tiny edge-end anchors.
- Edge end anchors styled (`--edgeupdater` accent fill, `cursor: grab`) for discoverability.
- Typecheck + build pass clean.

## MMB pan + input-socket drag-off (round 10)

- **MMB pan**: `panOnDrag={[1, 2]}` â€” middle and right mouse buttons both pan.
- **Input-socket drag-off**: occupied input sockets were `isConnectable={false}`, so drags
  couldn't START from them. They're connectable again (drag-off works), but
  `isValidConnection` now only accepts `targetHandle === "in-ref-open"` â€” occupied sockets
  are never drop targets, so new links still always land on the open socket.
- **Blender cut rule**: `onConnectEnd` disconnects only when the link is released into
  empty space (`!isValid && !toHandle`); releasing on/near any socket snaps back instead of
  cutting â€” prevents accidental disconnects when missing a socket.
- Typecheck + build pass clean.

## Detachable style/brand + white-box fix (round 11)

- **White box behind the output node**: the node type was literally `"output"` â€” a built-in
  React Flow type whose default CSS paints a white background on the wrapper behind custom
  content. Renamed the type to `"frame"` (nodeTypes key + type field); box gone.
- **Detachable style/brand** â€” edges now mirror the prompt sections, same projection model
  as reference tags:
  - Style edge exists iff the prompt has a `Style:` paragraph; brand edge iff
    `includeBrandIdentity`.
  - **Detach** (drag the link off either end into empty space) removes the `Style:`
    paragraph (paragraph-scoped regex matching `updateShotStyle`'s format â€” lesson:
    never end-of-string wildcards) or toggles `includeBrandIdentity` off (existing
    `setBrandForShot` path, which strips the brand clause server-side too).
  - **Attach** (connect style/brand output â†’ its input socket) re-inserts the paragraph
    from the currently selected style (`addStyleParagraph`, idempotent) or toggles brand
    back on. `isValidConnection` now routes styleâ†’`in-style`, brandâ†’`in-brand`,
    refâ†’`in-ref-open`.
  - Choosing a different style in the dropdown still swaps just the style paragraph
    (re-attaching if detached) â€” unchanged sidepanel semantics.
- Typecheck + build pass clean.

## Tag placement above the brand section (round 12)

- `addRefTag` now inserts the `@[Name]` tag **beneath the content paragraphs** â€” before the
  generated `Brand identity:` section when one is present â€” instead of appending at the
  very end (which landed after the brand). Prompt order is now:
  `Style:` â†’ content â†’ `@[tags]` â†’ `Brand identity:`.
- All attachment paths share the helper: graph connect / ï¼‹ button (modal) and file drops +
  frame drops (`attachReferenceToPrompt` now calls the imported `addRefTag`, which also
  upgrades its exact-match dedupe to case-insensitive).
- Typecheck + build pass clean.

## Color-coded prompt sections (round 13)

- New shared `SectionedPrompt.tsx`: a **mirror-under-textarea** â€” the same text rendered
  transparently behind the textarea (identical class â†’ identical padding/border/font/size),
  with each classified paragraph tinted: `Style:` green, content (incl. tag paragraphs)
  purple, `Brand identity:` orange. `box-decoration-break: clone` keeps wrapped lines
  tinted per line; scroll is synced (textarea onScroll â†’ mirror.scrollTop); the mirror's
  hidden webkit scrollbar reserves the same gutter as the textarea's so wrapped lines stay
  pixel-aligned. Purely decorative â€” the value is never modified.
- Paragraph classification is prefix-based (`^Style:`, `^Brand identity:`), matching the
  generated-section formats; unknown prefixes fall to content.
- Integrated in both surfaces: `ReferencePromptEditor` (side panel â€” keeps its caret ref,
  autocomplete, blur cleanup) and the node graph composer (`nodrag`/`nowheel` stay on the
  textarea).
- **Fix: doubled text** â€” the mirror carries the same class as the textarea, whose
  `color: var(--text)` rules (`.prod-prompt-drawer-text`, `.prod-graph-composer-text`)
  overrode `color: transparent` at equal specificity â†’ both copies painted. The mirror
  rule is now `.prod-prompt-sections .prod-prompt-sections-mirror` (0,2,0) so the
  transparent color always wins.
- Typecheck + build pass clean.

## Three-box prompt â€” mirror reverted (round 14)

User call: the mirror overlay still wasn't clean â†’ **reverted** (SectionedPrompt.tsx
deleted, CSS removed) and replaced with **three individual stacked text boxes**:
Style (green label) / Content (purple) / Brand identity (orange, hidden when the brand
section is off).

- New `TriplePrompt.tsx`: `parsePromptBoxes` (paragraph classification â€” first `Style:`,
  first `Brand identity:`, rest incl. `@[tag]` paragraphs = content) + `composePromptBoxes`
  (style â†’ content â†’ brand) + the component. The composed prompt stays the single source
  of truth: boxes are a live decomposition; an echo-suppression ref prevents re-parse
  flicker from our own emits; external changes (generation refresh, style dropdown, brand
  toggle, graph connect) re-decompose.
- Clearing the Style box detaches the style section (matches the graph's style edge);
  clearing Brand empties the paragraph (backend regenerates it on refresh while the
  checkbox is on â€” the checkbox/brand node still owns existence).
- `ReferencePromptEditor` now hosts TriplePrompt; the @-autocomplete + caret math + blur
  cleanup operate on the **content box** (`contentRef`, `onContentChange`,
  `onContentKeyDown` hooks on TriplePrompt). Tag previews unchanged.
- Composer node uses TriplePrompt too (`ComposerData.includeBrand`); VideoGenModal's motion
  prompt uses it with `includeBrand={false}`.
- Typecheck + build pass clean.

## Detachable style box + "None" style option (round 15)

- **Style box existence mirrors the prompt** (same as brand): TriplePrompt renders the
  Style box only while the prompt has a `Style:` paragraph â€” graph detach or dropdown
  "None" hides it; reconnecting/choosing a style brings it back.
- **"None" option** in both style dropdowns (per-shot BoardCard select + graph style node):
  `updateShotStyle("")` strips the `Style:` paragraph (paragraph-scoped regex) and
  **manualizes** auto-derived prompts (via `getBoardPrompt` display text) so the master
  style doesn't sneak back on the next derive. Picking a real style re-inserts the
  paragraph (re-attaches).
- **Select value** via `shotStyleSelectValue(shot, prod)`: "" (None) when the shot is
  manual with no Style paragraph, else `shot.style` with the master fallback â€” so detached
  shots show None while legacy shots still show their effective (master) style.
- **Graph detach â†’ dropdown None**: dragging the style link off now also clears the shot's
  `style` flag (`detachGraphStyle` â†’ saveField) BEFORE the prompt change, so
  `shotStyleSelectValue` sees flag-cleared + manual + no Style paragraph â†’ None. Ordering
  matters: saveField's saveProduction IPC lands before the queued updateBoardPrompt
  (invoke calls preserve order), avoiding the stale-prompt writeback hazard.
- **"Brand typeface" â†’ "Font"** in the generated brand clause (`brandPrompt`,
  pipeline.ts) â€” requires a dev restart (main process).
- **Brand toggle now regenerates the clause**: `effectivePrompt` only appended when the
  paragraph was absent and stripped at display time, so the persisted old wording
  ("Brand typeface") survived every toggle. `setBrandForShot` now physically strips the
  paragraph (OFF) / inserts a fresh renderer-side clause (`brandClause`, OFFâ†’ON picks up
  current wording) in manual prompts; auto-derived prompts regenerate at derive time.
- **Resizable prompt boxes** (side panel): `TriplePrompt resizable` renders drag dividers
  between the stacked boxes â€” pointer-captured drag resizes the adjacent Style/Brand box
  (36â€“420px clamp, content keeps `min-height: 96px`), double-click resets to rows-based
  auto height. Divider has a visible grab bar + `row-resize` cursor (lesson 15).
- **Doubled period on style paragraphs**: every `Style:` composer appended a `.` after the
  style text, which already ends with its own â†’ "render..". Removed the auto-period in all
  four paths (pipeline boardPrompt per-shot + master, renderer dropdown swap, graph
  attach); style text is now used verbatim, consistent with TriplePrompt's composer.
  Requires a dev restart (main process).
- **Resizable boxes in the graph composer**: same `TriplePrompt resizable` dividers;
  corner resizers removed (`resize: none` on `.prod-prompt-box` and the composer class).
  RF re-measures the node on height change so socket bounds stay correct.
- **Video modal stacks above the graph**: the graph overlay is z-index 90, the
  `prod-edit-overlay` dialogs 80 â€” Videoâ€¦ from the output node opened underneath. The
  video overlay now carries `prod-video-overlay` (z-index 100); the graph's Escape handler
  ignores keypresses while that overlay exists so closing the dialog doesn't close the
  graph under it.
- Typecheck + build pass clean.

## Generation nodes (image / video / video-prompt) â€” round 17

New structural nodes in the graph (ids `imagegen`, `videogen`, `videoprompt`; positions
persisted via STRUCTURAL_IDS):

- **Image generation node**: prompt input (structural pipe from the composer), model +
  resolution selects (OpenArt image models), Generate, stored generations with â€¹ n/m â€º
  cycling, two output sockets (`out-image` â†’ video node image input, `out-main` â†’ output).
- **Video generation node**: prompt input (from the video-prompt node), image input
  (`in-image`, piped from the image node or falls back to the shot's frame), model +
  resolution + length selects (length/resolutions fetched live per model via
  `videoModelOptions` like the panel), Generate, cycled clip storage (inline `<video>`
  preview), output socket.
- **Video-prompt node**: textarea persisting `shot.graphVideoPrompt` (seeded with the
  video panel's default motion prompt), piped structurally into the video node.
- **Piping = binding**: connecting `out-main` â†’ output sets `graphOutputSource` and
  applies the selected generation to the shot (`applyGraphOutput` IPC â†’ artwork /
  videoPath) â€” storyboard + animatic follow automatically. Dragging the pipe off
  unbinds (falls back to the classic composerâ†’output flow). Piping imagegenâ†’videogen
  sets `graphVideoImageSource`; new generations in a piped node auto-apply.

Main process:

- `openArtImageGen` gained a resolution override; `openArtVideoGen` gained a
  `sourcePathOverride` param, returns `{ rel }` and no longer mutates `videoPath` itself
  (the classic `production:generateVideo` handler applies it as before).
- New IPCs: `production:generateFrameNode` (custom prompt via `resolvePromptReferences`
  tagâ†’token conversion; writes via `writeBoardFrame`; stores a `GraphGenItem`; applies
  artwork when piped), `production:generateVideoNode` (same pattern for clips),
  `production:applyGraphOutput` (sets artwork/videoPath).
- Schema: `ProductionShot.graphImageGens/graphImageGenIndex/graphVideoGens/
  graphVideoGenIndex/graphVideoPrompt/graphVideoImageSource/graphOutputSource` +
  `GraphGenItem` â€” ride the shot-spread save. **Requires a dev restart.**
- Typecheck + build pass clean.

## Output-as-sink + generation history strips (round 18)

- **Output node is a pure sink** fed ONLY by the generation nodes: the classic
  composerâ†’output edge is gone (as are the output node's Generate/Video buttons and the
  modal's onGenerate/onVideo/submitting props â€” classic batch generation still lives in
  the top toolbar). The output shows the bound node's **selected** generation (image or
  playable video via cascade-media URLs); unpiped it shows the shot's classic artwork
  with a "pipe image or video generation in" hint.
- **Full history strips** on both gen nodes: every stored generation renders as a
  clickable thumbnail (image node) / numbered chip (video node) â€” clicking selects;
  selection in a piped node applies to the shot (`selectGraphGen` + cycle delegates to
  it). Arrows kept alongside.
- **Single output socket per gen node; output is input-only**: `graphVideoImageSource`
  replaced by `graphImageOutTarget` ("videogen" | "output") â€” the image node's one output
  feeds either the video node's image input or the output (mutually exclusive; routing to
  one displaces the other). Video node's output only feeds the output. Output node lost
  its history line â€” it just mirrors the piped input (falling back to the shot's classic
  artwork when nothing is piped). Disconnect rules: drag-off from either end unbinds the
  pipe the edge belongs to.
- Typecheck + build pass clean.

## Generation migration into the nodes (round 19)

Existing projects kept their generations in the classic fields (`artwork` +
`artworkHistory`, `videoPath`), so the gen nodes looked empty and the output node seemed
to hold them.

- **One-time migration** (`migrateGraphGenerations`, hooked into `loadProduction`'s
  migration pass and persisted in place): for each shot with empty gen nodes, the current
  artwork + history seed the image node's items (newest first), and `videoPath` seeds the
  video node. No-op once a node holds items.
- **All classic generation flows now also record into the nodes** via
  `recordGraphImageGen` / `recordGraphVideoGen` (cap 20): batch board generation, AI frame
  edit, board imports, the classic video flow, and the node-gen handlers (refactored onto
  the same helpers).
- **Output node shows only its pipe**: removed the unbound artwork fallback â€” no pipe in,
  no preview (blank + hint). The storyboard itself is unchanged.
- Typecheck + build pass clean.

## Round 20 â€” connect fix, move migration, strip direction, node defaults

- **Connect failure root-caused**: stale handler fragments â€” `isValidConnection` still
  required the removed `out-image`/`out-main` source-handle ids (imagegen's single
  id-less socket â†’ `sourceHandle` null â†’ every connection rejected), and `onConnect` had
  lost its pipe routing. Both rewritten; style/brand re-attach branches restored.
- **Migration is now a MOVE** (`graphMigrated` marker): classic artwork + history and
  `videoPath` move into the gen nodes (deduped by path â€” covers projects already seeded
  by the earlier copy-migration) and the classic fields clear, so the storyboard frame
  starts empty until a generation is piped into the output.
- **History strips reversed**: oldest â†’ newest left-to-right (newest on the right);
  â€¹ = older, â€º = newer (both gen nodes; the video node's strip was missing its arrows â€”
  restored).
- **Image node defaults** come from the production's OpenArt config (model + resolution
  pickers preselect what the top-of-page pickers chose).
- Typecheck + build pass clean. **Restart the app to pick up the migration.**

## Round 21 â€” strict output, no delete button, accurate video options

- **Strict output model**: unpiping (any form) clears `artwork`/`videoPath` â€” the
  storyboard frame goes blank the moment nothing is piped into the output. Batch board
  generation also only reaches the storyboard when the image node is piped; otherwise it
  lands in the node's history. "Has a frame" markers updated everywhere (batch targets
  skip shots with node generations, `markBoardsStatus`, boardsDone counter).
- **"Delete this frame" removed** from the storyboard card (button, prop, and the
  renderer's `deleteBoard` â€” the frame is owned by the output pipe now).
- **Accurate video options**: `videoModelOptions` is mode-aware â€” the caller says whether
  it needs the image-to-video or text-to-video form (the node passes its image-source
  state), and the first mode whose form declares options wins with NO cross-mode merging
  and NO duration thinning (Grok Imagine 1.5 â†’ 480p/720p + every second 1â€“15). Node
  refetches when the image pipe changes.
- **Faster population**: per-model/per-mode cache in the graph modal â€” each combination
  is fetched once per session, reopens and re-renders are instant.
- Typecheck + build pass clean.

## Blender-model connect/disconnect rework (round 9)

Three root causes found for "connecting/disconnecting is buggy, nodes jump, huge dots,
can't drop on a socket":

1. **Node jump**: connecting a ref changed its node id (`avail:<id>` â†’ `ref:<id>`) â†’ the
   reconcile effect removed + re-added the node â†’ it teleported from the unused column to
   the tagged column (and back on disconnect). **Fix: unified id scheme** â€” refs are always
   `ref:<refId>` whether tagged or not; toggling a tag now only changes the edge and the
   default-column membership, never the node's position.
2. **Huge dots**: the "dots" were the edge-update anchors (accent-styled, r=5px) from the
   reconnect machinery. **Fix: anchors removed entirely** â€” all edges `reconnectable: false`,
   `onReconnect`/`onReconnectEnd`/`edgesReconnectable`/`reconnectRadius` deleted, anchor CSS
   removed. Disconnect is exclusively drag-off-socket.
3. **Can't drop on a socket**: socket positions are percentage styles â€” when the socket
   count changes they move without the node resizing, so RF's measured handle bounds went
   stale and `connectionRadius` snapping missed. **Fix: `useUpdateNodeInternals` on socket
   count change + `connectionRadius={30}`.**

Blender behavior model now:

- **Connect**: drag from any output socket â†’ the open Reference input accepts the drop
  (`isValidConnection` restricts links to `ref:* â†’ composer`, so style/brand lines can't
  land anywhere â€” they're structural); occupied sockets are `isConnectable={false}` so new
  links always land on the open socket and never "jump" to a re-indexed one.
- **Disconnect**: drag the link off **either** end â€” off an input socket (`in-ref-<i>`) or
  off a reference node's output â€” and dropping on empty canvas removes the `@[Name]` tag.
  Style/brand links are structural and can't be pulled off (nothing to remove).
- Typecheck + build pass clean.
---

## Architecture review 2026-08-30 ï¿½ OpenArt module extraction (candidate 1)

- New pp/src/main/openart.ts: `OpenArtClient` owns the whole OpenArt vertical slice that
  lived inside `index.ts`'s `registerIpc()` ï¿½ model discovery/parsing, live form-schema
  introspection, per-model option assignment (aspect/resolution/count/duration/refs), async
  image+video generation incl. the PENDING -> creation_wait polling loop, project resolution,
  the per-model video-options cache, and reference upload/token-swap. `McpManager` is injected
  (the seam); nothing in the module touches Electron.
- `index.ts` shrank 2937 -> 2051 lines: 8 channels now delegate to `openart.*`; the
  per-production queue + rebase stayed (production concurrency, not OpenArt). Restored
  `prettifyModelId` (general helper that had sat inside the deleted block).
- First app/ test harness: vitest (`npm test`), `vitest.config.ts` with the `@core` alias,
  `test/openart.test.ts` = 12 tests against a fake `McpManager` (parsing, assignment,
  token swap, PENDING loop, FAILED path, credits, caching). `vi.mock("electron")` +
  `vi.mock("scripting")` keep the Electron/scripting modules out of the node test process.
- Verified: typecheck clean, 12/12 tests pass, production build succeeds.

---

## Architecture review 2026-08-30 ï¿½ IPC contract (candidate 2)

- `shared/ipc.ts` now carries a single channel contract (`ipcContract`): a map of
  channel -> { method, kind: invoke|send }. The `CascadeApi` interface stays the documented
  renderer surface; a type-level drift guard (`AssertEqual<ExposedMethod, ContractMethod>`)
  forces the two to match exactly ï¿½ a channel/method typo now fails typecheck.
- `preload/index.ts` collapsed from a 155-line 1:1 stub list to a ~40-line generic adapter
  that builds `window.cascade` by walking the contract; the 8 `on*` subscriptions stay
  hand-wired. Adding a channel is now ONE entry in `ipcContract` instead of three files.
- Main side: `ipcMain.handle/on` calls go through `handle()`/`on()` wrappers that reject
  undeclared channels and, at the end of `registerIpc()`, throw if any declared channel has
  no handler ï¿½ contract drift fails loudly at startup.
- "Types stop lying": `SessionFile.history` is now `ChatMessage[]` and `.display` is
  `DisplayItem[]` (moved to shared/ipc.ts; renderer re-exports). Dropped the 5 `as
  ChatMessage[]` casts, the `as DisplayItem[]` cast, the untyped `cascadeSync` second
  bridge (folded into `cascade.syncDisplay`), the `frame: unknown` agent-switch leak, and
  dead `hasMentionImages`.
- Verified: typecheck clean (incl. drift-guard firing test), 12/12 tests pass, production
  build succeeds (preload bundle 12.0 kB -> 9.4 kB).

---

## Architecture review 2026-08-30 ï¿½ prompt grammar consolidation (candidate 3)

- New `app/src/shared/prompt-grammar.ts` ï¿½ the one home for the prompt serialization
  protocol, imported by main, renderer, and OpenArtClient:
  - `@[name]` tags: `refTagMatches`/`refTagNames`/`hasRefTag`/`addRefTag`/`removeRefTag`
    (folded NodeGraphModal's escape+tag+style helpers; 6 parse sites -> one module).
  - `Style:` / `Brand identity:` paragraphs: `parsePromptBoxes`/`composePromptBoxes`
    (moved from TriplePrompt), `stripBrandParagraph`/`insertBrandParagraph`/
    `stripStyleParagraph`/`addStyleParagraph` (folded pipeline.effectivePrompt,
    ProductionWorkspace, NodeGraphModal), plus legacy `stripReferenceClause`.
  - Loose JSON: `parseJsonLooseObject`/`parseJsonLooseArray` replaced pipeline's throwing
    `parseJsonLoose` + 3 bespoke openart fence-strip parsers + openart-upload's copy.
    Pipeline's callers now handle null (parseBreakdownJson/styleFromImage/planAnimatic keep
    today's error messages); no throwing variant survives.
  - Media: `dataUrlToBytes` (chunked atob, env-agnostic) replaces index.ts `dataUrlToBuffer`
    + ProductionWorkspace's base64ToBytes; `IMAGE_URL_RX`/`VIDEO_URL_RX`/uri-ext regexes
    fold mcp.ts + openart.ts.
- core/ keeps its own `decodeDataUrlText` ï¿½ it is a standalone package that must not import
  app/shared (noted in CONTEXT.md).
- New `test/prompt-grammar.test.ts` (18 tests) pins the moved behavior; suite is 30/30
  (12 openart + 18 grammar). Typecheck + production build pass.

---

## Architecture review 2026-08-30 ï¿½ pipeline testability seam (candidate 6)

- `pipeline.ts` dropped its top-level `import { nativeImage } from "electron"` for the soft
  import pattern mcp.ts already used (`let nativeImage; void import("electron").then(...)`).
  The two JPEG-conversion call sites fall back to the original bytes when nativeImage is
  unavailable (they were already wrapped in try/catch). The module's pure prompt-derivation
  core now loads in plain node ï¿½ no electron mock required.
- New `test/pipeline.test.ts` (21 tests) covering parseBreakdownJson, normalizeScenes,
  mergeCharacters/mergeProducts, resolveShotStyle, brandPrompt, boardPrompt (style/brand/
  character-key/action, per-shot override, brand-off, refExcluded), effectivePrompt (manual
  wins, brand appended exactly once incl. the insertBrandParagraph regression, brand-off
  strip, auto fallback), shotReferences/refTokens/resolveReferenceTags, scriptMarkdown,
  formatRuntime. Reuses the scripting.js mock (pdf-parse transform issue).
- Suite now 52/52 (12 openart + 19 grammar + 21 pipeline). Typecheck + production build pass.

---

## Architecture review 2026-08-30 ï¿½ document store deep module (candidate 4)

- New `app/src/main/store.ts`: `createStore<T>({ dirName, idOf, sortKey, decode?, encode?, sideFiles? })`
  owns the whole JSON-document lifecycle ï¿½ atomic temp+rename writes (a crash can no longer
  truncate a session/production/agent file), newest-first `list()`, `load/save/remove/archive`,
  and `newId()`. Side-file hooks let agents move/delete its .md + avatar files alongside the meta.
- `sessions.ts`, `productions.ts`, `agents.ts` now thin: each configures the store and keeps
  its bespoke logic (typed SessionFile factory; productions' normalize-as-decode + summary +
  asset-folder scaffold + in-place migration persist; agents' .md/avatar side files + hasPrompt +
  import/export/duplicate + avatar helpers). `settings.ts` stays bespoke on purpose ï¿½ it's a
  singleton doc with safeStorage encryption + a deliberate memo cache, not a keyed collection.
- New `test/store.test.ts` (7 tests): atomic round-trip (no .tmp leftovers), newest-first sort,
  corrupt-file tolerance, decode hook, archive/remove with side-file hooks, newId. Suite is now
  64/64 (12 openart + 19 grammar + 21 pipeline + 7 store + 5 video-fix). Typecheck + build pass.
- Deferred (noted, not re-litigated): the `production:save` handler's field-whitelist merge is a
  deliberate renderer-state merge, distinct from `normalize`'s back-fill ï¿½ folding them is
  behavior-sensitive and left for a future pass. Follow-up: animatic timeline doesn't show a still
  when a video node is plugged into the frame output.

---

## Architecture review 2026-08-30 ï¿½ ProductionWorkspace split (candidate 5)

- `ProductionWorkspace.tsx` 4072 -> 1805 lines by extracting the ~14 module-scope components
  into `components/production/` (pure moves, zero behavior change):
  - `hex.ts` ï¿½ color/uid utils (pure, no React).
  - `animatic.tsx` ï¿½ the Step 4 playback engine + timeline (AnimaticThumb, MiniAudioPlayer,
    VolumeSlider, AnimaticTimeline, StepFooter, ProdLog, LogLine) + shared timeline helpers
    (flatShots/totalDuration/dataUrlToArrayBuffer/cascadeMedia/formatRuntime) + STEPS /
    VIDEO_POOL_MAX / ANIMATIC_MAX_ZOOM consts.
  - `references.tsx` ï¿½ Step 2/3 reference sections + PromptReference/promptRefsForShot/
    brandClause/shotStyleSelectValue/RefMediaGlyph.
  - `prompt-panel.tsx` ï¿½ ReferencePromptEditor + PromptSidePanel.
  - `boards.tsx` ï¿½ BoardCard + VideoGenModal + EditBoardModal.
  - `brand.tsx` ï¿½ BrandSwatchRow + BrandColorPicker.
- Each file owns its imports (shared/ipc types, prompt-grammar, TriplePrompt, cross-file deps:
  boards->references/prompt-panel, references->animatic for cascadeMedia). The orchestrator now
  imports the six modules and keeps the 5-step state handlers + JSX.
- Verified: typecheck clean, 64/64 tests pass, production build succeeds (renderer 219 modules).

---

## Architecture review 2026-08-30 ï¿½ repo hygiene (candidate 7)

- Deleted tracked junk: `app/decrypt-key.js` (decrypts the installed app's API key ï¿½ the
  security liability), `extract-asar.cjs` + the 1,926-line `installed-main.txt` dump,
  `mcp-init.mjs`, `scan-ico.{mjs,ps1}`, `sess-summary.cjs`/`sess-view.cjs`,
  `find-test.cjs`, the repo-root `` file, `core/src/.fuse_hidden*`, and the tracked
  `app/release-0.6.5/` build output (icon + builder-debug.yml).
- Keepers moved to `app/scripts/`: `test-mcp-live.ts` + `test-skills.ts` (documented live
  integration checks; relative imports fixed to `../src/main/...`).
- Deleted untracked disk junk: repo-root `_bundle_*`/`_classes.txt`/`_seg.txt`/
  `tmp_modal.txt`, app `dev-*.log`/`typecheck.log`/`probe-*.mjs`/`tmp_probe*`, and the
  whole `app/release-0.6.5/` output dir. `phase0/` kept (intentional API-probe scripts).
- `.gitignore`: `release-v*/` -> `release-*/` so future electron-builder output
  (`app/release-0.6.5` and the root snapshots) stays untracked.
- Verified: typecheck clean, 64/64 tests pass, production build succeeds. Nothing references the
  deleted files (electron-builder output path is regenerated on `npm run package`).

---

## Deferred issues resolved 2026-08-30

- **Animatic still frame**: `pipeline.applyVideoOutput(shot, rel, sourceFallback?)` sets the
  shot's `videoPath` AND, when the shot has no primary artwork, adopts the video's source
  frame (the image node's current output, else the piped source) as the still ï¿½ so the animatic
  timeline always has a frame. Used by `production:generateVideoNode` and
  `production:applyGraphOutput` (kind=video). 4 new tests in pipeline.test.ts.
- **production:save merge folded**: the inline whitelist merge moved out of index.ts into
  `productions.applyRendererState(fresh, incoming)` ï¿½ the write-side counterpart to
  `normalize`'s read-side back-fill, so the production document's shape rules live in one
  module (and are unit-testable). Handler is now a thin call. 8 new tests in
  test/productions.test.ts. Suite is now 76/76.
- **New skill**: `.opencode/skills/cascade-architecture/SKILL.md` ï¿½ future agents read it
  (with CONTEXT.md) before touching the codebase; it encodes the deep-module rules (seams to
  inject, where code lives, the deletion test, interface-as-test-surface, no-scratch-files) and
  the verification gate (typecheck/test/build).

---

# Node graph: Edit Image node

A node version of the classic AI-edit popup (`EditBoardModal`), set up like the video
generation node: a **source input**, a **prompt input**, and an **output** pipe.

## Schema (`shared/ipc.ts`)
- `ProductionShot` gains `graphEditGens`/`graphEditGenIndex` (stored edits, newest first),
  `graphEditPrompt` (edit-prompt node text), `graphEditImageSource` (imagegen feeds the
  source input), `graphEditSourceRefId` (a reference feeds the source input â€” single
  source, connecting one displaces the other), and `graphOutputSource` gains `"editgen"`.
- New channel `production:generateEditNode` â€” one `ipcContract` entry; preload + the drift
  guard follow mechanically.

## Main (`main/index.ts` + `pipeline.ts`)
- `generateEditNode` handler mirrors the classic `editBoard` (`imageGenFn` + the same
  "Edit this reference image" prompt). Source resolution: image-node pipe
  (`graphImageGens[index]`) > reference pipe (`refArtworkDataUrl`) > shot's frame; writes
  via `writeBoardFrame` + new `recordGraphEditGen` (cap 20). Applies to the shot only when
  `graphOutputSource === "editgen"`.
- `hookImageGenToOutput`/`hookVideoGenToOutput` now also refuse to displace a deliberate
  `editgen` output pipe.

## Renderer (`NodeGraphModal.tsx` + `ProductionWorkspace.tsx` + CSS)
- New `editgen` node (model select over image-input models, Source hint line, thumbnail
  history strip + â€¹n/mâ€º cycle, Generate; labeled Prompt + Source input sockets and the
  output socket, gutter `padding-left: 84px`) and `editprompt` node (persisting textarea).
  Default column between imagegen and videogen; ids in `STRUCTURAL_IDS` so positions persist.
- Wiring: `editpromptâ†’editgen.in-prompt` structural; `imagegenâ†’editgen.in-image` binds
  `graphEditImageSource`, `refâ†’editgen.in-image` binds `graphEditSourceRefId` (image refs
  only; both `isValidConnection`-gated); `editgenâ†’output` binds `graphOutputSource:
  "editgen"` and applies the selected edit as `artwork`. Drag-off the source socket clears
  both source fields; dragging off the editgen output or a feeding imagegen/ref source
  unbinds the pipe. `selectGraphGen`/`cycleGraphGen` gained the `"edit"` kind.

## Verify
- [x] `npm run typecheck`, `npm test` (80/80), `npm run build`, `git diff --check`
- [ ] Manual: edit prompt â†’ Generate lands on the node; pipe editgenâ†’output updates the
      storyboard; source hint switches between piped frame / reference name / shot frame;
      connecting imagegen + ref to source displaces the other; drag-off unbinds.
- Requires a dev restart (main process changed: new IPC).

## Follow-up round (cursor fix + resolution dropdown)

- **Cursor jump fixed** â€” typing any prompt box in the node view sent the caret to the
  end after one character. Root cause: the node graph's `nodes` state lags `prompt` by one
  render (the derived nodes reconcile in a post-commit effect), so `TriplePrompt` received
  a STALE echo of the previous value on every keystroke; its echo-suppression ref only
  remembered the single latest emitted value, so the stale echo re-decomposed the boxes and
  React reset the textarea caret to the end. `TriplePrompt` now tracks a set of every value
  it has emitted and ignores any echo (current or stale) on re-decompose; a genuine external
  value (style dropdown, brand toggle, generation refresh) clears the set and re-parses. The
  side panel passes the value directly (no lag), which is why only the node view jumped.
- **Resolution dropdown on the edit-image node** â€” the edit node now has a 1k/2k/4k
  resolution `<select>` (matching the image node, defaulting to the production's OpenArt
  config). `generateEditNode` accepts `opts.resolution` and passes it to
  `imageGenFn(p, model, resolution)`; `EditGenNodeView`/`onRunEditGen`/`runEditGenNode`
  thread the choice through.
- Verified: typecheck clean, 80/80 tests, production build passes, `git diff --check` clean.
  No new main-process surface for the resolution thread (the existing `generateEditNode`
  channel signature grew one optional field â€” still needs a dev restart).

## Follow-up round 3 (mid-text caret root-caused + inline prompts)

The user's report was decisive: typing at the END works (caret is already there), but
INSERTING mid-text jumps to the end â€” so a per-keystroke caret reset happens on EVERY
edit, hidden only when the caret was already at the end.

Root cause (verified by reading React DOM internals + a faithful jsdom harness):
- React's controlled-input restore (`restoreStateIfNeeded` in `finishEventHandler`) writes
  the committed prop value back to a focused textarea whenever the DOM value differs from
  the prop at restore time. In a normal controlled editor `flushSync` commits the new value
  first, so no revert. But the node graph's value LAG (derived node data reconciled in an
  effect) plus any re-decompose of the boxes makes the prop stale at commit, so React
  re-writes and drops the caret to the end.
- My first tests were FALSE PASSES: setting `textarea.value` goes through React's tracked
  value setter, which updates the change-detection tracker â€” so `onChange` never fired and
  React never touched the element. The harness now sets the value through the
  `HTMLTextAreaElement.prototype.value` descriptor (bypassing the override) to simulate the
  browser's internal write; the tests now exercise the real `onChange â†’ re-render â†’ caret`
  path.

Three-part fix:
1. **`TriplePrompt` focus-deferral** (`deferExternalWhileFocused`, used by the composer):
   while a box is focused, external value changes are ignored â€” the user's local edits stay
   authoritative until blur, so no re-decompose can reset the boxes mid-keystroke. The side
   panel keeps re-decomposing while focused (its `@`-autocomplete needs it).
2. **`PromptContentEditor` echo suppression**: the rebuild (which used to drop the caret to
   `text.length` = END) is now skipped when the incoming text is the raw value this editor
   last emitted â€” the DOM already holds it, even if Chromium restructured the contenteditable
   around the `@[Name]` chips. Genuine external changes still rebuild, and a rebuild while
   focused now preserves the user's actual caret (clamped) instead of jumping to the end.
3. Kept the `TriplePrompt` emitted-set (multi-render lag safety).

New test infra: `test/setup-dom.ts` (jsdom globals before react-dom loads) + jsdom/@types
devDeps; 7 regression tests in `test/tripleprompt-caret.test.ts` + `test/nodegraph-caret.test.ts`
(real `ReactFlow` composer render via the exported `graphNodeTypes`). Suite now 87/87.

**Video/edit prompts are now INLINE.** Removed the `videoprompt` and `editprompt` nodes â€”
the video and edit nodes carry their own prompt textarea (persisting
`shot.graphVideoPrompt` / `shot.graphEditPrompt`), like the image node's self-contained
layout. Dropped the `e-vp-vid`/`e-ep-edit` edges and the `in-prompt` sockets on both nodes;
`STRUCTURAL_IDS`, `defaultPosition`, and `nodeTypes` updated. Typecheck + build clean.

---

## Fix: edit-image node output shows in the graph but not the storyboard

User report: the edit-image node's output piped into the frame output node renders in the
node view but never reaches the storyboard card.

### Root cause
The graph's frame output node derives its preview from the **piped gen node's selected
output** (`graphEditGens[graphEditGenIndex].path`), but the storyboard reads
`shot.artwork` â€” a separately-maintained mirror field. The mirror is only correct if every
apply/generation lands on `shot.artwork` and nothing races it. Real production data had the
exact desync: shot 1800 was `graphOutputSource: "editgen"` with a valid edit file in
`graphEditGens[0]` on disk but `artwork` empty â†’ node view correct, storyboard "no frame".
(Also present: `graphImageGens` items seeded from legacy flat/`shot-undefined` paths.)

### Fix
The output pipe is now the source of truth; the mirror is re-derived at read and write time:
- New pure `syncBoardOutputToPipe(shot)` in `pipeline.ts` â€” for `imagegen`/`editgen` sets
  `artwork` to the selected gen's path (and clears a stale `videoPath`); empty piped node â†’
  blank frame; `videogen` syncs `videoPath` (+ image-pipe still fallback).
- Runs on every `loadProduction` (`migrateBoardArtwork`) â†’ **self-heals existing documents**
  (the next load fixes the user's shot 1800).
- Runs inside `applyRendererState` â†’ a stale renderer `production:save` can no longer
  clobber the piped frame back out (the race that originally produced the desync).
- `ref`/unpiped/classic shots are untouched (refs are already applied to `artwork`/
  `videoPath` by `applyGraphRefOutput`).

### Verify
- [x] `npm run typecheck`
- [x] `npm test` (142 tests incl. new `syncBoardOutputToPipe` + `applyRendererState` cases)
- [x] `npm run build`
- [x] Healed the real production docs (verified shot 1800: artwork mirrors the piped edit)
- Requires a dev restart (main-process change).

---

# Expenses ledger â€” PLAN

A running tally of every AI generation made in-app, priced per (kind, model,
resolution, video-length) combo the user configures, plus manual "purchased
asset" rows. Shown on a new **Expenses** tab on the far right of the step-tabs
row; pricing edited from a new **Expense pricing** section in Settings. Durable
record = JSON ledger + a human-readable CSV text file the user asked for.

**Status: IMPLEMENTED** (2026-09-04). 10 new ledger tests + 3 recorder seam
tests; `npm run typecheck`, `npm test` (193 passed), `npm run build` all green.
Requires a dev restart (main-process change).

## Decisions (settled, don't re-litigate)

- **Instrument once, not eight times.** Every image gen funnels through
  `OpenArtClient.imageGenFn()` (`openart.ts:851`) and every video gen through
  `generateVideoClip()` (`openart.ts:968`). Recording happens at those two
  success points via an injected `onGeneration` callback (constructor seam â€”
  same pattern as the `McpManager` injection). The resolved model id,
  resolution, aspect ratio, and `durationSec` are all in scope there; they are
  NOT in the persisted `GraphGenItem` records, so re-deriving at the 8 IPC
  handler sites would be fragile.
- **Price is stamped at record time** (historical entries are immutable â€”
  correct accounting). Editing a rule only affects future generations.
- **Pricing rules = wildcard rules, not a full matrix.** Each rule is
  `kind + model + resolution + (video) durationSec` with `"*"` wildcards.
  Exact match beats wildcard; no match = $0. Full 3-axis matrix input is
  impractical (model count changes, resolutions differ per model form).
- **One deep module owns the concept.** `app/src/main/ledger.ts` holds
  entries + rules + CSV mirror + price matching. Settings UI writes rules via a
  `ledger:` channel; `settings.ts` stays untouched.
- **Persistence shape.** Single `userData/ledger.json` (settings-style memo
  singleton, atomic temp+rename writes mirroring `store.ts:60-69`) as source of
  truth; every mutation rewrites a human-readable `userData/expenses.csv`. The
  CSV is the "text file" â€” it is a real text artifact the user can open. Note:
  a `createStore` (one JSON per entry) was considered but rejected â€” the user
  explicitly wants ONE readable text file, and ledger is app-global like
  settings, not a per-document collection.
- **Tab placement.** Far-right button inside `.prod-steps` nav
  (`ProductionWorkspace.tsx:1635-1646`) with `margin-left: auto` (the
  `.view-tabs-right` pattern, `styles.css:86`). It shows only when a production
  is open â€” the step-tabs row only exists then. If we later want it global, it
  moves to `ViewTabs`; not part of this scope.
- **No backfill.** No generation history exists before this feature.

## Data model (`app/src/shared/ipc.ts`)

- [x] `LedgerEntry` = `{ id, kind: "image" | "video" | "manual", model, resolution,
      durationSec?, aspectRatio?, price, at, label?, productionId?, shotId? }`.
      `manual` rows carry only `label` + `price`. `prompt` intentionally NOT
      persisted (noise + size).
- [x] `ExpensePriceRule` = `{ id, kind: "image" | "video", model, resolution,
      durationSec: number | null, price }` â€” empty string / null = `"*"`.
- [x] `LedgerView` (renderer read model) = `{ entries: LedgerEntry[],
      total, imageCount, videoCount }`.
- [x] `LedgerGenMeta` (main-only, passed to the `onGeneration` seam) =
      `{ kind, model, resolution, durationSec?, aspectRatio?, at, productionId?, shotId? }`.

## New module `app/src/main/ledger.ts` (deep, unit-tested)

- [x] Singleton (settings-style memo cache) over `userData/ledger.json`:
      `{ entries, priceRules, updatedAt }`.
- [x] Pure `matchPriceRule(rules, gen)` â†’ scored exact-over-wildcard match,
      returns `price` (0 when nothing matches). Unit-tested.
- [x] `recordGeneration(meta)` â€” computes price via `matchPriceRule`, appends
      entry, rewrites JSON + CSV.
- [x] `addManualEntry(label, amount)` / `removeEntry(id)`.
- [x] `getView()` â†’ `LedgerView` with `total` (sum over all entries),
      `imageCount`, `videoCount`.
- [x] `getPriceRules()` / `setPriceRules(rules)`.
- [x] `openTextFile()` â€” `shell.openPath` on the CSV (fire-and-forget).
- [x] CSV mirror `userData/expenses.csv`, rewritten on every mutation:
      `date,kind,model,resolution,duration_sec,price,label`. CSV values quoted;
      CRLF. (This is the "saved to a text file" requirement.)

## Instrumentation â€” `app/src/main/openart.ts`

- [x] `OpenArtClient` constructor gains optional `onGeneration?: (m: LedgerGenMeta) => void`.
- [x] In `imageGenFn` closure: after a buffer is produced (the three return
      paths at `openart.ts:921, 929, 950`), call `onGeneration` with
      `{ kind: "image", model: modelId, resolution: cfgUsed.resolution,
      aspectRatio, at, productionId: p.meta.id, shotId: shot?.id }`. (Only on
      success â€” PENDING-timeout/FAILED paths record nothing.)
- [x] In `generateVideoClip`: after `done.buf` resolves (`openart.ts:1048-1063`),
      call `onGeneration` with `{ kind: "video", model: modelId,
      resolution: opts.resolution, durationSec: opts.durationSec, at,
      productionId: p.meta.id, shotId: shot.id }`.

## IPC + wiring (`shared/ipc.ts`, `main/index.ts`)

- [x] Contract entries (one line each) + `CascadeApi` method signatures:
      `ledger:get` (invoke â†’ `LedgerView`), `ledger:getPriceRules` (invoke â†’
      rules), `ledger:setPriceRules` (invoke), `ledger:addManual` (invoke),
      `ledger:removeEntry` (invoke), `ledger:openFile` (invoke). Preload derives
      automatically (`preload/index.ts:13-17`); drift guards catch misses.
- [x] `registerIpc()` handlers: thin `handle(...)` wrappers over `ledger.ts`
      (`index.ts:632`). Wire the seam: `new OpenArtClient(mcp, { onGeneration:
      (m) => ledger.recordGeneration(m) })` at `index.ts:633`.

## Renderer â€” Expenses page + tab

- [x] New `app/src/renderer/src/components/production/expenses.tsx` (follows the
      extracted-panel pattern in `components/production/`). Loads via
      `window.cascade.getLedger()` on mount; refreshes after mutations.
      - Table: `Date | Type (image/video/manual) | Model | Resolution | Length
        (video) | Price`; manual rows show `label` + `price` (badge "manual").
      - Footer tally: **Total** (sum), plus `N images` / `M videos` counts.
      - "Add custom row" form: `label` + dollar `amount` â†’ `addManualEntry`.
      - Per-row delete (optional but cheap via `removeEntry`).
      - "Open text file" button â†’ `openFile` (reveals the CSV).
- [x] Far-right tab in `ProductionWorkspace`: after the `STEPS.map`, a
      `className="prod-step"` button `margin-left: auto` titled "Expenses".
      New local state `expensesOpen`; clicking a step tab sets it false.
      Body switch: `{expensesOpen ? <ExpensesPanel/> : <step contentâ€¦>}` at the
      `prod.currentStep === N` block (`ProductionWorkspace.tsx:1649+`).

## Renderer â€” Settings pricing section (`SettingsPanel.tsx`)

- [x] New "Expense pricing" section (stacked-modal style, after Skills / MCP).
      Loads rules via `getPriceRules()`; model dropdown from
      `listOpenArtModels()` (displayName) with an "Any model" (`"*"`) option;
      resolution text/datalist (`1k/2k/4k` for image, `480p/720p/1080p/4K` for
      video); duration number shown only for `video` (blank = any); price
      number. Add/remove rows; save via `setPriceRules()`.
- [x] Hint under the table: "Generations that match no rule are priced at $0."

## Tests (`app/test/`)

- [x] `ledger.test.ts`: `matchPriceRule` (exact > wildcard > none â†’ 0; video
      duration matching; image duration ignored), recordâ†’view totals, CSV
      mirror content/quoting, manual add/remove.
- [x] `openart.test.ts`: extend the fake-`McpManager` harness to assert
      `onGeneration` fires with correct meta on image success and video success,
      and NOT on failed/aborted submissions.
- [x] Renderer: no test harness exists for components today â€” verify visually.

## Verify

- [x] `npm run typecheck`, `npm test`, `npm run build` in `app/`.
- [x] Manual: generate a board + a clip, confirm two CSV rows and correct total
      after setting a matching price rule; add a manual row; delete a row.
- [x] Requires a dev restart (main-process change).

---

# In-betweener Node (IMPLEMENTED — all confirmations applied)

New node-graph node that interpolates 2–5 keyframes into one continuous shot.
One action block = 1 start frame + 1 end frame + 1 action prompt, submitted as
a start→end video gen. Blocks stitch into a single clip that pipes to the
frame output node. Timeline UI is styleframe.ai-like: keyframes on a 1s grid,
prompt tracks between them, preview above, per-block history dropdown.

Decisions confirmed by user: renderer modal (not BrowserWindow); keyframes =
wired reference nodes; user-dragged gaps with model duration clamped;
ffmpeg concat stitch; stitched clip becomes shot.videoPath via "tween" feed.
Lossless requirement: lossless `-c copy` first, re-encoded preview fallback
flagged — and the assembly package ALWAYS uses the original per-block clips
back-to-back (EDL `TW<NNNN><X>` reels, folder package, AE script, render).

## Decisions assumed (confirm before build)

All five confirmed yes by the user (modal surface, ref keyframes,
user-dragged gaps, ffmpeg stitch, tween output feed), plus: the stitch must
be lossless; where impossible the assembly room (EDL, folder package, AE
script) uses the original clips one after another.

## Data model (`app/src/shared/ipc.ts`, back-fill in `productions.ts`)

- [x] `TweenBlock { id, startRefId, endRefId, prompt, startSec, durationSec,
  gens?: GraphGenItem[], genIndex?: number }` — per-block prompt + timing +
  history live on the block so the dropdown (`Keyframes` + gens) is per block.
- [x] `ProductionShot.graphTweenRefIds?: string[]` (ordered keyframe refs, 2–5).
- [x] `ProductionShot.graphTweenBlocks?: TweenBlock[]` (derived when refs move,
  but prompt + gens survive re-derivation, matched by `startRefId→endRefId`).
- [x] `ProductionShot.graphTweenModel?: string`,
  `graphTweenResolution?: string` (video model selector state on the node).
- [x] `ProductionShot.graphTweenOutput?: string` (stitched clip rel path) +
  `graphOutputSource` union gains `"tween"`.
- [x] `normalize` back-fills `[]`/defaults; stale ref ids pruned on load;
  `syncBoardOutputToPipe` (pipeline.ts) learns the `"tween"` feed so a stale
  renderer save can never clobber it (lesson 2026-09-02 pattern).

## OpenArt seam (`app/src/main/openart.ts` — probe first)

- [x] Probe live video-model form schemas for end-frame fields
  (`endFrame|lastFrame|endImage|...`). Implemented generically: `videoRefsAssign`
  fills `endFrame|lastFrame|endImage|targetImage|outputImage` object slots from
  the second uploaded reference (same fill-every-sub-prop rule as the Grok fix);
  models without the slot get BOTH frames via the array field merge, so the end
  keyframe is never silently dropped. No live probe was possible from here —
  the first real start→end submission will show which path the model took.
- [x] Per-block submit reuses the `generateVideoClip` wait/poll/ledger path
  (new `frameRefs` param carries start/end data URLs; no new polling machinery).

## IPC (`shared/ipc.ts` `ipcContract` + `index.ts` handlers, preload mechanical)

- [x] `generateTweenBlock(productionId, shotId, blockId, opts)` — resolves the
  block's start/end refs to data URLs, calls the extended `generateVideoClip`,
  appends to `block.gens` (newest first, index 0), returns production. Blocks
  re-derived via `syncTweenBlocks` on every call (pair-key match preserves
  prompts/history; dead refs pruned).
- [x] `stitchTween(productionId, shotId)` — ffmpeg-concats the selected gen per
  block (timeline order) into `videosDir/shot-<num>-tween-<tag>.mp4`: lossless
  `-c copy` first, re-encoded preview fallback flagged on
  `graphTweenReencoded`. Sets `graphTweenOutput`; applies to `videoPath` when
  the tween feeds the output.
- [x] Reused `videoUrl` / `videoModelOptions(model, true)` / `applyGraphOutput`
  — no new channels for those.

## Renderer

- [x] Node graph (`NodeGraphModal.tsx`): new `tween` node type — 5 fixed
  keyframe sockets (`in-tween-0..4`, slot-positional wiring, image refs only,
  5-max), video model selector persisted on the shot (shared with the modal),
  "Open timeline" button, `e-tween-out` output pipe + preview of the stitched
  clip. Right-panel "In-betweener" tile (drag onto canvas). Delete/drag-off
  paths strip keyframes; ref deletion prunes the wiring.
- [x] `TweenTimelineModal.tsx` (new): ≤15s 1s-snap track; draggable keyframe
  thumbs (first pinned at 0s, 1s min gaps); per-block action prompt (draft +
  blur-save) + Submit + takes dropdown (`Keyframes` default + prior gens);
  preview above (selected take's clip, else start→end keyframes); model +
  resolution selects; Stitch button (disabled until every block has a take);
  "Pipe to output" after stitching; `graphTweenReencoded` badge explains the
  preview-vs-assembly distinction.
- [x] Output node preview: `"tween"` feed shows the stitched clip (blank until
  first stitch, like any empty pipe).
- [x] Styles in `styles.css` (`.prod-tween-*`, overlay z-110 above the graph).

## Tests + verify

- [x] `app/test/tween.test.ts` (19 tests): block derivation from ref order
  (prompt/timing/takes survive, fresh pairs default, 15s cap), snap/clamp,
  per-block history newest-first, stitch-input selection skips unready blocks,
  concat-list quoting, `syncBoardOutputToPipe` `"tween"` round-trip + blanking,
  `syncTweenBlocks` no-op/prune, end-frame assignment (both slots, single-ref
  unchanged, array merge, array fallback), assembly expansion (original clips
  back-to-back, stitched preview excluded, `TW0100A` reels, single-clip
  fallback when unready).
- [x] `npm run typecheck`, `npm test` (235 passed, 1 pre-existing skip),
  `npm run build` (app) — all green. `graph-shelf.test.ts` tile count 2→3.
- [ ] Manual: wire 3 refs → open timeline → drag to 2s/4s gaps → prompt each
  block → submit per block → dropdown swaps preview (incl. Keyframes) →
  stitch → pipe → storyboard + animatic play one continuous clip; assembly
  package contains the original block clips with TW reels.
- [x] Restart required (main-process change: new IPCs + schema back-fill).

## Review

Implemented across `app/src/shared/ipc.ts`,
`app/src/main/{pipeline,openart,index,productions,assembly}.ts`,
`app/src/renderer/src/components/{NodeGraphModal,TweenTimelineModal,ProductionWorkspace}.tsx`,
`styles.css`, `app/test/{tween,graph-shelf}.test.ts`, `CONTEXT.md`.

- **Deep module behavior** — block derivation + pipe authority + concat-list
  building stay pure in `pipeline.ts` behind the tested seam; `generateVideoClip`
  grows an optional `frameRefs` param (existing callers untouched);
  `stitchTween` reuses the `ffmpeg.ts` resolve/run seam with temp-list cleanup.
- **Lossless guarantee shape** — the copy-first/re-encode-fallback keeps the
  output/animatic preview always playable, while `assemblyPlan` expands tween
  shots to the original per-block clips (own durations, `TW<NNNN><X>` reels,
  media dedupe) so EDL/package/AE/render never touch a re-encode. When blocks
  are missing files it falls back to the single-clip path so timing never shifts.
- **Known limitation (not re-litigated)** — the animatic plays the stitched
  clip inside the shot's own `durationSec` window (loop/cut per existing clip
  behavior), which may differ from the tween timeline total; assembly uses the
  block durations. Also, no live OpenArt end-frame probe was possible here —
  the generic slot filler covers both schema shapes, and the first real
  submission's MCP log will confirm which path was taken.
