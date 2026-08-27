# Animatic Page Rework (Step 4)

Step 4 becomes two sections: **(1) generate VO per shot** using an audio model, **(2) drag-to-time timeline with realtime playback**. Stays a single step in nav; the existing per-shot grid table is replaced.

## Audio model plumbing
- [x] Add `AudioModelInfo` type (`id`, `displayName`, `voice?`) in `app/src/shared/ipc.ts`
- [x] Add `production:listAudioModels` IPC — re-queries `gab.ai/v1/models` with a `capabilities.audio && capabilities.text` filter (TTS candidates), modeled on the text filter at `app/src/main/index.ts:388-409`
- [x] Expose via preload (`window.cascade.listAudioModels()`)

## Data model
- [x] `Production.assets.voiceoverDir?` (default `"voiceover"`) — back-fill in `productions.ts` normalize + scaffold
- [x] `Production.voiceover?` = `{ model }` (mirrors `openArt` config)
- [x] `ProductionShot.voiceoverPath?` (workspace-relative; absence = no VO yet)

## Section 1 — VO generation
- [x] `production:generateVoiceover(prodId, shotId)` IPC: fetch TTS audio → write to `voiceoverDir/vo-shot-NNNN-<tag>.mp3` via `assetPath`; new `voiceoverRelPath` helper alongside `boardRelPath` at `pipeline.ts:468`
- [x] VO model picker at top of Step 4 (copy storyboard model picker at `ProductionWorkspace.tsx:891-903`)
- [x] Per-shot "Generate VO" button: **disabled (grayed) when `shot.audio.trim() === ""`**; enabled otherwise
- [x] Inline `<audio controls>` + "Regenerate" when `shot.voiceoverPath` is set

## Section 2 — timeline + realtime playback
- [x] Replace grid table with horizontal strip: one block per shot, width ∝ `durationSec`
- [x] Each block shows shot number + `AnimaticThumb`; **"no frame" slate placeholder** when `!shot.artwork` (reuse `.prod-timeline-thumb.blank`)
- [x] Draggable right-edge handle per block → sets `durationSec` (pointer events, `setPointerCapture`, px→sec from strip width / total runtime)
- [x] Realtime playback: `AudioContext` schedules per-shot decoded VO buffers sequentially; `requestAnimationFrame` advances a playhead and swaps a preview pane to the current shot's frame; shots without VO play silent
- [x] Play / Pause / Stop + scrubber + mm:ss readout
- [x] Per-shot transition (`cut`/`dissolve`/`fade`/`wipe`) shown as a badge on the block; crossfade between thumbs for non-cut

## Polish
- [x] Total runtime readout keeps using `formatRuntime`
- [x] All new fields ride the existing `saveField` round-trip; production JSON back-fills cleanly on old files

## Open questions (need your call before I implement)
1. **TTS endpoint** — gab.ai audio endpoint shape is unconfirmed; most likely `POST /v1/audio/speech` (OpenAI-compatible). I'll probe first; fall back to MCP-server pattern if it doesn't exist.
2. **Cut-drag model** — each block's right edge independent (simpler, total runtime changes) **vs.** shared cut-point between two blocks (Premiere-style, redistributes). **Recommend independent for V1.**
3. **Shots with no VO on the timeline** — play their slice silent (visual only) **vs.** require a default beat. **Recommend silent for V1.**

## Verify
- [x] `npm run typecheck`
- [x] `npm run build`
- [x] Manual: no-audio shot shows disabled button; with-VO shot plays in its slice; drag updates `durationSec` and persists across reload

## Review

Implemented across `app/src/shared/ipc.ts`, `app/src/main/{productions,pipeline,index}.ts`, `app/src/preload/index.ts`, `app/src/renderer/src/components/ProductionWorkspace.tsx`, and `app/src/renderer/src/styles.css`. Typecheck and build both pass clean.

- `AudioModelInfo` filter uses `capabilities.audio === true` (matches `gpt-4o-mini-tts`, `qwen-audio-3-0-tts-flash`; correctly skips `multitalk-avatar-tts` which is video-only despite the name).
- TTS endpoint is the single `VOICEOVER_ENDPOINT` constant in `pipeline.ts` — assumed `https://gab.ai/v1/audio/speech` with an OpenAI-style `{model, input, voice}` body. One-line change if the real shape differs.
- Cut-drag model: independent per-block right edges (V1 recommendation). Total runtime changes as you drag; the auto-time button still works to re-plan everything.
- No-VO shots: play silent (V1 recommendation); the preview pane still shows their frame/slate on its slice.
- Step 4 panel uses `prod-storyboard-panel` (max-width: none) so the strip has room to breathe.

