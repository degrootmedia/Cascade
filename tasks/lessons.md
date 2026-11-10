## 2026-10-21 - Lightbox close icon rendered giant (broad `img` rule vs icon <img>)

- Symptom: the new shared lightbox showed a giant red X in the corner. The
  close button's `XIcon` is an `<img class="cascade-icon" width=13>`, but the
  lightbox card's media rule (`.prod-ref-lightbox-card img { width:auto; ... }`)
  outranks the width attribute, so the 365pt source SVG painted near full size.
- Rules:
  1. Any container rule that styles content `img`s must exclude `.cascade-icon`
     (`img:not(.cascade-icon)`) — the shelf/poster rules already did; the
     lightbox card rule predated icons living inside it. When adding an icon
     button inside a media container, check its `img` rules first.
  2. Icon semantics: X = close/dismiss a surface, trashcan = delete/remove a
     thing. Sharing one glyph for both reads as a bug to users.


# Lessons (judgment lessons only)

Mechanical rules live in tests, not here: see `app/test/lessons-guards.test.ts`,
`app/test/source-guards.test.ts`, `app/test/voice.test.ts` (pinned whisper URL),
`app/test/prompt-grammar.test.ts` (idempotent brand insert) and the `structuredClone`
store tests. Each entry below: what happened, what to do instead, how you can tell.

## Selection is not focus in editors
- Happened: node-graph prompt blanked after a style change; a caret restored into an unfocused contenteditable looked like user focus, so the real update was deferred forever.
- Do: gate "don't clobber the user's edit" on `document.activeElement`, never on a selection alone.
- Tell: "closing and reopening fixes it" means local state is stuck out of sync with a correct prop; check echo/sync guards first.

## Shot-owned drafts and read paths
- Happened: Magic Prompt text bled between frames (unkeyed composer, whole-document saves, rebase copying a whole map, reads blocked behind a long write queue).
- Do: key components by the entity that owns their draft; keep per-key maps that long jobs mutate single-writer (main); never let a read await a queue stuck behind an unrelated job; make live text carry its shot id.
- Tell: another shot's text appears, or a panel goes blank during bulk generation.

## Never claim a UI control exists without grepping its call site
- Happened: told the user about a "Refresh" button that only existed as an IPC entry plus CSS.
- Do: grep the renderer for the IPC method/class and confirm an onClick calls it.
- Tell: contract entry + stylesheet rule but no caller.

## Advisory previews must mirror the submit's required inputs
- Happened: cost quotes hid whenever a mode needed media the probe didn't send.
- Do: mirror required inputs; retry once only on the specific rejection message.
- Tell: the pill silently disappears for some modes.

## Relocating an asset that several fields share
- Do: update every field that points at it, memoize the move per old path, wire it into renumber path-patching, and bump `PRODUCTION_SCHEMA_VERSION` for any new one-time migration (a guard test flags a changed migration set).
- Tell: clips orphaned after reorder; migration never runs on stamped documents.

## Re-derive test expectations when a representation changes
- Do: derive each expectation from the new semantics; use distinct timestamps in fixtures when order matters.
- Tell: a "newest-first" assertion that is flaky across same-millisecond writes.

## Refactors: diff control flow, not text
- Happened: a dropped `if (equal) return old;` caused an infinite render loop that looked like a test-runner hang.
- Do: list every early return/break in the old block and confirm the new one has it; A/B with git stash.
- Tell: the runner hangs at the banner.

## Job persistence: files on disk are not proof of a saved record
- Do: verify the production JSON after a job, not only the files. (The rebase copy list itself is guarded by `lessons-guards.test.ts`.)
- Tell: file on disk, no record pointing at it, success emitted.

## Never hold a document reference across an await (clone-on-load covers most of it)
- Tell: "file written, no record, no error" means the record landed on a detached object.

## Model capability classification (no automated check yet)
- Do: classify from structured fields; use the description only when structured fields are silent.

## Probe the real reply shape
- Do: probe the live server before trusting typecheck; silent catch-to-null paths hide failures. (Nested-JSON parsing is guarded by a test.)

## Option lookups must use the submission's mode selection; mirror vendor form schemas field for field
- Tell: an enum offers a value the submitted mode rejects, or a required sub-field is dropped.

## Backend mode-inference rejections are binding problems
- Do: retry once with the anchor role rebound, reusing uploaded media; exclude tween submissions.

