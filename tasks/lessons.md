## 2026-09-14 — relocating an asset that several fields share

- Moving a generated file into a new folder must UPDATE EVERY field that
  points at it, and the move must be memoized per old path: the first field's
  move deletes the source, so the next field's `existsSync` check sees the
  source gone and leaves that reference on the old path. Clips are reached
  through `videoPath`, `graphVideoGens`, `graphEditVideoGens`,
  `graphTweenOutput`, and tween block `gens` — all of them, plus every future
  renumber path-patch list.
- When an asset moves into a folder that another mutation already relocates,
  wire it into that mutation too. `relocateBoardsForRenumber` renames
  `boards/<old>` → `boards/<new>` and renames inner `shot-<old>-` files, but
  its stored-path patch loop only knew about frame fields — putting clips in
  `boards/<n>/video/` silently orphaned them on shot reorder until the video
  fields were added to the same loop.
- A new one-time migration needs `PRODUCTION_SCHEMA_VERSION` bumped, or every
  already-stamped document skips the walk (perf fast path) and the migration
  never runs.

# Lessons

No session-specific lessons yet.

- Storyboard history must derive from the generation nodes, including edits. Promoting a frame must update the owning node's selected index and output pipe, not just `artwork`, or read-time reconciliation will undo the selection. Test promotion followed by save/load, and ensure storyboard edits use the edit-node recorder.

- Renderer-only changes hot-reload, but the Electron **main process** keeps the build it
  started with. New `ipcMain.handle`s don't exist until the main process restarts (full
  `npm run dev` restart, or `npm run package` for the packaged exe). Symptom: renderer
  changes all work while every new IPC errors with "No handler registered for 'X'" and
  new main-side migrations/recorders never fire. Check `out/main/index.js` for the new
  handler names before re-coding â€” if the build carries them, the fix is restarting.