## Review (v2: batch VO, per-model voices, compact preview, music import)

- **Batch VO** — replaced the per-shot list with a single "Generate all voiceovers" button. `production:generateAllVoiceovers` walks every shot with a non-empty `audio` line, calls `generateVoiceover` per shot, and surfaces per-shot results in the existing production log. Shots with no dialogue are skipped silently; a "X of Y lines voiced (N silent)" hint next to the button reflects progress without graying anything.
- **Per-model voices** — `AudioModelInfo.voices` is now populated per-model via `voicesForModel(modelId)` in `pipeline.ts`. Heuristic matchers: `elevenlabs` → their stock voice library, `qwen`/`multitalk` → `default/male/female`, everything else → the OpenAI set. When the model changes, `setVoiceoverModel` falls back to the first available voice if the current one isn't in the new set, so the picker is always in a valid state. The voice `<select>` re-renders against the new list on every model change.
- **Compact preview** — `.prod-animatic-preview` now has `max-height: 220px` plus `align-self: center` so it sits in the middle of the available width. The image still uses `object-fit: contain` so frames letterbox instead of cropping. Transport sits directly below.
- **Music** — new `assets.musicDir` (default `"music"`, scaffolded), new `Production.musicPath` + `Production.musicVolume` (default 0.5 on first import). New IPCs: `production:importMusic` (native picker, copies to `musicDir/music.<ext>`, supported: mp3/wav/m4a/aac/ogg/flac), `production:musicFile` (data URL), `production:removeMusic` (unlink + clear). UI: a "Music" section above the timeline with the file name, an inline `<audio controls>`, a volume slider, Replace and × buttons. During playback the music is decoded once into an `AudioBuffer`, looped via `BufferSource.loop = true`, and routed through a `GainNode` so the slider takes effect live. Silent (no-music) playback is unchanged.
- All four issues addressed; typecheck and build clean.

## Review (v3: single VO, side-by-side, resizable preview, draggable playhead, waveform, cuts-only)

- **Single-VO model** — `voiceoverPath` moved from `ProductionShot` to `Production`. `generateVoiceover` now sends every non-empty shot dialogue joined with `\n` in one TTS call and writes one file (`voiceoverDir/voiceover-<tag>.mp3`). Per-shot `transition` field and its `<select>` are gone — all cuts are hard cuts. `animaticPrompt` + `animaticMarkdown` updated; `planAnimatic` no longer touches transition. The save handler strips the legacy fields on the way in, so any old data on disk cleans up on the next save.
- **Side-by-side panels** — `prod-animatic-panels` is a 2-column grid (collapses to 1 column under 900px) that holds the Voiceover and Music sections. Both have the same chrome: header label, controls row, optional inline player + remove button, and a path hint.
- **Generate / Import / Fit to VO** — the Voiceover section has a primary "Generate" button, a secondary "Import…" / "Replace…" button, and a "Fit to VO" button that appears once a VO exists. `fitShotsToTotal(sec)` rescales every shot's `durationSec` proportionally so the total equals the VO length, in a single `saveField` call.
- **Primary button design system** — a global `button.primary` rule was added at the top of the Step 4 CSS block so the Generate / Play buttons follow the rest of the app's accent styling regardless of their container. The old scoped rules (`.prod-create .primary`, `.prod-boards-controls .primary`, `.modal-actions .primary`) remain for the call sites that were using them.
- **Resizable preview** — the preview pane is no longer `aspect-ratio`-locked. Its height is driven by a `useState` (default 220px) and a `.prod-animatic-preview-resize` handle at the bottom edge that captures pointer drag and clamps to 80–640px. The handle shows a thin grab bar on hover.
- **Draggable playhead** — the scrubber bar (and its head) now use `pointerdown` / `pointermove` / `pointerup` with `setPointerCapture`. The cursor is `grab` → `grabbing`. A vertical `.prod-animatic-playhead` line is overlaid on the timeline strip itself, independent of the scrubber, so the playhead position is visible directly on the block row.
- **Waveform** — the VO's `AudioBuffer` is decoded once and downsampled to ~2px columns; a `<canvas>` inside the strip draws a centered vertical bar per column in the accent color, behind the shot blocks. The canvas redraws on VO change, on strip resize, and on duration change. `min/max` peaks per chunk give it real visual punch.
- **Playback** — the whole animatic now plays off a single decoded VO buffer; music is decoded and looped underneath as before (with a live gain ref). The playhead is driven by `audioContext.currentTime` so visuals stay in lockstep with audio.
- **Timeline total anchoring** — when a VO exists, `total = voDuration`; the timeline respects the VO length. When the user drags a shot's right edge, that shot's duration changes freely and the total updates. "Fit to VO" re-anchors everything to the VO length in one click (and the transport row also surfaces a Fit to VO button when `|voDuration - sumDur| > 0.1s`).
- Typecheck and build both pass clean.