## Measure before optimizing
- Do: benchmark the real component on several axes (shots, refs, categories); memoized children need reference-stable props.

## Verify the artifact the user actually runs
- Do: rebuild/repackage so the tested binary carries the change; restart the Electron main process after adding IPC handlers.
- Tell: renderer changes work while new IPC says "No handler registered".

## Paid probes must be resumable
- Do: structure as phases (submit, then followup `<jobId>`) and dry-run against fakes first.

## Icon semantics and Settings checkboxes
- Do: X means close, trashcan means delete. Reset checkboxes inside `.settings` (`flex: none; width: auto`) and scope label overrides as `.settings .my-label` (a guard test checks the reset exists).

## Editing files
- Do: use the Edit tool for all text changes. Encoding damage is caught by `lessons-guards.test.ts`.
- When editing files with near-identical sibling blocks (e.g. `NodeGraphModal.tsx`), include a component-unique anchor in the edit and grep the intended component afterwards.

## Audio, media and timeline UI
- Serve large media over the `cascade-media://` streaming protocol, not base64 over IPC.
- Use one decoded `AudioBuffer` for playback and waveforms; precompute peaks once.
- Attach `{ passive: false }` native wheel listeners when an element owns the wheel gesture.
- Compute seek positions from the interacted element's own rect; stop `pointerdown` propagation on inner draggables.
- Pool one media element per clip instead of swapping `src`; a decode failure must not overwrite a valid duration.
- Keep original filenames for imports; collision-handle instead of renaming.
- Drop per-shot fields when the data model moves to one production-wide resource.
- Model-driven pickers read their options per selected model at render time and re-validate on change.
- Keep prompt display and transport forms separate; remove generated sections paragraph-scoped; queue debounced prompt saves latest-value-first; cache per-shot prompt display and ignore null refresh results.
- Storyboard history derives from generation nodes; promotion updates the node's selected index and output pipe, not only `artwork`.

## A supersede-delete that only happens in memory never reaches the persistence sink
- Symptom: a storyboard 'pending' badge stuck on forever (0000_Co-Mo Santa
  Tests shot 0200) while jobs.json was empty and newer takes existed.
- Cause: `imageGenFn` deleted `shot.pendingImageGen` in memory at submit
  ("fresh submission supersedes"), but the persisted copy is owned by
  `pendingImageSink`, which was only told `null` when the SAME run had
  recorded a pending (`pendingRecorded`/`submitted` gate). A synchronous
  success (no `historyId`, so nothing recorded) never notified the sink.
- Rule: any in-memory delete of a sink-owned field needs a matching sink
  notification on EVERY exit that supersedes it — capture "there was a
  stale record at entry" and OR it into the clear-notify gate. Check all
  transports/kinds that share the pattern (found in image + video, MCP +
  both CLIs; fixed 2026-10-27 with sink-level regression tests).

- FFmpeg filters that buffer to EOF (`areverse`, `reverse` on audio,
  loudnorm analysis, etc.) must never sit downstream of an infinite
  lavfi source (`anullsrc`): a muted+reversed clip hung the render
  forever because the silent-track chain inherited `areverse`.
  Rule: whenever a filter chain is built conditionally, check each
  EOF-dependent filter against EVERY input source variant (real file
  vs lavfi silence). Found by the A14 torture fixture (2026-11-02);
  guard test in timeline-audio.test.ts.

- Windows PowerShell 5.1 reads BOM-less .ps1 scripts as cp1252: any
  non-ASCII literal (em dash, ≈, ×) inside surgery-script replacement
  text lands in the target file as mojibake. Rule: keep PowerShell
  line-surgery replacement text pure ASCII (or splice chunks written
  by the file tools). Caught by the lessons-guards encoding test
  during the old-animatic-strip removal (2026-11-03).

## "Connected" is a transport claim, not a discovery claim
- Happened: OpenArt MCP showed connected while every picker was empty — the host-side MCP result text was sliced at 50k, cutting the >50k model-list JSON mid-document so discovery parsed to zero (2026-11-10).
- Do: never cap machine-parsed host replies at conversational sizes; treat an empty catalog parse as a failure (retry + keep last good), and surface discovery state next to connection state so "connected but model-less" is visible where users look.
- Tell: server healthy, tools listed, but a downstream list is empty everywhere at once — probe the raw reply length before trusting the parser. Guard: `app/test/mcp-discovery.test.ts`.