- When simplifying a UI workflow, remove its assignment dependency too; the replacement interaction must own the state transition.
- Prompt display and transport forms must stay separate; UI refreshes should never use MCP transport tokens.
- Generated prompt sections must be removed with paragraph-scoped matching, never an end-of-string wildcard that can consume user content.
- Debounced prompt editors need a serialized latest-value queue before generation; otherwise IPC responses can save or display stale snapshots.
- Per-shot prompt display needs a cache plus retry when generation updates persistence asynchronously; null refresh results must not replace visible content.
- Data URLs loaded from IPC should be cached with a content-key (e.g. shot-id + path) and fetched lazily per consumer; reading every shot's audio file eagerly on step entry wastes memory on long productions.
- Model-driven option pickers must look up their choices per selected model at render time, not at fetch time; otherwise switching the model leaves the dependent select in a stale state. On model change, validate the current selection against the new allow-list and fall back to the first option when it's no longer valid.
- Live audio mixing should expose the gain node through a ref so a slider can update it without tearing down the AudioContext; rebuilding the graph for each volume tick produces audible glitches.
- When the data model owns a single resource for the whole production (one VO, one music track) rather than per-shot, drop the per-shot field at the same time the renderer UI loses its per-shot affordance â€” keeping both in sync prevents stale fields from reappearing in the type and breaking the save handler's whitelist.
- Audio waveforms belong in their own decoded `AudioBuffer` (not the raw ArrayBuffer) so playback and visualization share one decode. The buffer can be downsampled to one `min/max` peak per ~2px column for a smooth canvas curve without redrawing on every frame.
- Resizable UI affordances need a visible handle AND a `cursor: ns-resize` (or appropriate) so the drag target is discoverable; a transparent handle that only lights up on hover reads as dead space.
- Drag-to-seek widgets must compute the seek position from the *same element's* `getBoundingClientRect()` that the user is interacting with, not from a sibling's rect. When two bars (scrubber + strip) both want to be seekable, each needs its own pointer handlers and its own ref to map cursor â†’ progress correctly.
- Pointer events bubble, so any inner draggable (shot handles, future draggable children) must call `e.stopPropagation()` on `pointerdown` to prevent a parent seek handler from also firing and fighting for the same gesture.
- Dual-format asset storage (original + served) should be split behind a single `write(...)` helper that both the generation and import paths call, so the layout never drifts: original in `originals/`, served (re-encoded) in the live dir, and the live path is the only one the renderer ever reads. A separate lazy migration handles the layout for older data on load.
- Time-input parsers should accept the common variants the user actually types (`mm:ss`, `hh:mm:ss`, `1m30s`, `45s`, plain seconds) rather than locking to one format. The cost of a small regex ladder is much less than the cost of users being told their input was "invalid".
- `<audio src="data:â€¦">` with multi-MB base64 payloads often fails to play silently â€” Chromium bails on data URLs past a few hundred KB. The portable fix is a one-line `useObjectUrl(dataUrl)` hook that converts the data URL to a `Blob` + `URL.createObjectURL` and revokes it on cleanup. The same blob URL works for `fetch()`/decode pipelines (AudioContext, etc.), so the conversion only has to happen once at the IPC boundary.
- Inline native `<audio controls>` need a sane min-width + height in CSS â€” at `height: 28px` the play button is clipped in some Chromium versions, and at no `min-width` the flex parent squashes the timeline scrubber to ~0px.
- Stable replacement filenames must not be the only reload key: when an imported asset is overwritten in place, bump an explicit renderer content key so same-extension replacements refetch and rebuild the audio URL.
- Serving audio to the renderer as `data:` base64 over IPC is the wrong architecture for large clips (90 s+ VO). Chromium silently bails on multi-MB data URLs in `<audio>`, `fetch(dataUrl)` can reject, and `atob` on a 6 MB string can OOM. The definitive fix is a privileged custom protocol (`protocol.registerSchemesAsPrivileged` with `stream`/`supportFetchAPI`/`bypassCSP` before `app.whenReady`, then `protocol.handle`) that streams the file from disk with `Accept-Ranges`/206 support, and hands the renderer a `scheme://id/path` URL. No base64, no IPC size limits, seekable `<audio>`, and `fetch()`-able for AudioContext decode.
- Two "fixed, still broken" rounds meant the change never reached the artifact the user actually runs. Verify the run target before iterating on the fix: a rebuilt `out/` doesn't touch a packaged `win-unpacked/Cascade.exe` or the NSIS setup exe â€” repackage (`npm run package`) so the tested binary carries the change.
- On decode-audio failure, never `onVoDurationKnown(0)` if a sibling `<audio>` metadata handler can still report the real duration â€” a decode fallback must not clobber a valid value or the UI locks at 0:00.
- Imported media should keep their original filenames (only synthesized/generated clips get a stable name like `voiceover.mp3`). Collision-handle (`name (2).ext`) instead of silently renaming; keep the old file unlink-on-replace so the project folder doesn't accumulate orphans.
- Swapping `src` on a shared media element forces Chromium to re-open/demux/decode and paints the element's black backdrop â€” for any "switch between clips" UI, mount one element per clip (pooled, LRU-capped, visibility-toggled) so cuts become pixel swaps; proactive Â±neighbour mounting masks cold loads.
- React's delegated wheel/touch listeners are passive: `e.preventDefault()` inside a component's `onWheel` cannot stop page scroll. Attach a native listener with `{ passive: false }` when an element needs to own the wheel gesture (zooming timelines/canvases).
- Anchoring zoom on a moving reference (playhead): compute target scrollLeft from (refTime Ã— newScale âˆ’ refTime Ã— oldScale âˆ’ oldScrollLeft), store it in a ref, apply in `useLayoutEffect` after the resized content commits. Also freeze auto-follow while the user is drag-scrubbing or it fights the cursor.
- When a canvas visualization must redraw per scroll-frame, precompute fixed-bucket min/max peaks once from raw PCM instead of rescanning samples every frame (same idea as per-decode AudioBuffer peaks).
- Paid probe scripts must be crash-safe: `node --check` catches syntax but NOT missing identifiers, and a crash mid-probe can strand a spend. Structure every paid probe as resumable phases (submit â†’ followup `<jobId>`), and dry-run the full code path against fakes before the live run. The followup mode rescued the 2-credit refs probe after a UUID_RX ReferenceError.
- Never append to markdown files via PowerShell `Add-Content`/here-strings on this machine â€” backslash sequences become tabs and non-ASCII chars turn into mojibake; use file-edit tooling instead.