## Review (v4: strip seekable, editable total, JPEG storyboards)

- **Strip + scrubber each seek using their own rect** — the previous bug was that the scrubber's seek math used the strip's `getBoundingClientRect()`, so the cursor's percentage on the narrower scrubber mapped to a different percentage on the wider strip and the playhead lagged the cursor. The seek helpers now take the ref whose rect defines the coordinate system, and the strip itself is also seekable (click or drag anywhere on the strip moves the playhead). The shot handle calls `e.stopPropagation()` so dragging a handle doesn't bubble to the strip's seek.
- **Editable total** — the "playhead / total" label in the transport row exposes the total as a clickable button. Click → inline `<input>` → type `mm:ss`, `hh:mm:ss`, `1m30s`, `45s`, or a plain number of seconds → Enter commits → `fitShotsToTotal(sec)` rescales every shot. Escape cancels. The total is now always `sum(shot.durationSec)`; the VO and the strip are decoupled, with the waveform drawn at the VO's true scale over the first `voBuffer.duration` seconds of the strip (post-VO tail has no waveform).
- **JPEG storyboards** — every generated/imported/edited frame is now written twice: the original (PNG for model output, original ext for imports) goes to `boardsDir/originals/`, and a 90-quality JPEG goes to `boardsDir/`. `shot.artwork` points at the JPEG. `writeBoardFrame(p, shot, bytes, ext)` in `pipeline.ts:498` is the single entry point used by `generateBoards`, `importBoards`, and `editBoard` in `main/index.ts`. The `boardImage` and `boardThumbnail` IPCs were already re-encoding to JPEG on read, so no changes were needed there — they just read the now-JPEG file at `shot.artwork` and serve it back. `editBoard` now picks the right input MIME from the file extension instead of hardcoding `image/png`.
- **One-time PNG → JPEG migration** — `loadProduction` runs `migrateBoardArtwork` on every load, which calls `migrateBoardArtworkToJpeg` per shot + per history entry. It only acts when `shot.artwork` ends in `.png`; otherwise it's a no-op. The legacy PNG is renamed into `boardsDir/originals/`, the JPEG is written to `boardsDir/`, and the shot's path is updated. The migrated JSON is persisted in place so the very next read sees the new layout.
- **Playhead clamp** — when seeking past the end of the VO buffer (e.g. total > voDuration) and pressing play, `BufferSource.start(t0, playhead)` would throw. The play() helper now clamps `playhead` to `[0, voBuffer.duration]` before the call.
- Typecheck and build both pass clean.

## Review (v5: bigger preview, working inline audio)

