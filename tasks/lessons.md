# Lessons

No session-specific lessons yet.

- Renderer-only changes hot-reload, but the Electron **main process** keeps the build it
  started with. New `ipcMain.handle`s don't exist until the main process restarts (full
  `npm run dev` restart, or `npm run package` for the packaged exe). Symptom: renderer
  changes all work while every new IPC errors with "No handler registered for 'X'" and
  new main-side migrations/recorders never fire. Check `out/main/index.js` for the new
  handler names before re-coding — if the build carries them, the fix is restarting.
- When simplifying a UI workflow, remove its assignment dependency too; the replacement interaction must own the state transition.
- Prompt display and transport forms must stay separate; UI refreshes should never use MCP transport tokens.
- Generated prompt sections must be removed with paragraph-scoped matching, never an end-of-string wildcard that can consume user content.
- Debounced prompt editors need a serialized latest-value queue before generation; otherwise IPC responses can save or display stale snapshots.
- Per-shot prompt display needs a cache plus retry when generation updates persistence asynchronously; null refresh results must not replace visible content.
- Data URLs loaded from IPC should be cached with a content-key (e.g. shot-id + path) and fetched lazily per consumer; reading every shot's audio file eagerly on step entry wastes memory on long productions.
- Model-driven option pickers must look up their choices per selected model at render time, not at fetch time; otherwise switching the model leaves the dependent select in a stale state. On model change, validate the current selection against the new allow-list and fall back to the first option when it's no longer valid.
- Live audio mixing should expose the gain node through a ref so a slider can update it without tearing down the AudioContext; rebuilding the graph for each volume tick produces audible glitches.
- When the data model owns a single resource for the whole production (one VO, one music track) rather than per-shot, drop the per-shot field at the same time the renderer UI loses its per-shot affordance — keeping both in sync prevents stale fields from reappearing in the type and breaking the save handler's whitelist.
- Audio waveforms belong in their own decoded `AudioBuffer` (not the raw ArrayBuffer) so playback and visualization share one decode. The buffer can be downsampled to one `min/max` peak per ~2px column for a smooth canvas curve without redrawing on every frame.
- Resizable UI affordances need a visible handle AND a `cursor: ns-resize` (or appropriate) so the drag target is discoverable; a transparent handle that only lights up on hover reads as dead space.
- Drag-to-seek widgets must compute the seek position from the *same element's* `getBoundingClientRect()` that the user is interacting with, not from a sibling's rect. When two bars (scrubber + strip) both want to be seekable, each needs its own pointer handlers and its own ref to map cursor → progress correctly.
- Pointer events bubble, so any inner draggable (shot handles, future draggable children) must call `e.stopPropagation()` on `pointerdown` to prevent a parent seek handler from also firing and fighting for the same gesture.
- Dual-format asset storage (original + served) should be split behind a single `write(...)` helper that both the generation and import paths call, so the layout never drifts: original in `originals/`, served (re-encoded) in the live dir, and the live path is the only one the renderer ever reads. A separate lazy migration handles the layout for older data on load.
- Time-input parsers should accept the common variants the user actually types (`mm:ss`, `hh:mm:ss`, `1m30s`, `45s`, plain seconds) rather than locking to one format. The cost of a small regex ladder is much less than the cost of users being told their input was "invalid".
- `<audio src="data:…">` with multi-MB base64 payloads often fails to play silently — Chromium bails on data URLs past a few hundred KB. The portable fix is a one-line `useObjectUrl(dataUrl)` hook that converts the data URL to a `Blob` + `URL.createObjectURL` and revokes it on cleanup. The same blob URL works for `fetch()`/decode pipelines (AudioContext, etc.), so the conversion only has to happen once at the IPC boundary.
- Inline native `<audio controls>` need a sane min-width + height in CSS — at `height: 28px` the play button is clipped in some Chromium versions, and at no `min-width` the flex parent squashes the timeline scrubber to ~0px.
- Stable replacement filenames must not be the only reload key: when an imported asset is overwritten in place, bump an explicit renderer content key so same-extension replacements refetch and rebuild the audio URL.
- Serving audio to the renderer as `data:` base64 over IPC is the wrong architecture for large clips (90 s+ VO). Chromium silently bails on multi-MB data URLs in `<audio>`, `fetch(dataUrl)` can reject, and `atob` on a 6 MB string can OOM. The definitive fix is a privileged custom protocol (`protocol.registerSchemesAsPrivileged` with `stream`/`supportFetchAPI`/`bypassCSP` before `app.whenReady`, then `protocol.handle`) that streams the file from disk with `Accept-Ranges`/206 support, and hands the renderer a `scheme://id/path` URL. No base64, no IPC size limits, seekable `<audio>`, and `fetch()`-able for AudioContext decode.
- Two "fixed, still broken" rounds meant the change never reached the artifact the user actually runs. Verify the run target before iterating on the fix: a rebuilt `out/` doesn't touch a packaged `win-unpacked/Cascade.exe` or the NSIS setup exe — repackage (`npm run package`) so the tested binary carries the change.
- On decode-audio failure, never `onVoDurationKnown(0)` if a sibling `<audio>` metadata handler can still report the real duration — a decode fallback must not clobber a valid value or the UI locks at 0:00.
- Imported media should keep their original filenames (only synthesized/generated clips get a stable name like `voiceover.mp3`). Collision-handle (`name (2).ext`) instead of silently renaming; keep the old file unlink-on-replace so the project folder doesn't accumulate orphans.
- Swapping `src` on a shared media element forces Chromium to re-open/demux/decode and paints the element's black backdrop — for any "switch between clips" UI, mount one element per clip (pooled, LRU-capped, visibility-toggled) so cuts become pixel swaps; proactive ±neighbour mounting masks cold loads.
- React's delegated wheel/touch listeners are passive: `e.preventDefault()` inside a component's `onWheel` cannot stop page scroll. Attach a native listener with `{ passive: false }` when an element needs to own the wheel gesture (zooming timelines/canvases).
- Anchoring zoom on a moving reference (playhead): compute target scrollLeft from (refTime × newScale − refTime × oldScale − oldScrollLeft), store it in a ref, apply in `useLayoutEffect` after the resized content commits. Also freeze auto-follow while the user is drag-scrubbing or it fights the cursor.
- When a canvas visualization must redraw per scroll-frame, precompute fixed-bucket min/max peaks once from raw PCM instead of rescanning samples every frame (same idea as per-decode AudioBuffer peaks).
- Never append to markdown files via PowerShell `Add-Content`/here-strings on this machine — backslash sequences become tabs and non-ASCII chars turn into mojibake; use file-edit tooling instead.

## 2026-08-27 — OpenArt credits line missing (video modal)
- Bug: shared parseJsonObject cut replies at the FIRST }, so any reply with a
  nested object ({"user":{...},"credits":N}) parsed to null and the IPC silently
  returned null -> renderer hid the credits line.
- Rules:
  1. Never write a JSON extractor with a first-} heuristic; parse first { to
     last } (full parse first). Nested objects are the norm, not the exception.
  2. When wiring a new IPC/data path, test against the REAL reply shape (probe the
     live server first) instead of only running typecheck — silent catch -> null
     paths hide failures from the UI.
  3. Silent .catch(() => {}) in the renderer is fine for UX, but pairs badly with
     a lossy parser — verify the data survives the whole chain.