## 2026-08-27 â€” OpenArt credits line missing (video modal)
- Bug: shared parseJsonObject cut replies at the FIRST }, so any reply with a
  nested object ({"user":{...},"credits":N}) parsed to null and the IPC silently
  returned null -> renderer hid the credits line.
- Rules:
  1. Never write a JSON extractor with a first-} heuristic; parse first { to
     last } (full parse first). Nested objects are the norm, not the exception.
  2. When wiring a new IPC/data path, test against the REAL reply shape (probe the
     live server first) instead of only running typecheck â€” silent catch -> null
     paths hide failures from the UI.
  3. Silent .catch(() => {}) in the renderer is fine for UX, but pairs badly with
     a lossy parser â€” verify the data survives the whole chain.
- When consolidating duplicated helpers into a shared module, preserve every call site's guards ï¿½ an "append if absent" check is load-bearing. effectivePrompt originally guarded its brand append with !hasBrand, and the shared insertBrandParagraph lost that guard, so a manual prompt that already carried Brand identity: (written by the brand toggle) got a duplicate paragraph, which parsePromptBoxes then leaked into the Content box. Always port the guard into the shared helper (make it idempotent) and add a regression test for the exact user-visible scenario.
- OpenArt's per-model form schemas must be mirrored field-for-field, not filtered by convention: building a startFrame object by mapping only url/id keys silently dropped the required type ("image") and label sub-fields, and Grok 1.5's schema rejected the submission ("startFrame.type: expected image"). When filling an object-shaped schema field, copy every declared sub-property from the reference (exact name, then url/id/type/label aliases), and fall back to the whole reference when nothing maps.
- Video-option lookups must use the SAME mode selection as the actual submission: options were fetched from the first mode with options while generation submitted the first mode whose form parses, so a later mode's enum could leak resolutions (e.g. 1080p) the submitted mode never accepts. Align the two selections, and don't change mode-picking logic in one place without the other.

## 2026-09-02 â€” edit-image node output shows in the graph but not the storyboard
- Bug: the node graph's "Frame output" preview derives from the piped gen node's
  selected output (`graphEditGens[graphEditGenIndex].path`), but the storyboard
  reads `shot.artwork` â€” a separately-maintained mirror. When the pipe's apply
  raced a renderer `production:save` (or a pipe was bound while the node was
  empty and the later generation's `if (graphOutputSource === "editgen")`
  check read a stale disk state), `shot.artwork` stayed empty/missing and the
  storyboard showed nothing while the node view was correct. Real data confirmed
  it: shot 1800 had `graphOutputSource: "editgen"`, a valid `graphEditGens[0]`
  file on disk, and `artwork` empty.
- Rule: when two surfaces read the same output, don't keep a second cached
  field that must be re-applied everywhere â€” make the pipe authoritative and
  RE-DERIVE the mirror at read/write time. `syncBoardOutputToPipe(shot)` runs on
  every `loadProduction` (self-heals existing docs) and inside
  `applyRendererState` (so a stale renderer save can never clobber the piped
  frame back out). Test the exact user-visible desync, not just the happy path.

## 2026-09-03 â€” character builder output vanished on save (rebaseProduction whitelist)
- Bug: the Step 2 character builder generated a sheet (file written to disk) but
  the character never appeared in the Load-character dropdown and the mirrored
  reference never landed in the references panel. Same for the older
  reference-image generator. Root cause: both run under `runProductionJob`,
  whose `rebaseProduction` reloads the freshest on-disk production and copies
  ONLY a hardcoded top-level field list (`status`, `currentStep`, `magicEnabled`,
  `magicPrompts`, `assembly`) plus per-shot fields â€” `characters`,
  `references`, and `referenceCategories` mutations were silently dropped on
  save, leaving disk files orphaned (no production entry points at them).