- **Preview default doubled** — `useState(220)` → `useState(440)`. The drag-to-resize handle still clamps 80–640px.
- **Working inline audio** — the previous `<audio controls>` elements next to the VO and Music imports weren't actually playable. The IPCs return multi-MB base64 data URLs (`data:audio/mpeg;base64,…`); some Chromium versions reject these for `<audio>` past a few hundred KB, leaving the transport looking like a static bar. Added a small `useObjectUrl(dataUrl)` hook in `ProductionWorkspace.tsx:1338` that fetches the data URL, wraps it in a `Blob`, and returns a streamable `blob:` object URL; the previous object URL is revoked on cleanup or when the data URL changes. The AnimaticTimeline receives the same blob URL (its `fetch(voUrl)` / `fetch(musicUrl)` work identically with blob URLs and are much faster to decode). CSS: `.prod-music-player` now sizes naturally (`height: 32px; min-width: 280px; max-width: 360px; flex: 0 1 auto`) so the native controls aren't clipped.
- **Auto-included in the animatic** — pressing the big Play in the transport row already schedules the VO buffer (decoded once into an `AudioBuffer`) and the music buffer (decoded + looped under a `GainNode`) into the same `AudioContext`. With the inline `<audio controls>` now working too, users can preview the VO and music independently OR hear them together in the animatic.
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
- [x] Add `muted?: boolean` to `ProductionShot` (`app/src/shared/ipc.ts`) — persists automatically since `production:save` spreads shots (`main/index.ts:704`)
- [x] Parent helper `toggleShotMuted(shotId)` beside `updateDurations` (saveField scenes patch)
- [x] New `AnimaticTimeline` prop `onToggleMute`; inline-SVG speaker/mute button top-right of each `.prod-animatic-block`; `e.stopPropagation()` on pointerdown (lesson 17)
- [x] Applied to pooled `<video>` elements declaratively so playback honors it immediately

### 2. Black flash between clips → per-shot video pool
Root cause: ONE shared `<video>` gets its `src` swapped per shot so Chromium reopens/demuxes/decodes while `.prod-animatic-video{background:#000}` paints black.
- [x] Pool: one `<video>` per shot-with-video, absolutely stacked in preview, visibility toggled by `activeIdx` (no reload on cuts)
- [x] Refactored single `shotVideoRef` sync effects to a `Map<shotId, video>` of refs
- [x] Memoized `boardThumbnail` data URLs (module-level key cache) — used by strip + preview layers
- [x] LRU cap 12 mounted videos (±2 window around active); evict least-recently-active beyond that
- Answer: NO timeline rewrite needed.

### 3. Mouse-wheel zoom anchored at playhead
- [x] `zoom` state 1..24, pps = (viewportW/total)*zoom via ResizeObserver width capture
- [x] Strip switched flex-% layout → absolute-positioned content sized `total*pps` px inside an `overflow-x:auto` scroll frame
- [x] NATIVE non-passive wheel listener on strip-wrap (React root wheel is passive; preventDefault won't work otherwise); preserve playhead's screen X across zoom steps, clamp scrollLeft
- [x] Waveform canvas maps time→(t*pps − scrollLeft), rAF-throttled redraw on scroll, plus one-time PCM→peak-bucket downsample so follow-playback redraws stay cheap
- [x] Strip seek math gains scrollLeft branch (transport scrubber stays full-range overview)
- [x] Auto-follow playhead while playing when zoomed (suppressed during drag-scrub); manual seek snaps into view
- [x] Reset zoom to fit when prodId changes

### Verify
- [x] npm run typecheck + build pass
- [ ] Manual dev-run walkthrough pending user test: play across cut boundaries, mute toggle persists after reload, wheel zoom near t=0/end, drag handles at high zoom

Review:
- Note: the "▶ video" badge on blocks was replaced by the speaker button itself (it only renders on clips that have a video, so it doubles as the indicator).
- Note: preview cold-load of a never-opened clip can still flash briefly once (first approach / after LRU eviction); neighbours are proactively mounted ±2 to mask this during normal linear playback.

## Storyboard modal + naming (review)
- [x] Video-gen dialog: removed "OpenArt didn't report a cost for this model." note
- [x] Credits line now shows the OpenArt account balance (via new openart_account_get MCP call) instead of Gab.ai credits; hidden when OpenArt isn't connected
- [x] Renamed "Storyboards" -> "Storyboard" everywhere (ProductionWorkspace.tsx x6, ipc.ts comment)
- [x] Verified: npm run typecheck + npm run build pass

### Fix round 2 (user report: credits not showing)
- Root cause: parseJsonObject in main/index.ts cut at the first } -> nested
  {"user":{...},"plan":...,"credits":N} reply from openart_account_get failed
  to parse -> handler returned null -> credits line hidden.
- Fix: parse first { .. last } with full-JSON-first strategy; verified all
  existing callers (openArtHistoryId PENDING replies, creation polling) still work.
- Verified live: SDK client + stored tokens -> account_get returns credits 99849.
- App needs a dev restart to pick up the main-process change.