- Rules:
  1. `rebaseProduction` is a denylist-by-default, not a merge: ANY top-level
     collection a `runProductionJob`/`runProductionStep` handler mutates must be
     added to its copy list, or the change disappears while `emit("â€¦done")` and
     the on-disk file say otherwise. Grep the runner's call sites for what they
     mutate, and keep the list in sync.
  2. Files written to disk during a job are NOT proof of persistence â€” a
     `refsDir`/`boardsDir` artifact can exist while no production field points
     at it. Verify the production JSON after a job, not just the file.
  3. When a job mutates renderer-owned collections (characters/references),
     wholesale-copy from the job's copy on change; the concurrent-edit window is
     the job duration and matches how `status`/`assembly` are already handled.

## Lesson: PowerShell text cmdlets corrupt non-ASCII source files (2026-09-07)

Mistake: rewrote `higgsfield.ts` with `(Get-Content $p) -replace ... | Set-Content -Encoding UTF8`.
PowerShell 5.1 `Get-Content` decodes UTF-8 as ANSI (cp1252), so every em dash
became literal mojibake; `FAILED_RX` silently stopped matching a real
`ï¿½ cancelled` job reply. The scripted repair (latin1 round-trip) restored most
chars but cp1252's unmappable bytes became U+FFFD irreversibly, plus stray
control chars ï¿½ only a byte-level scan found them.

- Rules:
  1. NEVER use PowerShell text cmdlets (Get-Content/Set-Content/-replace
     pipelines) to rewrite source files. Use the Edit tool. If a scripted
     rewrite is unavoidable, do it in node at byte level: read utf8, replace
     in JS, write utf8.
  2. After ANY scripted file rewrite, grep the file for non-ASCII/control
     residue (`[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]`) before
     trusting the change.
  3. Encoding damage hides as logic bugs, not syntax errors ï¿½ a regex over
     prose (em dash separators) is exactly where it bites. Tests that match
     real server prose are the safety net.

- Media-model capability flags must come from structured fields only (media/modes/output_type), never free-text descriptions. OpenArt descriptions routinely mention both modalities ('image and video'), so a /video/ match on the description blob misflags image models (e.g. 'Wan 2.7 Image', 'Grok Imagine Image 2.0') as video and pollutes every video dropdown plus the expense-image classification. Test with a fixture whose description mentions video but whose structured fields are image-only.

- Structured-only model classification can DROP models whose structured fields carry no modality tokens (both flags false = invisible everywhere). Use structured fields to decide, but fall back to the description only when structured fields are completely silent ï¿½ that fixes description false-positives without the recall regression.

## 2026-09-10 â€” node-editor perf: two unmeasured fixes missed the bottleneck

- Symptom: opening the node editor is slow on large productions. First round
  (lazy + capped shelf thumbnails, per-group window of 24) made "no noticeable
  difference."
- Root cause of the miss: the fixes were reasoned, not measured. The real costs
  were (a) `BoardCard` was un-memoized, so every workspace state change
  (opening the graph = `setGraphShotId`) re-rendered every card â€” 600 cards
  â‰ˆ 194 ms per render â€” and (b) per-group windowing doesn't bound total items
  when a project has many small categories (200 cats Ã— 15 refs â‰ˆ 2 985 items
  â‰ˆ 640 ms). Both were invisible without a benchmark.
- Rules:
  1. Before optimizing, write a throwaway benchmark that mounts the real
     component with representative large inputs (varied shapes: few-big vs
     many-small) and logs `performance.now()` + a React `<Profiler>`. Delete it
     after. The bottleneck is usually not the one you can reason to.
  2. "Large project" is multi-dimensional â€” shots, references, categories. Test
     each axis; a fix that only bounds one axis (per-group window) won't help
     projects large along another (group count).
  3. A list of memoized children is only memoized if their props are
     reference-stable. Plain `function` handlers recreated each render + inline
     lambdas defeat `memo`. Route per-item callbacks through a `latestRef` +
     stable `useMemo` delegator (keeps them fresh AND stable) and pass the item
     id into the callback.
  4. Per-group virtualization still needs a per-group viewport gate
     (`IntersectionObserver`) or a project with many tiny groups mounts
     everything at once. jsdom has no IO â€” write the gating test with a
     controllable IO stub.

## Async renderer updates vs. closure snapshots in save helpers
- Symptom: dragging a second edit-image node onto the graph made it vanish
  instantly.
- Cause: `saveGraphLayout` rebuilt `scenes` from the render-closure `prod`
  instead of `prodRef.current`. A graph mutation saves its shot fields (via
  `saveGraphShotFields` -> `saveField`, which updates `prodRef`) immediately
  before the layout save, so the stale `prod` clobbered the just-added node.
- Rule: every workspace save helper that rewrites `scenes`/`shots` must read
  `prodRef.current`, never the render-closure `prod`. When two saves fire in
  one event (field change then layout), the later must build on the former's
  result.

## 2026-09-12 — Store cache aliasing silently drops finished generations

- Symptom: an edit-image node run billed (ledger), wrote its files to
  `boards/`, but the history entry never appeared. No error anywhere — the
  job reported success. `script.md`'s mtime proved a renderer
  `production:save` landed mid-generation.
- Cause: `store.ts` hands out the cached document graph by reference, and
  `loadProduction` passed it through. The job held shot/node refs across the
  generation `await`; the mid-run renderer save (`applyRendererState`)
  replaced the cached graph's `scenes`, detaching the job's refs. The job
  then recorded onto orphaned objects and the rebase commit saved without
  the new generation. File on disk, nothing in history, success emitted.
- Fix: `loadProduction` returns `structuredClone(p)` — every holder gets a
  private graph, rebase merges by value. File is tens of KB, so the copy is
  microseconds; the cache still skips the JSON.parse on hits.
- Rules:
  1. Never hold a document object reference across an `await` in main — or
     make sharing impossible (clone on load). A same-thread save cannot
     interleave synchronous code, so the await is the only detachment
     window; any save in that window must not pull the graph out from under
     a holder.
  2. "File written, no record, no error" means the record landed on a
     detached object — check object identity (cache aliasing), not just the
     record call.
  3. Regression test must reproduce the interleaving through the real store
     (job load → holder refs → renderer save → record → commit), not just the
     pure record function.

## 2026-09-11 — Higgsfield t2v+refs 422: rebind, don't just surface

- Symptom: Seedance 2.5 video generation with a board frame + playblast ref
  failed with `mode 't2v' does not accept reference media` (422). The adapter
  bound ordinary submissions to `image_references`/`video_references` only, so
  the backend inferred text-to-video mode and the refs had no legal mode.
- Fix: on that exact validation shape, retry ONCE with the source frame
  rebound to `start_image` (the image-to-video anchor), reusing the already
  uploaded media ids — no re-upload, same prompt. Tween submissions are
  excluded (keyframes already bind start/end slots), as are models declaring
  no `start_image`; both surface the 422 as-is with the submitted param dump.
- Rules:
  1. A backend mode-inference rejection is a binding problem, not a prompt
     problem — retry with the anchor role before giving up.
  2. Keep the per-ref role table (`boundRoles`) parallel to the upload table
     so a retry can rebind without re-uploading; assert both submits in tests
     (snapshot params at capture — the retry mutates the same object).

## 2026-09-16 — PowerShell content rewrite, second offense

- Did it again: `(Get-Content …) -replace … | Set-Content` on a test file to
  refactor act() blocks, despite the 2026-09-07 lesson. Got lucky (ASCII-only
  file, byte scan clean: zero U+FFFD), then redid the remaining edits with
  the Edit tool.
- Rule (strengthened): the Edit tool is the ONLY way to modify file text. If
  a tabular/renaming edit feels too big for one Edit call, split it into
  several Edit calls — never reach for a shell rewrite, regardless of file
  encoding.
