<!-- Active work only. Finished items (with a Review section and no open checkboxes) live in tasks/archive/todo-2026.md. -->

# Folder skills (Agent Skills format) in the skills loader (2026-11-25)

Why: Claude-format skills (SKILL.md + references/ + scripts) could not be used in
Cascade; this blocked the Topview 3D Builder evaluation (Feature #26) and the
Seedance previz skill. Plan approved 2026-11-25. Decisions (operator): live
checks on a throwaway profile copy; real skills folder changed last; delete the
`ux audit\` duplicate; convert production:film.

Plan:
- [x] Live harness `app/scripts/skills-live-check.mjs` (temp profile: settings.json +
      Local State + chosen skills dir; approvals auto-denied except a per-scenario
      allowlist; records tool calls + answer; deletes the profile).
- [x] Before-evidence (pre-change code): fixture copy of today's 11 skills + golden
      loadSkills/read_skill JSON. Live `film-before` attempted: the provider
      (cheaperinference) answered HTTP 402 insufficient balance.
- [x] Item 1: folder discovery, mini-YAML frontmatter (name/description + kind/
      namespace/triggers), label-based resolution (fixes `ux audit:ux-audit`),
      read_skill `file` (per-file 20k cap), folder-aware seeding + dedup. Tests.
- [x] Item 3: scripts listed by read_skill (run via run_command only, never on load);
      trust rule in _README.md (migrated when unedited), docs/skills.md, CONTEXT.md,
      Settings help copy. Tests incl. a skill script run through runCommandArgv.
- [x] Item 2: convert bundled production:film (tool table -> references/tools.md);
      inventory + decisions in docs/skills.md.
- [ ] Live: film-after, script-e2e, topview: SKIPPED by operator (provider out of
      balance; declined switching the test copy to Gab). Harness and scenario
      folders are ready to run.
- [x] Gates: app npm test, core check:fast + test, build, ui:verify (+ Settings shot).
- [x] Real folder last: back up film.md, convert it, delete `ux audit\`, install
      topview-3d-cli skill, migrate _README.md; loadSkills on the real folder.
- [x] progress.md entry; report.

## Review

- Flat skills unchanged: golden (pre-change loader output for a byte-exact copy
  of the real folder) passes after the change; the one intended difference
  (`ux audit:ux-audit` read the other folder's file) was red before, green after.
- Folder skills: 30 tests in `app/test/skills.test.ts` + 3 golden tests. The real
  Topview skill (13 files, 117k chars, blob-hash identical to upstream 631c08c)
  lists with its 1,004-char frontmatter description; read_skill returns SKILL.md
  + index only; every reference loads on demand; nothing is truncated.
- production:film conversion is lossless (pointer swapped back for the table ==
  original bytes, for both the bundled copy and the user's copy); listing
  identical, so triggering is identical.
- Not verified: live agent behavior (operator skipped). Item 4's missing
  capabilities are from reading code, not a live run: topview-3d-cli not
  installed; no In-App Browser for Studio; run_command has no shell (no
  `$env:` expansion, no stdin) and a 300 s ceiling.
- Gates: app 2672 passed / 1 failed (pre-existing `group` guard) / 15 skipped,
  tsc clean; core check:fast 0 errors, 205 passed; build clean; ui:verify exit 0
  (tasks/screenshots/2026-11-26T01-00-25-745Z, incl. settings-workspace.png and
  settings-data-folders.png).

# Moodboard image-node rotate/scale handles are gray dots in minimal icon mode

Root cause (verified): the node's other controls (`RefFigure` actions: zoom/
import/edit/remove, in-use badge) render through the shared `icons.tsx`
`Icon` (colorful `<img>` / minimal CSS-mask glyph). The rotate and resize
handles in `MoodboardNode.tsx` never used that system at all — they are empty
`<span>`s styled as 14px circles (`styles.css` `.moodboard-node-rotate/-resize`),
so there is no glyph in either set; in minimal mode, where every sibling
control became a line icon, they read as placeholder gray dots. Same shape as
the earlier node-shelf fix (camera-grid/upscale tiles bypassed the shared
`Icon`; fixed by giving them paired colorful+minimal assets and routing
through `Icon` — guarded by `graph-shelf.test.ts` "renders every tool tile
icon through the shared icon set").

Plan:
- [x] Red test first: `app/test/moodboard-node-icons.test.ts` — in minimal mode
      every node control (rotate, resize, zoom, remove) carries a masked
      glyph; frame resize too; pointerdown on handles still fires
      rotate/resize; colorful mode has no minimal glyphs and its handle
      artwork stays hidden (plain nub, as today).
- [x] Artwork: `assets/icons/{rotate,resize}.svg` + `assets/icons/minimal/{rotate,resize}.svg`
      (minimal: 24x24, `#000` stroke 1.8 round caps — circular arrow;
      diagonal expand corners). `RotateIcon`/`ResizeIcon` in `icons.tsx`;
      `icons.test.ts` counts 27 -> 29.
- [x] `MoodboardNode` + `MoodboardFrame` handles render the icons (size 9);
      CSS centers the glyph and hides only the colorful `<img>` glyph inside
      these handles, so non-minimal rendering is byte-for-byte today's nub.
- [x] Sweep: rest of node controls, moodboard frame/toolbar/shelf/minimap,
      and every other rotate/resize handle surface; fix same-shape gaps only.
- [x] Verify: focused tests, typecheck, full suite, build.

Sweep (2026-11-12): node controls besides the two handles all go through
`icons.tsx` (Magnify/Import/Edit/X/Nodes/FilmStrip) — clean. Moodboard frame
resize is the same empty-circle handle — fixed in this pass. Toolbar buttons
are text labels; shelf zoom uses MagnifyIcon; minimap has no icon controls;
note delete uses TrashIcon. Elsewhere: the only rotate handle in the app is
the moodboard node's; other resize surfaces are drag strips/edges
(graph-shelf, animatic, timeline, sidebar) or the graph frame's gradient
corner (`prod-frame-resize`) — none render through the icon set and none are
dots, so no change.

## Review

Fixed via the node-shelf approach: `RotateIcon`/`ResizeIcon` added to `icons.tsx` with paired colorful+minimal SVGs (29-icon set; minimal = 24x24 `#000` stroke-1.8 circular arrow / diagonal expand corners), rendered at size 9 inside the node rotate/resize handles and the frame resize handle (same empty-circle gap found in the sweep). CSS centers the glyph and suppresses only the colorful `<img>` inside these handles, so colorful rendering is exactly the prior plain nub; the minimal masked span shows. Gesture handlers untouched (glyph is `pointer-events:none`). Tests: `app/test/moodboard-node-icons.test.ts` (6; red 4/6 -> green 6/6: minimal glyphs on rotate/resize/frame-resize + zoom/remove, pointerdown still fires rotate/resize for r1, colorful has no minimal glyph + CSS suppression pinned), `icons.test.ts` counts 27->29. Gates: typecheck clean; focused 12/12; full vitest 2596 passed / 1 failed (sole pre-existing `group` CANVAS_TYPE_EQUAL lessons-guard, unrelated) / 15 skipped; `npm run build` clean. Sweep: all other node controls already route through `icons.tsx`; toolbar = text buttons, shelf zoom = MagnifyIcon, minimap = no icon controls, note delete = TrashIcon; the only rotate handle in the app is this node's; other resize surfaces are drag strips/edges, the graph frame's gradient corner, or React Flow NodeResizer chrome (not icon-set glyphs, unchanged). Live verification (2026-11-12, `tasks/screenshots/moodboard-icons-verify.mjs`, evidence in `tasks/screenshots/moodboard-icons/2026-11-12T00-30-53-082Z/`): built app on an isolated seeded profile, window moved off-display to -32000,0 immediately (Electron ignores `--headless` on Windows — verified `IsWindowVisible=True` — so the runs drove the offscreen window over CDP; a brief on-screen flash at each launch is inherent). 15/15 rows passed, screenshots read back: minimal board/node/frame/import crops show real glyphs on rotate/resize/frame-resize/zoom/remove/import (computed mask URLs, white tint, no empty buttons, no dots); real mouse drags rotated Hero to 44.84deg (29 intermediate transforms) and scaled it 260x210 -> 320.87x253.48 (25 intermediate widths), frame 560x290 -> 607.83x323.04, all persisted in the saved production JSON; rAF during drags 217 frames/1.31s and 195/1.18s (avg ~165/s offscreen-uncapped, p95/max frame delta 6.2ms, no stalls); zoom opened the lightbox (glyphed close), rename persisted, remove 5 -> 4 nodes, suite button opened Image Suite in Edit mode (the board has no AI-edit button by design — `MoodboardNode` passes no `onEditRef`), and the import click opened the real OS picker (window class `#32770`, title "Open", watcher-cancelled). Colorful relaunch: zero minimal glyphs on the board, handle glyph `<img>`s `display:none` (plain nubs, same circle bg/border/radius), zoom/remove full-color icons visible; no pageerrors in either run. Not committed.

---

# Paste image -> Save sometimes creates no reference (silent, intermittent)

Ask: paste visibly registers (save popup shows), clicking Save sometimes produces no reference and no error. Trace clipboard paste -> preview/confirm UI -> Save -> file write + reference record; check async race, silent swallow, state collision, clipboard variance; state relation to Bug #11 (paste not registering, fixed).

## Trace (verified by reading)

- Two paste entry points, one shared commit shape:
  - Design page (`ProductionWorkspace.tsx` paste listener, step 2) -> `createReferenceFromFile`.
  - Node-graph canvas (`NodeGraphModal.tsx` paste listener) -> `onPasteFiles` -> `addPastedReferences` -> `addFileReference` (same fn as graph file drops).
- Both: `promptReferenceSave` (`NamePromptDialog` `askReferenceSave`) runs FIRST. The Save click only resolves the name/category promise and dismisses the dialog. ALL real work happens after dismissal: `importableImageDataUrl` (FileReader read; >15MB also a convert popup + main downsample), `persistRefImage` (`production:addReferenceImage` IPC, main `writeFileSync` into `referencesDir`), then `saveField({references})` -> `void persistProduction(next).catch(() => {})` (whole-doc `production:save`, main `applyRendererState`).
- Bug #11 (test `image-paste-focus.test.ts`, Nov 5): the paste LISTENER bailed when focus sat in any text field, so the popup never appeared. Fixed via the `clipboardText` guard. This bug is downstream of that: listener fires, popup shows, post-Save commit dies. DISTINCT root cause; shared surface only.

## Findings (failure points, in the asked order)

1. Async race (structural): data materialization starts only AFTER Save, with the dialog already gone — no busy state, no readiness gate, nothing retaining the image. Slow reads/writes (large images) widen the window in which any failure below is invisible and unrecoverable (File handle dropped, user must re-paste).
2. Silent swallows: `if (!dataUrl) return null` in both paste fns (no error at all); `persistRefImage` `catch { return undefined }` (IPC reason discarded); `saveField`'s `persistProduction(...).catch(() => {})` (record-save failure = file on disk, no record, success assumed; never verified); graph paste `void (async ...)()` with no catch; panel drop's `.catch(() => {})` in `references.tsx`. The one error surface (`setErr` -> `ErrorNotice`) renders in page flow, UNDER the node-graph overlay (z-90 fixed) — invisible for canvas pastes. No logging anywhere on the path.
3. State collision: dialog submit has no busy/settled guard — a double submit resolves + `hostQueue.shift()`s twice, which can skip a queued paste dialog entirely (its promise never resolves = silent no-op). Rapid separate pastes run concurrent commit loops (only the dialogs serialize).
4. Clipboard variance: size is the lever — >15MB pastes (large screenshots/photos) take the late convert-popup + downsample path after the dialog closed; cancelling/escaping it returns null silently. Formats ride the same data-URL transport (main re-derives ext from MIME), so size, not format, drives intermittence.

## Plan

- [x] Red tests first: `app/test/paste-save-commit.test.ts` — slow image write + immediate Save (exactly one ref, dialog busy meanwhile); write failure -> visible in-dialog error + retained + retry succeeds (file written once); record-save failure -> same; double-submit -> exactly one; 20 consecutive paste->Save cycles incl. one >15MB -> 20 refs.
- [x] `image-downsample.ts`: split materialization so the paste path can start it at paste time (oversize convert consent is asked up front from `file.size`, then read+downsample runs in flight).
- [x] `NamePromptDialog.tsx`: optional async `onConfirm` for the reference-save variant — dialog stays open with a busy Save while it runs, an error string keeps it open with an inline error for retry; busy blocks cancel/backdrop/Escape/double-submit; settle-once guard for every variant.
- [x] `ProductionWorkspace.tsx`: paste commits (`createReferenceFromFile`, `addFileReference`) run inside `onConfirm`: await materialized data, write file (memoized across retries), await `persistProduction` and VERIFY the saved document contains the new record id (+ returned file path) before success; one pre-minted id per paste (retry/double-click idempotent); `console.error` with reason on every failure (renderer console is mirrored to `main.log`); `persistRefImage` logs its swallowed reason.
- [x] `NodeGraphModal.tsx`: paste async loop gets a catch + log.
- [x] Verify: focused tests green, full app suite, typecheck, build.

## Review

Root cause (distinct from Bug #11): Save committed nothing — it only resolved the name promise; the read/downsample/write/record-save all ran after dismissal, fire-and-forget, with silent-null returns, a reason-swallowing `persistRefImage`, and `saveField`'s `.catch(() => {})` on the record save. Any slow or failing step (large images widen the window; a double-submit could also shift the dialog queue past a queued paste) produced no reference, no visible error (the `ErrorNotice` sits under the canvas overlay), no log, and no retry. Red evidence: the new tests on the old code failed 5/6 (dialog not retained under slow read/write, no error on write/record failure, double-submit -> ZERO references) while the 20-cycle happy path passed — matching the intermittent field report.

Fix shipped: image/media data materializes at paste/drop time (`beginImportableImageDataUrl`, oversize consent up front); the commit runs inside the save dialog (`onConfirm`: busy "Saving…" Save, dismissal blocked, inline error + retained image on failure, settle-once against double-submit); the record save is awaited and verified against the document main persisted, with optimistic rollback on failure (`commitReferenceRecord`); one pre-minted id + memoized file write per paste make retries/double-clicks produce exactly one reference; every failure logs `[paste-reference]`/`[reference-import]`/`[reference-image]` + reason via `console.error` (mirrored to `main.log`). Graph-canvas paste (`addFileReference` via `addPastedReferences`) and Design-page paste (`createReferenceFromFile`) share the fixed shape; graph drops ride the same fn.

Tests: `app/test/paste-save-commit.test.ts` (6, red 5/6 -> green 6/6): slow write + immediate Save, slow read + immediate Save, write failure -> error/retain/retry + log assertion, record-save failure -> retry reuses the one written file, double-submit -> one ref/one write, 20 consecutive cycles incl. one >15MB (downsampled) -> Ref_001..Ref_020. Gates: `npm run typecheck` clean; focused paste files 14/14; full `npm test` 2590 passed / 1 failed (sole pre-existing `group` CANVAS_TYPE_EQUAL lessons-guard, unrelated, documented failing before this work) / 15 skipped; `npm run build` clean. Mocks sit at the same `window.cascade` seam as the existing paste tests (main's synchronous file write unchanged); no live-Electron paste run was made. Not committed.

---

# OpenArt provider forwards node generation parameters (Seedream background et al.)

Ask: OpenArt MCP generate path dropped the node's params (live-verified: Seedream 5.5 `background: transparent` works via direct MCP, no effect in Cascade). Forward generally per the model's live form, record what was sent (job ledger), check image EDIT too.

- Findings: `OpenArtClient.imageGenFn` named its 4th arg `_params` and never read it (nor `Production.openArt.params`); `imageGenArgs` built params from prompt/aspect/resolution/count/refs only. Every image call site in `index.ts` already passed params (frame node, edit node, classic edit, suite, references, character sheet, style frame) and the storyboard batch passes none (relies on the provider's production-config fallback, the Higgsfield contract). Image EDIT is the same `imageGenFn` in image2image mode (form fetched per mode), so it dropped params identically. Video had the same drop: `videoGenArgs` never read `VideoGenOptions.params` (it was only copied raw onto the pending record). `PendingImageGen.params` was never set by this provider; `LedgerGenMeta`/`LedgerEntry` had no params field at all.
- Fix: new exported `declaredParamsAssign` in `openart.ts` - subset of node values the live form declares, re-keyed to form property names (folded alias match), enum/oneOf-validated (unlisted dropped), type-coerced (bool false preserved, int clamped), media/frame/prompt fields and dedicated-assigner keys skipped; no form = forward nothing. `imageGenArgs`/`videoGenArgs` merge it and return `{ args, sentParams }`; `imageGenFn` uses `genParams ?? cfgUsed.params`. Records show the sent subset: `LedgerGenMeta.params` -> `LedgerEntry.params` (`ledger.ts` recordGeneration/normalize/entryMeta, sanitized, pricing untouched, CSV unchanged), `PendingImageGen.params` at all three record sites, `PendingVideoGen.params` now sent-subset instead of raw, and the four recheck billing sites in `index.ts` pass `pending.params` into the reclaim's ledger row. Dedicated controls stay authoritative (params cannot hijack prompt/aspect/resolution/duration/refs).
- Tests (red first: 5 failed / 112 passed; tsc flagged missing `params` fields): `openart.test.ts` +5 - background/seed/alias forwarding + undeclared dropped + pending & recorder carry sent subset; unlisted enum dropped + production-config fallback; image EDIT (image2image) forwarding; video forwarding incl. boolean false. `ledger.test.ts` +1 - params recorded, absent when none, survives disk round-trip. Plain generation pinned unchanged by the pre-existing exact recorder/params tests.
- Verification: `npm run typecheck` clean; focused openart+ledger 117/117; full `npm test` 2580 passed / 1 failed (sole pre-existing `group` lessons-guard - re-verified failing with this change stashed) / 15 skipped; `npm run build` clean. Not committed.
- Live check (2026-11-11, `tasks/openart-live/2026-11-11T22-27-17-506Z/`): built app on the real profile over CDP; provider temporarily switched `higgsfield-cli` -> `openart` and restored after. Pre-spend probe in the running app: catalog listed Seedream 5.5 as `byte-plus-seedream-5-5`, its live form declared `background` enum `[auto, transparent, opaque]`, credits 16. One suite generation (model `byte-plus-seedream-5-5`, 1k, 1:1, neutral red-sphere prompt with no transparency wording, `params: { background: "transparent" }`) through `suite:generate` -> `imageGenFn` completed; credits 16 -> 4 (12 spent, exactly one submission). The expense-ledger row for the job records `params: { background: "transparent" }` (the sent subset derived from the built request; the fake-server tests pin the literal nested `{ mode, params: { ..., background: "transparent" } }` tool arguments). Downloaded file `out/suite/Suite (46).png` in production `4521_IMMI Rolltek` (evidence copy `generated.png`, sha256 `e9d8ee31...a069`, hashes identical) decoded from disk in a separate process: PNG 1024x1024 color type 6 (RGBA), 61.6% fully transparent pixels, all four corners alpha 0, center alpha 255 - a real alpha channel. Media provider setting verified back on `higgsfield-cli`; no Electron left running.
- Flagged, out of scope: the OpenArt **CLI** transport (`openart-cli.ts`) also ignores `_params`, but that binary surface has no known per-model param flags (it cannot even take aspect/resolution), so forwarding there needs a live CLI probe of accepted flags first. "Job ledger" read as the job's recorded params (pending receipt + expense ledger entry) - `JobRecord.settings` already snapshots raw IPC args at begin and was left as-is.

# App-wide undo/redo for all document editing (+ Feature #12 scene delete, unblocked)

Ask: one consistent undo system (Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y) at the document layer covering prompt/script edits, scene ops, storyboard ops, node graph edits, and deletions — bounded, and proven not buggy (Items 1-5). Out of batch-state (same as the scene rename below).

- Design: MAIN-side snapshot history per production (`app/src/main/production-history.ts`), fed by the one write funnel — a hook on `productions.saveProduction` (61 call sites: every renderer save, narrow command, structural command, agent op, and rebased generation commit persists through it, so nothing can bypass history without bypassing persistence). Pure core in `app/src/shared/production-history.ts`: `reconcileShare` (structural sharing across snapshots; retained memory is O(changed path), frozen snapshots), `projectForHistory` (the Item 4 boundary: rev/status/currentStep/media registry/pending vendor receipts/assembly run bookkeeping/graph+moodboard viewports never enter or rewind), `mergeRestoredProduction`, `createDocumentHistory` (~100-step cap, gesture coalescing by key). Session-scoped v1.
- Restore: snapshot + live excluded fields, board-folder reconciliation with the forward machinery (`deleteShotBoards` archive, `moveShotMediaDir` un-archive, `relocateBoardsForRenumber`, outdated park/un-park), trashed media rehydrated, script.md rewritten, suppressed write. Deletions made recoverable: `removeOutdatedShot` parks under `boards/outdated-removed/` instead of `rmSync`; take/reference/video/style-frame deletions go to `boards/undo-trash/` with original-path sidecars; both purged at session start per production (deferred deletion, chosen over immediate destroy — say-which per Item 3). Generation completions are their own entries; undo unregisters only — files, credits, job ledger untouched.
- Coverage: prompt edits (live saves coalesce `prompt:<shotId>`, blur/frame-switch closes — one step per committed edit, Bug #18 boundary; paste = one save = one step); script/visual/audio blur commits; scene rename + NEW scene delete (`shotter.deleteScene`, `production:deleteScene`, ShotTable trash button with always-confirm naming scene + shot count); storyboard ops incl. atomic reorder = one `mutateShots` transaction = one step; node graph add/delete/move/connect/disconnect/frames/layout via meta-carrying narrow commands (local stacks retired; `captureHistory(force)` now marks discrete steps); timeline commits (volume drags coalesce `tlvol:<track>`); shot/scene/node deletions; moodboard + tile-size gestures coalesce.
- Audit (Item 3): routed — every `saveProduction` writer (renderer `production:save` rebase + all narrow/structural/generation/agent commands). Left out deliberately: app Settings (separate store), suite session file (separate document; its exports into references DO save + record), expenses ledger entries (ledger store; `productionExpenses` doc field IS covered), in-field text undo (document step lands on blur commit), view state (selection/viewport/playhead — clamped, never restored), three generation-REPLACEMENT unlinks whose bytes are not recoverable (style-frame recheck, camera-grid sheet replace ×2 — registration restores, frame regenerable), external JSON edits / schema migration (history resets on rev mismatch instead of stacking an uncertain lineage).
- Verification: red-first `app/test/production-history.test.ts` (20: reconcile sharing identity, projection boundary, round-trips per area incl. scene rename/delete + wire disconnect + generation landing, mixed-sequence undo-all == exact start / redo-all == exact final, coalescing, structural-sharing retained-object bound on 300 shots, cap), `app/test/production-undo-restore.test.ts` (8: real funnel + folders on disk — delete/reorder/scene-delete archive+return, generation file + ledger untouched, take trash, outdated park), `app/test/production-undo-wiring.test.ts` (7 guards), timeline delegation harness updated. Gates: tsc clean; full vitest 2570 passed / 1 failed (sole pre-existing `group` guard, present before this work) / 15 skipped after theme-token fix; core check:fast exit 0 (warnings only); build clean; ui:verify exit 0 (tasks/screenshots/2026-11-11T13-57-16-087Z) + live CDP probe (create → addScene/rename recorded depth 2 → Ctrl+Z un-renames → header Redo replays → deleteScene → Ctrl+Z restores; screenshot read: Undo/Redo header buttons, scene trash icon, activity line). Retired `production/undo-history.ts` + its test deleted.
- Flagged judgment calls (unchanged, for Chuck): (1) snapshot+structural-sharing over inverse commands; (2) session-only history v1; (3) generation completions undoable as document entries, files/credits/ledger never; (4) ~100-step cap.
- Blocked: fresh-eyes reviewer needs `GAB_API_KEY` (absent). Exact command when set: PowerShell `cd app; node scripts/review.mjs --model impl,kimi,deepseek,minimax "Review the app-wide undo/redo build (document-layer history in main, save-funnel hook, board-folder restore, retired per-view stacks, Feature #12 scene delete) for correctness bugs: snapshot corruption, lost-update or rev-lineage holes, folder-restore conflicts, coalescing errors, and scope creep."`
- Next: none. Known cosmetic: retired local-stack code sits in labelled comment blocks in NodeGraphModal/timeline-editor (CRLF-safe migration); delete on next touch of those regions.

# Scene rename in the script view (scene delete shipped with app-wide undo above)

Ask: add scene rename + scene delete to the script view (Step 1 `ShotTable`).
Two flagged decisions with safe defaults: confirm before delete; delete only
if undoable through the script editor's existing undo.

## Findings (verified)

- Script view = Step 1 panel rendering `ShotTable`; one `SceneBlock` per
  `ProductionScene { number, title, shots }` (no stable scene id - every
  structural API addresses scenes by ordinal). `scene.title` is single-sourced:
  script.md (`scriptMarkdown`), magic-prompt context, and the production-tools
  digest all read it, so a rename through `mutateShots` (load -> mutate ->
  rewrite script.md -> `saveProduction`) shows everywhere and persists.
- Bug #18 panel-commit fix (pinned by `shot-table.test.ts` /
  `board-script-switch.test.ts`): commit on the field's own blur so a direct
  switch into another panel commits the field being left, and resync incoming
  saves per-field via the `lastSaved` mirror - never gate on focus, which
  wiped the leaving field's draft in the focus gap.
- **The script editor has no undo.** `createUndoHistory` is used only by the
  node graph (per-shot graph snapshots) and the timeline editor; shot delete
  in `ShotTable`/`boards.tsx` is explicitly "can't be undone", and
  `saveProduction` keeps no backup/history. Chat undo covers agent file turns,
  not UI structural edits.

## Decisions

- Confirmation: **confirm** (safe default) - designed as `confirmDestructive`
  naming the scene and its shot count. Not shipped because delete is stopped.
- Undo: **delete half was STOPPED** per the ask - no existing script-editor undo (RESOLVED by the app-wide undo build at the top of this file: scene delete now ships with the confirm above, one Ctrl+Z step, recoverable board folders),
  so no un-undoable destructive scene delete ships. Rename ships alone.
  Unblocking delete needs a production structural undo (or a soft-delete /
  restore path covering boards folders + shot sequences) first.

## Plan (rename)

- [x] Failing tests first: `shotter.renameScene`, IPC schema + contract,
      `ShotTable` direct-switch commit (blur straight into a shot cell),
      Enter/Escape/blank, Bug #18 draft-survives-snapshot.
- [x] `shotter.ts`: `renameScene` (trim; missing scene / empty title throw).
- [x] IPC: `production:renameScene` channel + `CascadeApi.renameScene` +
      schema validator + main handler via `mutateShots`.
- [x] `ShotTable.tsx`: pencil button in the scene header opens an inline
      title input; commit on the input's own blur (Enter blurs into the same
      path, Escape cancels); `lastSaved`-mirror resync; draft ref so the
      commit always reads the freshest text.
- [x] Verify: focused tests, `npm run typecheck`, full app suite, build.

## Review

Rename shipped; delete stopped (see Decisions). The header pencil in each
`SceneBlock` swaps the toggle for an inline input (autofocused, title
selected); Enter blurs into the one commit path, Escape resets the draft ref
before unmount so an unmount blur can't commit a cancel, and a blank or
unchanged (post-trim) title reverts without an IPC call. Main side is the
thin `mutateShots` + `shotter.renameScene` pairing every structural edit
uses, so the rename bumps `rev`, rewrites script.md, and persists via
`saveProduction` in the same step.

Tests (16 new): `shotter.test.ts` renameScene (4), `ipc-validation.test.ts`
payload + contract (1), `shot-table.test.ts` scene rename (10, incl. the
direct-switch panel-commit and diverged-draft-survives-snapshot pins),
`productions.test.ts` save/reopen + script.md heading round-trip (1). Red
first: 15 failed / 55 passed; after: focused 70/70. Verify: `npm run
typecheck` clean; full app suite 2528 passed / 1 failed (the pre-existing
`group` lessons-guard, failing before this change per tasks/progress.md) /
15 skipped; `npm run build` clean. Not committed.

---

# Harness competitiveness: automated verification + optional OS sandbox

Audit findings (`Cascade-Harness-Implementation-Plan.md`, 2026-10-10): Cascade is
strong on deterministic tools, context management, and process safety, but was
missing an **automatic verification feedback loop** — the agent had to *choose*
to run checks, and there was no post-edit run-checks-feed-failures-back step.
Secondary gap: no OS-level sandbox option.

## Plan

### Workstream A — automated verification feedback (primary)
- [x] A1 `core/src/verify.ts`: `VerifyCommand`/`VerifyResult`/`VerificationConfig`;
      `runVerifyCommand` (argv-only, `shell:false`, `resolveSafe` cwd, timeout
      kill-tree, spill oversized output), `runVerification` (sequential, optional
      stop-early), `detectVerifyCommands` (check:fast/typecheck/lint/test + tsc /
      python fallbacks, package-manager aware), `formatVerificationFeedback`.
- [x] A2 `core/src/types.ts`: optional `AgentConfig.verification` +
      `resolveVerification`/`verificationRunner` seams, `verificationCommands`
      feed-forward; `AgentEvent` verification-start/-result/repair-round/
      verification-exhausted.
- [x] A3 `core/src/agent.ts`: `dirty` set only on a successful `requiresApproval`
      tool; run checks after the batch; bounded repair rounds; no verification in
      pure chat, terminal iteration, or when the plan gate blocked the mutation.
      Unset config ⇒ byte-identical event stream.
- [x] A4 `core/src/index.ts`: export the verify + sandbox surface.
- [x] A5 host wiring: `verify-consent.ts` (`makeVerificationResolver`, injected
      store + consent prompt), `settings.verifyCommandsByWorkspace`,
      `SessionFile.verifyCommands`/`verifyDeclined`, IPC `verification:request`/
      `:response` + preload `onVerificationRequest`, renderer `VerifyApprovalModal`
      + collapsible **Checks** block, `AgentEventIpc` mirror.
- [x] A6 `core/src/cli.ts`: `--verify` flag (detect + run) and event handling.
- [x] A7 tests: `core/test/verify.test.ts`, `core/test/agent-verification.test.ts`,
      `app/test/verification-wiring.test.ts`.

### Workstream B — optional OS sandbox (secondary, default off)
- [x] B `core/src/sandbox.ts`: `applySandbox` (srt/docker argv wrapping),
      `sandboxAvailable`, `sandboxFallbackNotice`; `AgentConfig.sandbox`; Agent
      wraps `run_command` (`makeSandboxedRunCommand`) and verification uses the
      mode; Settings → Advanced → Agent selector (default None); `core/test/sandbox.test.ts`.

### Workstream C — polish
- [x] Feed-forward: configured check names surfaced in the system prompt
      (`verificationPrompt`), `prompts.test.ts` case.
- [x] Verification gets its own 120s timeout vs `run_command`'s 60s.
- [ ] (deferred) on-demand `verify` tool; per-model compaction budget.

## Review

Implemented. The gap was a missing **feedback sensor**: `run_command` existed but
nothing ran the project's checks automatically. Workstream A adds a deep
`core/src/verify.ts` module — argv-only, `shell:false`, workspace-contained,
spill-backed — and wires it into the loop behind an **opt-in** config so the
default event stream is unchanged. A successful mutation sets `dirty`; the loop
then runs the checks once, emits `verification-start`/`-result`, and on failure
feeds a compact summary back for `maxRepairRounds` (default 2) before
`verification-exhausted`. The host's `makeVerificationResolver` gets consent once
(per workspace or per chat, or declines silently when nothing is detected), so
auto-run is never unapproved. The repair loop never touches tests.

Workstream B adds `core/src/sandbox.ts` (srt/docker argv wrapping, default
`"none"`), surfaced honestly: an unavailable backend returns the unchanged argv
plus a notice instead of pretending to isolate. The Agent swaps `run_command` for
a wrapped variant and threads the mode into verification; a Settings selector
(default None) enables it.

Workstream C feeds the configured check names into the system prompt so the model
knows they exist.

Verify: core typecheck clean, 192 tests (was 157); app typecheck clean, 1472
tests + 1 skipped (was 1469/1); `npm run build` clean. New: `verify.test.ts`
(16), `agent-verification.test.ts` (7), `sandbox.test.ts`, `verification-wiring.test.ts`
(8). No existing behavior changed with `verification`/`sandbox` unset.

---

# Long agentic tasks: autonomous mode, sticky approvals, todo discipline, higher cap

User report (three linked issues from one long video-production run):
1. Approval friction — had to approve OpenArt tool calls repeatedly; "always
   allow this session" didn't stick; want an **autonomous mode** that omits
   permission checks.
2. Todo tracking drifted — the model finished the task but only marked half the
   steps done.
3. The agent stopped after 50 iterations (too small for long tasks).

## Findings (verified)

- **Approvals** (`core/src/agent.ts:255`): grants (`sessionAllowed` /
  `sessionAllowedGroups`) live only on the in-memory `Agent`; they are lost on
  every rebuild (follower-chat rebind on a production switch, `resetAllAgents`,
  plan-mode toggle). All MCP tools incl. OpenArt are `requiresApproval: true`
  (`app/src/main/mcp.ts:275`). No autonomous mode exists.
- **Todos**: `core/src/todo.ts` + `app/src/main/session-tasks.ts` provide the
  list, but `core/src/prompts.ts` never tells the model to *use* it, and
  `todo_write` is full-replace, so statuses drift.
- **Cap**: `core/src/agent.ts:18` `DEFAULT_MAX_ITERATIONS = 50`; the app never
  overrides it. Each iteration is one model turn (which can batch many calls).

## Decisions (user-confirmed)

- Autonomous mode: **per-chat toggle + global default for new chats**.
- **Make session approval grants persistent** on the session file.
- Iteration cap: **raise default to 250 + make it configurable** in Settings.
- Todo: **system-prompt directive + better tool docs** (no new incremental tool).
- Autonomous and plan mode are **mutually exclusive** (turning one on turns the
  other off); the plan gate still wins in code if both are ever set.

## Plan

### Phase 1 — core agent (`core/src/`)
- [ ] `types.ts`: `AgentConfig` += `autonomousMode?`, `initialAllowedTools?`,
      `initialAllowedGroups?`, `onApprovalGrant?`.
- [ ] `agent.ts`: `DEFAULT_MAX_ITERATIONS = 250`; seed `sessionAllowed` /
      `sessionAllowedGroups` from config; skip the approval prompt when
      `autonomousMode`; report grants via `onApprovalGrant`.
- [ ] `prompts.ts`: refactor `systemPrompt` to an options object; add
      `autonomousPrompt()` and a todo-discipline directive (only when todo tools
      are present); thread from `Agent`.
- [ ] `todo.ts`: tighten the `todo_write` description (mark items done
      immediately; one `running` at a time).

### Phase 2 — app persistence + wiring (`app/src/main/`)
- [ ] `sessions.ts`: `SessionFile` += `autonomousMode`, `allowedTools`,
      `allowedToolGroups`; back-fill + defaults; `newSessionFile` takes the
      autonomous default.
- [ ] `settings.ts`: `autonomousByDefault` + `maxIterations` getters/setters
      (defaults `false` / `250`).
- [ ] `ipc-channels/chat.ts` + `workspace.ts` + `ipc.ts` (`CascadeApi`) +
      `ipc-schemas.ts`: `chat:set/getAutonomousMode`,
      `settings:get/setMaxIterations`, `settings:get/setAutonomousByDefault`.
- [ ] `index.ts`: `ensureAgent` passes autonomous flag, cap, seeded grants, and
      the grant-persist callback; handlers for the new channels; new-session
      call sites pass the default; mutual exclusion in the two mode handlers.
- [ ] `session-tasks.ts`: mirror the tightened `todo_write` description.

### Phase 3 — renderer (`app/src/renderer/src/`)
- [ ] `App.tsx`: `autonomousMode` state, read on session focus, composer chip,
      mutual exclusion with plan mode.
- [ ] `shared/commands.ts`: `/autonomous on|off` (alias `/auto`).
- [ ] New `settings/sections/AgentSection.tsx` (Advanced): autonomous-by-default
      toggle + max-iterations input; register in `registry.tsx`.

### Phase 4 — tests + verify
- [ ] core: `prompts.test.ts` (autonomous + todo directives; options object),
      `multimodal.test.ts` call updates; a sessions/todo unit test for the new
      fields/descriptions.
- [ ] app: `commands.test.ts` for `/autonomous`.
- [ ] `npm run typecheck`, `npm test` (app), `npm run build`; `npm test` (core).
- [ ] `CONTEXT.md`: autonomous mode + configurable cap + sticky grants.

## Review

Done. Three fixes, sharing one theme: the agent loop's long-task affordances
were hard-coded for short runs.

**1. Approvals / autonomous mode.** `core/src/agent.ts` now skips the approval
prompt entirely when `AgentConfig.autonomousMode` is set (plan gate still runs
first — it's structural, not a permission), and every tool still emits its
events + journals file mutations for undo. Session grants
(`initialAllowedTools`/`initialAllowedGroups`) are seeded from the chat file on
rebuild and new grants are reported back via `onApprovalGrant` and persisted —
so "always allow openart this session" survives a production rebind instead of
being re-asked. Exposed as a per-chat composer chip + `/autonomous on|off`
(alias `/auto`), persisted on the session, with a Settings → Advanced → Agent
default for new chats. Autonomous and plan mode are mutually exclusive in both
the UI and the handlers. `systemPrompt` was refactored to an options object and
gained the autonomous directive (which also drops the "ask for approval"
guideline).

**2. Todo tracking.** The tools existed but nothing told the model to use them.
Added a task-list directive to the system prompt (only when `todo_write` is
present): lay out the plan first, keep exactly one item `running`, and mark each
item `done` the moment it succeeds before starting the next. Tightened the
`todo_write` tool description (core + session variants) to match.

**3. Turn cap.** `DEFAULT_MAX_ITERATIONS` 50 → 250, plus
`settings.maxIterations` (clamped 10–2000, default 250) threaded through
`ensureAgent`; the stop message now points at the setting and suggests
"continue". Editable in Settings → Advanced → Agent.

Tests: core `agent-approval.test.ts` (6: default gate, autonomous skip, seeded
tool + group grants, allow-session + allow-group-session reporting);
`prompts.test.ts` autonomous/todo/options; `multimodal.test.ts` call updates.
App: `commands.test.ts` `/autonomous`; `session-workspace.test.ts` autonomous
default + grant normalization round-trip. Verify: core typecheck + 157 tests;
app typecheck + 1385 tests (1 skipped) + `npm run build` all clean. `CONTEXT.md`
updated (agent core, plan mode, harness).

---

# Prompt text editing polish (caret/focus/backspace) — across all surfaces

User report: regression of an old bug. Editing prompts in the node view is very
buggy — focus is lost while typing, the caret jumps to the end. The side-panel
prompt is buggy too: deleting a space before a reference block deletes the whole
block. Request: review and polish ALL text editing so it feels like a word
editor, while keeping `@` reference + block functionality.

## Root causes (verified)

- The Content box is a `contentEditable` (`PromptContentEditor.tsx`) that renders
  `@[Name]` as atomic `contenteditable=false` chips. External value changes call
  `buildDom` (full DOM rebuild); when no selection lives in the box the caret
  defaults to `text.length` (`PromptContentEditor.tsx:348`) → "jump to end".
- `isPromptTextarea` (`ProductionWorkspace.tsx:76`) only accepts `TEXTAREA` and
  the now-dead `prod-board-prompt`/`prod-prompt-drawer-text` classes, so it
  doesn't recognize the contenteditable Content box → the `getBoardPrompt`
  refetch guard (`ProductionWorkspace.tsx:803`) doesn't protect in-flight typing.
- `ReferencePromptEditor` deliberately does NOT pass `deferExternalWhileFocused`
  to `TriplePrompt` (prompt-panel.tsx:85) because `choose()` (autocomplete) writes
  a composed value from outside; so external saves re-decompose while focused.
- No Backspace/Delete handler exists in `PromptContentEditor` → the browser
  deletes the whole atomic chip at the boundary (the reported bug).
- Duplicated draft/emitted/defer logic in `ComposerNodeView`
  (`NodeGraphModal.tsx:644`) and `PromptNodeView` (`:1505`).
- Native undo is destroyed by programmatic `textContent` rebuilds.
- `SequenceSegmentList` textarea uses `value={seg.prompt || seg.framePrompt}`
  (`NodeGraphModal.tsx:1687`) → can't be cleared; no draft guard.

## Plan

### Phase 1 — Content box behaves like a real editor
- [ ] `PromptContentEditor.tsx`: handle collapsed Backspace/Delete against the
      plain-text model — a reference is one unit; deleting an adjacent space/char
      deletes only that char, deleting into a reference deletes the whole chip.
- [ ] `PromptContentEditor.tsx`: never rebuild while focused except tag-only
      diffs; if a rebuild is unavoidable, map the caret (never default to end).
- [ ] `PromptContentEditor.tsx`: undo/redo (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y):
      snapshot stack with typing coalesced; boundaries on paste/delete/insert/drag.
- [ ] `PromptContentHandle`: add an internal `insertRefTag`/`replaceRange` so the
      side panel's `choose()` edits inside the editor (stays in `emitted`).
- [ ] `prompt-panel.tsx`: pass `deferExternalWhileFocused` + route `choose()`
      through the new handle method.
- [ ] `ProductionWorkspace.tsx`: `isPromptTextarea` → recognize the content
      editor + any prompt field (closest `.prompt-content-editor` / `.prod-prompt-box`).

### Phase 2 — one shared editing foundation
- [ ] Extract the duplicated draft/emitted/defer logic from `ComposerNodeView` +
      `PromptNodeView` into one shared hook/component used by every node prompt.
- [ ] Shared `PromptTextarea` wrapper (defer-while-focused) used by Style/Brand
      and the other plain prompt textareas.

### Phase 3 — remaining rough edges
- [ ] `SequenceSegmentList`: allow clearing (`??` not `||`), protect typing.
- [ ] Style/Brand boxes: no caret jump on external refresh.
- [ ] Audit: character description, video modal, edit modal, Image Suite, tween
      action prompt, prompt templates, moodboard notes — apply shared wrapper.

### Phase 4 — tests + verify
- [ ] Tests: backspace beside a chip keeps it; deleting the chip works; caret
      stays in side panel + node view; undo/redo; autocomplete inserts; sequence
      box clears.
- [ ] `npm run typecheck`, `npm test`, `npm run build`.

## Review

Done. The reported regressions had one root: the Content box is a
`contentEditable` whose `@[Name]` chips are atomic to the browser, and external
prompt refreshes rebuilt its DOM (defaulting the caret to the end) while the
workspace's "is the user typing?" guard didn't even recognize it.

What shipped:
- `PromptContentEditor.tsx`: a collapsed/seleced Backspace/Delete handler that
  edits the PLAIN TEXT model — a reference is one unit, so deleting the space
  beside it deletes only that character while deleting INTO it removes the whole
  chip (`tagBeforeCaret`/`tagAtCaret`). Own undo/redo (Ctrl+Z / Ctrl+Shift+Z /
  Ctrl+Y) with a snapshot stack that coalesces a typing run (700ms boundary;
  breaks on newline/paste/delete/drag/ref-insert), since programmatic rebuilds
  destroy the browser's history. The rebuild effect now defers whenever the box
  (or a chip) actually holds focus, for every surface, and starts a fresh undo
  history only on a genuine external rewrite. New handle method `insertRefTag`.
- `prompt-panel.tsx`: `ReferencePromptEditor` now passes
  `deferExternalWhileFocused` (the missing piece behind the side-panel caret
  jump), and the `@` autocomplete inserts THROUGH the editor (`insertRefTag`)
  instead of writing a composed value from outside — which is what made deferral
  safe.
- `ProductionWorkspace.tsx`: `isPromptTextarea` now recognizes the content
  editor / prompt fields via `closest`, so an async `getBoardPrompt` refetch can
  no longer clobber in-flight typing (cursor jump / focus loss).
- `NodeGraphModal.tsx`: the composer and every prompt node's duplicated
  draft/echo/deferral plumbing is now one `usePromptNodeDraft` hook (composer
  publishes every edit, prompt nodes only tag reorders), and the sequence row's
  prompt box got the same focused-draft treatment (it can be emptied mid-edit
  and no longer snaps back when a frame prompt arrives).
- Style/Brand and every other `ReferencePromptEditor` surface inherit the
  protection through `TriplePrompt`'s defer merge — no new wrapper was needed.

Tests: `prompt-content-editor.test.ts` (5) pins backspace-beside-chip keeps the
reference, backspace-into-chip removes it, forward delete, undo/redo, and
`insertRefTag`. Verify: `npm run typecheck` clean; `npm test` (app) 1284 passed
+ 1 skipped; `npm run build` clean; `npm test` (core) 147 passed.

Not changed: the sequence segment's "empty override = use the frame prompt"
storage semantics (still reverts on blur, by design).

### Follow-up (user feedback): caret active right after an added block
- The side-panel @ autocomplete already left the caret after the block (pinned by
  `prompt-autocomplete-caret.test.ts`); hardened its deferred blur cleanup to
  mirror the LIVE value so a stale closure can't strip the just-inserted block.
- The real gap was the node graph: connecting a reference socket adds `@[Name]`
  from outside the editor and didn't position the caret. Added
  `PromptContentHandle.focusAfterTag(name)`; `usePromptNodeDraft`'s applier now
  detects a newly added tag (diffing `refTagNames`) and focuses the box with the
  caret right after it. Pinned end-to-end in `graph-shelf.test.ts` (socket
  connect → caret at end of the new block) + a unit test in
  `prompt-content-editor.test.ts`. Verify: typecheck clean, 1288 app + 147 core
  pass, build clean.

### Follow-up 2: composer caret — commit on blur ("edit mode")
The composer still published EVERY keystroke to `focusedPrompt`, so each
character fired a save → `updateBoardPrompt` → `applySnapshot` (prod change) →
`focusedSig` change → `getBoardPrompt` refetch + full-workspace re-render. Even
with the refetch guard, that churn let the caret jump to the end. Per the user:
the node can be in edit mode and commit on click-off. `ComposerNodeView` now
uses `usePromptNodeDraft(data, false)` — same as every prompt node: local draft,
commit on blur/close, tag reorders the only live publish. The side panel catches
up when the user clicks off the node. The `graph-focus` rapid-typing test now
asserts the caret STAYS after each character; the former "publishes live" test
became "commits on blur" (side panel intentionally not updated mid-edit).
Verify: typecheck clean, 1288 app pass, build clean.

---

# Shot sequence canvas: dedicated Sequence node + timed multi-shot prompt

User is rethinking the sequence canvas. The generic video-generation node is
replaced by a dedicated **Sequence** node whose prompt node is a timeline:

1. Style socket/box at the top (unchanged — shows the wired style prompt).
2. A **Visuals** panel below it: reference sockets + a shared description of
   the visuals for the whole sequence.
3. One panel **per member shot**: its frame piped in, a seconds-range dial
   (`0-1`, and the next shot auto-starts at the previous end), and a per-shot
   prompt auto-populated from the frame's storyboard prompt, editable, with a
   **Revert** button back to the frame prompt.

Confirmed decisions: **one** Sequence node per sequence (replaces the generic
video node); every member frame uploaded as an **ordered reference**; only each
segment's **end** is editable (start = previous end; first = 0; 1s steps);
each segment prompt seeds from the shot's **effective** prompt (Magic when
Magic is on, else the frame prompt) and Revert re-pulls it.

## Findings / scope

- The sequence canvas IS the node graph (`sequence-graph.tsx` hosts
  `NodeGraphModal` on `seq.graph`, a `ProductionShot`). Today it is
  pre-populated with `vid0` (`createShotSequence`, `shot-sequence.ts:123`)
  citing member frames as `@[Shot NNNN]`; the host strips those tags and uploads
  the frames as host inputs (`sequence-graph.tsx:150`, `main/index.ts:3369`).
- **Hard constraint**: on every open the canvas rebuilds the graph from domain
  state via `materializeGraph(shot, refs)` and persists if different
  (`NodeGraphModal.tsx:3739-3762`). Any new wiring not reproduced there is
  stripped on reopen (this exact bug bit the camera-grid node). So the sequence
  pair + all its edges MUST be emitted by `materializeGraph` from
  `graphSequence` (mirroring `graphCameraGrid`, `materialize.ts:208-233`).
- Reference sockets on prompt nodes are positional (`in-ref-N`) and their edges
  are rebuilt from tag order; camera-grid/video use explicit domain `refIds`
  (`applyCameraGridRefs`, `connect.ts:530`). The Visuals refs follow the
  camera-grid `refIds` precedent; the per-segment frame wires are **structural**
  (one fixed socket per segment, host-supplied locked frame refs), like the
  prompt→generator pipe.
- Take lifecycle currently reads `graphVideoNodes`:
  `sequenceSelectedTake` (`shot-sequence.ts:160`), `recordSequenceVideoGen`
  (`:233`), `sequenceOutputMedia` (`:175`), main `deleteSequenceTake`/
  `saveSequenceVideoAsReference` (`pipeline.ts:1735`/`1770`), merge
  (`productions.ts:337`). Moving the node to a dedicated `graphSequence` means
  updating these call sites (kept generic where possible).
- Existing sequences may already hold **paid** takes in
  `graphVideoNodes[0].gens`; migration must carry them forward.

## Plan

### Phase 0 — types, pure segment math, prompt template
- [ ] `shared/ipc/graph.ts`: `SequenceSegment { shotId; startSec; endSec;
      prompt; }`, `SequenceGraphData { visuals?; refIds?; segments?;
      styleConnected?; model?; resolution?; params?; gens?; genIndex?;
      generation? }`. `GraphNodeKind` += `"sequence" | "sequenceprompt"`.
      `GraphSource` += `{ kind: "sequence" }`. Canvas-id constants/titles.
- [ ] `shared/ipc/production.ts`: `ProductionShot.graphSequence?:
      SequenceGraphData`; extend `graphOutputSource` with `"sequence"`.
- [ ] `shot-sequence.ts` pure helpers (unit-tested):
      `normalizeSequenceSegments` (start_0 = 0; start_i = end_{i-1}; end_i >
      start_i else bump; ordered by shotIds), `reflowSegmentEnd(segs, i, end)`
      (cascade forward), `sequenceTotalDuration`, `sequenceSegmentLine`
      (`"{start}-{end}s @[Shot NNNN]: {prompt}"` — mechanical grammar in code),
      `seedSequenceSegments(shotIds)` (blank prompts). Update
      `createShotSequence` to build `graphSequence` (visuals "", segments from
      frames) instead of `graphVideoNodes`.
- [ ] `shared/prompt-templates.ts`: new `sequenceTimeline` template (outer
      wording; placeholders `{{visuals}}`/`{{shots}}`/`{{duration}}`), built-in
      + editor entry.
- [ ] `sequenceSelectedTake`/`sequenceOutputMedia`/`recordSequenceVideoGen`
      read/write `graphSequence`; `sequenceOutputMedia` handles
      `graphOutputSource === "sequence"`.

### Phase 1 — graph wiring (ports/connect/materialize/normalize)
- [ ] `shared/graph/ports.ts`: `sequenceprompt` decl (`in-style`, `in-brand`,
      `in-ref-open`+`in-ref-N`, `in-frame-open`+`in-frame-N`); `sequence` decl
      (`in-prompt` from `sequenceprompt`, `out` video). `output`/`editvideo`
      accept a `sequence` source. `portDecl` expands `in-frame-N`.
- [ ] `shared/graph/connect.ts`: resolve the bare `sequence`/`sequenceprompt`
      ids in `nodeKindForId`; map the prompt pipe, style/brand plugs, Visuals
      ref slots (positional `applySequenceRefs`), output feed, and a
      `sequence` edit-video source; detach rules (style/brand/ref); frame slots
      are non-connectable (structural).
- [ ] `shared/graph/materialize.ts`: emit the sequence pair whenever
      `shot.graphSequence` exists; add the member-frame ref nodes
      (`ref:seqframe:<shotId>`, via the host-supplied refs) + one structural
      `ref:seqframe:x → sequenceprompt.in-frame-<i>` edge per segment, the
      Visuals `in-ref-N` edges from `refIds`, style/brand plugs from
      `styleConnected`/prompt paragraphs, the prompt pipe, and the output feed
      for `graphOutputSource === "sequence"`.
- [ ] `components/graphFlow.ts`: sequence prompt node sockets (frame labels) +
      edge strokes; keep `promptSockets` for the Visuals style/ref/brand set.

### Phase 2 — canvas nodes (NodeGraphModal)
- [ ] `nodeTypes` += `sequence`, `sequenceprompt`; new `SequenceNodeView`
      (generator: model/resolution/params, takes, Generate, pending/busy,
      pipe-to-output, save-as-ref, delete) and `SequencePromptNodeView`
      (Style box; **Visuals** textarea + ref sockets; one row per segment: the
      piped frame thumb, `start–end` dial with an editable end stepper, the
      prompt textarea seeded from the frame, and a Revert button; Brand box).
- [ ] `hiddenTools` += `"videogen"` (union, `nodeKindHidden`, palette +
      `addTool` gates) so the sequence canvas hides the generic video pair and
      the legacy `vid0` is stripped on open; the sequence tile is never in the
      palette (present from `graphSequence`).
- [ ] `buildDerived`: build the sequence pair from `graphSequence`; label it
      from `seq.name`; resolve the output preview/`"sequence"` binding;
      select/cycle takes for the sequence node.
- [ ] Wiring handlers: `onConnect`/`isValidConnection`/`graphEdgesForDetach`
      for Visuals ref sockets, style/brand, the structural prompt pipe, the
      output pipe, and the edit-video `in-video` accepting the sequence output.

### Phase 3 — host + workspace
- [ ] `sequence-graph.tsx`: patch `graphSequence` (visuals, refIds, segments,
      styleConnected, model/resolution/params); assemble the vendor prompt
      (style → visuals → timed segment lines) and ordered `refIds`
      (frames then visual refs); `onRunSequenceGen`; output pipes; take
      select/delete/save-ref; supply member-frame `GraphRef`s (`seqframe:`).
- [ ] Segment prompt seeding: host resolves each member's effective prompt via
      `getBoardPrompt` (ProductionWorkspace already owns this) and shows
      `override ?? fetched`; edit writes the override; Revert clears it and
      re-fetches.
- [ ] `ProductionWorkspace`: `runSequenceVideoGen` (IPC), frame-prompt resolver,
      sequence take select/delete/save-reference wrappers; remove the old
      `graphVideoNodes`-based sequence generation path.

### Phase 4 — main, persistence, migration
- [ ] `main/index.ts`: `production:generateSequenceVideo` takes the assembled
      prompt + ordered `refIds` (frames → sourcePath, rest → extraRefs) +
      `durationSec`; write via `relocateClipToSequence` and
      `recordSequenceVideoGen` onto `graphSequence`; `recheckVideo` target for
      the sequence node; `deleteSequenceTake`/`saveSequenceVideoAsReference`
      read `graphSequence`.
- [ ] `productions.ts`: `mergeRendererShot` handles `graphSequence` (skip-list
      entry + `mergeSequenceNode`: main owns `gens`/`genIndex`, renderer owns
      visuals/refIds/segments/picks — mirror `mergeUpscale`).
- [ ] `normalizeShotSequences` migration: when `graphSequence` is absent but the
      sequence has members, synthesize it (segments from `shotIds`, blank
      prompts) and carry `graphVideoNodes[0]`'s `gens`/`genIndex`/picks/
      `styleConnected` into it; re-point `graphOutputSource` `"videogen"` →
      `"sequence"`; drop the legacy video nodes/positions.

### Phase 5 — animatic/export, tests, verify
- [ ] `applyShotSequences`/animatic/`assemblyPlan` already consume
      `sequenceOutputMedia`; confirm `"sequence"` resolves and the `SQ<NNNN>`
      reel/skipped-shots behaviour is unchanged.
- [ ] Tests: pure segment math (reflow/cascade/duration); ports + connect +
      materialize round-trip (reopen keeps every wire; the camera-grid bug
      guard); sequence take lifecycle + merge + migration (paid takes survive);
      node render + Revert + dial cascade (`shot-sequence-ui.test.ts`);
      generation handler opts. Then `npm run typecheck`, `npm test` (app),
      `npm run build`, `npm test` (core).
- [ ] `CONTEXT.md`: shot-sequences row + "Shot sequence" glossary bullet.

## Risks / notes
- **Take-lifecycle ripple** (Phase 4) is the main risk; if it proves too broad,
  the lower-risk fallback is to keep takes on a `vid0` `GraphVideoNode` and add
  only the timeline fields — at the cost of splitting the concept. Recommending
  the dedicated `graphSequence` for locality.
- `materializeGraph` MUST reproduce every sequence wire or the first reopen
  strips it (the camera-grid precedent).
- Existing sequences with paid clips must migrate their `gens` before the
  legacy video node is hidden/stripped.

## Review

**IMPLEMENTED — hybrid variant of the plan.** The full user-facing redesign
shipped, but the take-lifecycle move (Phase 4) was deliberately NOT done:
rather than relocating `gens`/output/edit-video wiring onto a dedicated
`graphSequence`, the sequence keeps the ordinary video generator node (takes,
picks, output binding, recheck, delete/save-reference, and the animatic/export
`sequenceOutputMedia` all unchanged). `graphSequence` carries only the timed
timeline (`segments`), and the prompt node renders as the `sequenceprompt` type.
This delivered the requested UX with a fraction of the blast radius and no
migration of paid takes.

What shipped:
- `shared/ipc/graph.ts`: `SequenceSegment` + `SequenceGraphData`;
  `ProductionShot.graphSequence`.
- `shot-sequence.ts`: pure `normalizeSequenceSegments` (anchored starts,
  collision cascade), `reflowSequenceSegments`, `sequenceTotalDuration`,
  `seedSequenceSegments`, `sequenceSegmentLine`, `stripSequenceFrameTags`;
  `createShotSequence` seeds a 3s-per-shot timeline; `normalizeShotSequences`
  repairs/normalizes a stored timeline and MIGRATES a legacy sequence (seeds
  segments from `shotIds`, strips `@[Shot NNNN]` from the video prompt) so old
  sequences show the new prompt node.
- Graph wiring: `videoprompt` gains positional `in-frame-N` sockets
  (`FRAME_SOCKET_RE`); `materializeGraph` emits one structural frame edge per
  segment from the locked `seqframe:<shotId>` refs; `applySequenceFrames`
  rebuilds them at runtime; detach/connect leave frame sockets structural.
- `NodeGraphModal`: new `sequenceprompt` node type (`SequencePromptNodeView` +
  `SequenceSegmentList`) rendered from `graphSequence` — Style + "Visuals"
  body + one row per shot (frame thumb, editable end dial, per-shot prompt,
  Revert). The generator reads "Sequence" and hides the clip-length selector
  (timing comes from the timeline). Added the missing `sequenceprompt`
  reconciliation comparator (a stale-data bug the new UI test caught).
- `sequence-graph.tsx`: seeds each row's prompt from the member's effective
  prompt via a `framePromptFor` fetch (wired in `ProductionWorkspace` to
  `getBoardPrompt`), assembles the vendor prompt (rendered Visuals + one
  `"{start}-{end}s: prompt"` line per shot) and uploads member frames in order;
  `setSegments`/`revertFramePrompt` patch the timeline + keep frame edges.
- `pipeline.ts` `removeShotsFromSequences` prunes a removed member's segment.
- CSS for the timeline rows; `CONTEXT.md` row + glossary updated.

Verify: `npm run typecheck` clean; `npm test` (app) 1254 passed + 1 skipped;
`npm run build` clean; `npm test` (core) 147 passed.

Not done (by design): a dedicated `sequence`/`sequenceprompt` generator node
that owns the takes. If pursued later, it is the Phase 4 work above.

### Follow-up (user feedback)
- Per-shot prompts now strip the shared Style/Brand sections (`stripSharedSections`
  on the fetched frame prompt) — a row is the shot's own description.
- The submitted line is now the multi-shot framing form:
  `Hard Cut to Shot N. X Seconds. Framing Reference <<<image_K>>>` + the shot
  prompt, where K is the frame's position in the submitted refs (style frame +
  Visuals references counted first, per the user's "absolute upload position").
- Member-frame sockets moved from inside the rows to the node's **left edge**
  (`in-frame-<i>` beside Style/Reference), via a `sockets` override on
  `PromptNodeView`.
- Brand removed from the sequence prompt node (no socket/box) and the Brand
  node hidden on the sequence canvas (`SEQUENCE_HIDDEN_TOOLS` += `"brand"`;
  `nodeKindHidden`); generation renders Style-only visuals.
- New UI coverage: no brand node, two left-edge `Shot` sockets, the Hard Cut
  lines + total duration on submit.

### Follow-up 2 (user feedback)
- Segment timing simplified from a `startSec`/`endSec` range to a single
  `SequenceSegment.durationSec` (whole seconds, min 1); `reflowSequenceSegments`
  removed, `sequenceTotalDuration` is now the sum, and a legacy stored range
  migrates to its length. The row shows one "N Seconds" input.
- The node footer shows `Sequence Total: n Seconds`.
- The generator's clip-length selector is back and seeds / re-seeds from the
  timeline total (`VideoGenData.sequenceTotal`), snapping to a model-supported
  length once its options load.
- The right-hand node palette is hidden on the sequence canvas via a new
  `NodeGraphModal` `hidePalette` prop (`SequenceGraphModal` passes it); the
  reference shelf is kept.

---

# Node graph: multi-instance nodes + edit-video availability

User request (3 parts):
1. Disable the edit-video node when using the OpenArt MCP provider (it has no
   video-edit path).
2. Allow dragging in **multiple video-generation nodes**, like edit-image nodes.
3. ("In fact") every node kind should be addable more than once.

## Findings / scope

- Only `higgsfield-cli` implements `videoEditModels()`/`generateVideoEdit()`;
  both OpenArt transports omit them (`providers/openart.ts`,
  `openart-cli.ts`). The edit-video node is currently addable under OpenArt; its
  model list is empty and submit throws (`index.ts:3174-3177`). The upscale node
  already has the correct gate (`providerSupportsUpscale` +
  `UPSCALE_UNAVAILABLE_HINT`, palette `NodeGraphModal.tsx:5343`) — mirror it.
- Only edit-image nodes are list-backed (`graphEditNodes: GraphEditNode[]`,
  canvas ids `editgen:<id>` / `editprompt:<id>`, prefix helpers + `nextEditNodeId`,
  main-side `mergeEditNodes`). Every other generator is a singleton field with a
  bare canvas id.
- Full multi-instance is NOT one mechanical change: `imagegen` is structural
  (`TWEEN_KEY_IMGGEN`, always present, shared composer pipe), `tween` owns all
  keyframes/blocks/stitch, and `cameraGrid`/`upscale` carry per-node source wiring
  + history. Each needs its own list type + migration + merge, following the
  edit-node precedent.

## Plan

### Phase A — edit-video availability gate (small)
- [x] `shared/ipc/media.ts`: `providerSupportsVideoEdit(id)` (only
      `higgsfield-cli`) + `VIDEO_EDIT_UNAVAILABLE_HINT`.
- [x] `ProductionWorkspace`: `videoEditUnavailable` from `mediaProviderId`,
      passed to `NodeGraphModal`.
- [x] `NodeGraphModal`: gate the palette item + `addTool("editvideo")` exactly
      like upscale (disabled class/title/hint). Keep the live
      `videoEditModels` probe for the model list.

### Phase B — multiple video-generation nodes (like edit nodes)
- [x] `graph.ts`: `GraphVideoNode` (id, prompt, gens/genIndex,
      model/resolution/durationSec/params, source?, refIds?, styleConnected?)
      + `videogen:<id>`/`videoprompt:<id>` id helpers (vid0 keeps bare ids).
- [x] `production.ts`: `graphVideoNodes?: GraphVideoNode[]`,
      `graphOutputVideoNodeId?`; legacy `graphVideo*` marked deprecated.
- [x] `migrateVideoNodes(shot)`: folds the singleton into `[vid0]`; called from
      `migrateBoardArtwork` and `mergeRendererScenes`; schema bumped 2 → 3.
- [x] `materialize.ts`: one pair per node, edges parameterized by node id;
      output edge uses `graphOutputVideoNodeId`; `videoNodesFor` legacy synth.
- [x] `connect.ts`: `nodeKindForId`/`promptPipeFor`/`connectionToEdge`/
      `graphEdgesForDetach` handle the prefixed video ids; vid0 unchanged.
- [x] `productions.ts`: `mergeVideoNodes` by id (mirrors `mergeEditNodes`).
- [x] `pipeline.ts`: `getVideoNode`/`newVideoNode`/`videoNodeSelection`/
      `recordGraphVideoGen(nodeId,…)` + media-path/ref-cleanup coverage.
- [x] `index.ts` + IPC + preload: `production:generateVideoNode` takes `nodeId`;
      pending target `{kind:"videoNode", nodeId}`; recheck applies to that node.
- [x] `NodeGraphModal` + `ProductionWorkspace`: `videoNodes` memo, per-node
      factory/prompt node, `addTool("video")` appends, buildDerived maps all,
      reconciliation, per-node select/cycle/draft/busy, output pipe by node id.
- [x] Tests: materialize multi-node + `videoNodesFor`; connect per-node edge ids;
      shelf second-drag adds `videogen:vid1`; edit-video tile disabled; updated
      migration/selection/schema tests. `npm run typecheck` clean, 1135 app +
      147 core pass, `npm run build` clean.

### Phase C (follow-up, if asked) — all remaining kinds multi-instance
- [ ] `editvideo` list, `cameraGrid` list, `upscale` list.
- [ ] `imagegen` list (structural: per-node prompt vs shared composer?).
- [ ] `tween` list (per-node keyframes/blocks/stitch).

## Review

Done (Parts 1+2). Part 1: `providerSupportsVideoEdit` disables the edit-video
tile/drop for any non-Higgsfield provider, matching the upscale gate. Part 2:
video-generation nodes are now a list (`graphVideoNodes`), mirroring the
edit-node precedent end to end — canvas pairs `videogen:<id>`/`videoprompt:<id>`
(vid0 keeps the historical bare ids + edge ids so every existing stored graph
and test stays valid), per-node history/source/refs/model picks, per-node
pending-recheck target and busy mirroring, merge-by-id persistence, and a
one-time `migrateVideoNodes` fold from the legacy flat fields (schema v3). The
palette tile now always appends another node (count badge) with a "remove all"
X; individual nodes delete via the node Delete key, blocked while a node holds
clips/prompt/source/refs/output. Self-caught: the style-plug edge was missing
from the legacy synth until `videoNodesFor` carried `styleConnected` (graph-render/
graph-flow failures); classic generation after clearing all video nodes would
have recorded nowhere until `recordGraphVideoGen` started creating `vid0`.
Part 3 (all remaining kinds) is deferred per the chosen scope.

---

# Per-project expenses (ledger scoping)

User report: one project's Expenses page listed many generations that
weren't done for it. Root cause: the ledger was one global
`userData/ledger.json` with `view()` returning every entry, and the
Expenses page never scoped by production. Entries already carried
`productionId` but nothing filtered on it; manual rows carried none.

## Plan

- [x] `ledger.ts`: entries move to per-production files
      (`userData/ledger/<productionId>.json`) with per-project CSV mirrors;
      `userData/ledger.json` keeps only the global price rules (`version: 2`).
      One-time migration splits v1 entries by `productionId`, dropping
      unattributable rows.
- [x] `recordGeneration`/`addManualEntry`/`removeEntry`/`view`/
      `openLedgerFile` take a production id; `repriceAll` walks every project;
      new `removeProject`/`archiveProject` follow production delete/archive.
- [x] IPC signatures scoped (`getLedger`/`repriceExpenses`/`addManualExpense`/
      `removeLedgerEntry`/`openLedgerFile`), main handlers pass through.
- [x] Renderer: `ProductionWorkspace` passes `prod.meta.id` to `ExpensesPanel`;
      panel reloads on project change; hint + button copy say per-project.
- [x] Accuracy fix: reclaimed pending frames bill once — `PendingImageGen`
      keeps submit-time resolution/aspect (`openart`, `higgsfield`,
      `higgsfield-cli`, `openart-cli` record them) and `production:recheckBoard`
      calls `recordGeneration` on recovery.
- [x] Tests: per-project isolation, no-production drop, migration split/discard,
      per-project CSV, lifecycle remove/archive. `npm run typecheck` clean,
      691 pass + 1 skip, `npm run build` clean.
- [ ] Follow-up (out of scope): 3D-model (ModelgenClient) generations still
      aren't billed to the ledger.

## Review

Done. Price rules stay global by design (per-model vendor pricing, not project
data). Deferred 3D billing is noted. Self-caught: migration had to be triggered
from `loadProject` (not just rules access) or a fresh app session opening an
Expenses tab would never split the legacy file; guarded re-entrancy by setting
the rules cache before migrating. `repriceAll` changed from returning a view to
void since the view is now per-project; IPC reprice reprices all then returns
the caller's project view.

---

# OpenArt CLI provider (openart-cli transport)

User request: also implement OpenArt CLI; the top-right toggles switch
between MCP and CLI. CLI v0.1.1 limits (probed locally): images take
repeatable `--image` but expose NO aspect/resolution flags (model defaults
apply); video takes ONE `--image` only (no end frame, no extra refs, no
video refs).

## Plan

- [x] Extract shared OpenArt grammar to `providers/openart-core.ts`
      (model shaping, form props, video options, duration text);
      `OpenArtClient` delegates (47 existing tests guard the refactor).
- [x] Extract shared subprocess seam to `providers/cli-run.ts`
      (`CliRun`, spawn shell-free, PATH probe, temp-ref writer);
      `HiggsfieldCliProvider` reuses it (tests guard).
- [x] New `providers/openart-cli.ts`: `model list --json` choices
      (`openart-cli:`-namespaced) + background `model cost` overlay,
      `account --json` credits, `model form` options via shared core,
      `generate image/video --async` + `creation wait/get` submit/rejoin,
      `project list/create` routing, pending-image reclaim, ledger.
      Images: full multi-ref; video: single start frame only — end
      frames, extra refs, and video refs fail loudly with an MCP redirect
      instead of billing reference-less output.
- [x] Registry/settings/index: 4th provider id, prefix routing, binary
      path + status IPC, startup PATH probe.
- [x] Renderer: data-driven 4th toggle segment, subpanel labels/order/
      classifier, per-CLI binary path + status blocks, transport-aware copy
      (`endsWith("-cli")`), integer balance formatting for OpenArt CLI.
- [x] Tests: `openart-cli.test.ts` (14: prefixing, choices+costs, credits,
      options, image/video submit + refs + project + ledger + pending/
      recheck + pick validation + limits + login hint); union assertions
      updated. Verified: `tsc` clean, 596 pass + 1 skip, `npm run build`.
- [ ] LIVE (needs user `openart login` — no credential on file):
      lock `model list/form`, `account`, `creation` shapes to real replies;
      run one cheap image end-to-end. Parsers are defensive (shared MCP
      vocabulary + envelope/bare-JSON fallbacks; raw output attached to
      every parse failure for self-diagnosis).

## Review

Done except live verification (OpenArt CLI not installed/authed here —
fixtures built from `--help`, `--dry-run` request bodies, and the shared
backend vocabulary). Self-caught: `SUCCEEDED` missed the done-regex (no
`succeed` alternative) — added; cost overlay only ran on cache miss —
moved to every call; outbound ids left unprefixed (collided with MCP in
ladders) — namespace on shape; `execFile`/`shell:true` banned — spawn-only
from the start this time.

---

# Higgsfield image-model routing + submit logging + quality passthrough

## Plan
- [ ] 1. Per-model image routing (`app/src/main/index.ts`): all 6 `media().imageGenFn(...)` sites → `mediaFor(model)` (stored pick or explicit override), matching the video-node path. Also `recheckBoard` (route via `pending.model`) and `production:videoModelOptions` (route via queried id).
- [ ] 2. Submit logging: Higgsfield `imageGenFn` emits `model=… resolution=… aspect_ratio=… quality=… medias[…] prompt=…` via `onNotice` (mirrors the video `paramDump`); OpenArt `imageGenFn` emits `model=… mode=…` the same way.
- [ ] 3. Dropdown truthfulness (`ProductionWorkspace.tsx` storyboard Model select): when the stored pick isn't in the current list, show it as an `(unavailable — re-pick)` option instead of silently displaying `imageModels[0]`.
- [ ] 4. Quality passthrough: `ImageModelOptions` (qualities + default) from Higgsfield catalog `quality` param → `MediaProvider.imageModelOptions` (OpenArt: null) → `production:imageModelOptions` IPC → storyboard Quality dropdown persisted on `OpenArtBoardConfig.quality` (survives `productions.ts` normalize) → forwarded as `params.quality` on submit.
- [ ] 5. Tests: Higgsfield `imageModelOptions` + quality submit + submit notice; OpenArt submit notice + `imageModelOptions` null. Then `npm run typecheck`, `npm test` in `app/`.

## Review
Done — all four fixes, verified (`npm run typecheck` clean, `npm test` 559 passed / 0 failed, `npm run build` clean):
- `app/src/main/index.ts`: all 6 `media().imageGenFn(...)` sites now route via `mediaFor(model)` (stored pick or explicit override), matching the video-node path; `recheckBoard` routes via `pending.model`; `production:videoModelOptions` and the ledger price-rule probe route via the queried id.
- Submit logging: Higgsfield images emit `Submitting image job via <id> (resolution=… quality=… aspect_ratio=… medias[…] )`; OpenArt images emit `Submitting image job via <id> (mode=…)`.
- `ProductionWorkspace.tsx`: stale stored picks render as an `(unavailable — re-pick)` option instead of silently showing the first model; the mount effect no longer overwrites an explicit `higgsfield:…` cross-vendor pick; `saveField` calls preserve `openArt.quality`.
- Quality: `ImageModelOptions` probe (Higgsfield catalog `quality` param; OpenArt null) → `production:imageModelOptions` IPC → storyboard Quality dropdown (hidden when the model declares none) persisted on `OpenArtBoardConfig.quality` (survives `productions.ts` normalize) → forwarded as `params.quality` only on exact catalog match.
- Tests: 5 new (Higgsfield quality probe/submit/notice ×3, OpenArt notice + null probe ×2).
- Note: Flare vs Sunburst as separate entries depends on Higgsfield's `models_explore` listing them — Cascade shapes whatever the catalog returns. Run `probe-higgsfield.mjs reads` to confirm what the live catalog currently exposes.
- Self-caught: renderer hooks were first added below the `if (!prod)` early return (4 test failures) — moved above it; full suite green after.

---

# Higgsfield CLI provider (higgsfield-cli transport)

User request: keep both MCPs, add a CLI option with full parity — image/video
dropdowns, resolutions/lengths, in-betweener end-frame filtering, reference
images/videos in video generation, and a Settings subpanel. Investigation
showed OpenArt CLI v0.1.1 `generate video` takes ONE `--image` only (no end
frame, no multi-ref) so it cannot serve tween/element video; Higgsfield CLI
v1.1.24 supports `--start-image` + `--end-image` plus repeatable
`--image/video/audio-references`, and its job_type ids match the MCP catalog.
Built for Higgsfield, not OpenArt.

## Plan

- [x] Contract: `MediaProviderId` += `"higgsfield-cli"`; `getMediaCredits` →
      `Record<MediaProviderId, number|null>`; new `HiggsfieldCliStatus` +
      binary/status IPC (`shared/ipc.ts`, `ipc-channels/mcp.ts`).
- [x] Registry: meta/ids/coercion, `providerOfModelId` routes
      `higgsfield-cli:`, `createProviders` builds it (lazy binary resolver),
      `getMediaCredits` covers all vendors. Ids leave namespaced
      `higgsfield-cli:<job_type>` so the transports never collide.
- [x] Settings: id accepted in get/set/migration; `higgsfieldCliBinary`
      override (null = PATH).
- [x] New `providers/higgsfield-cli.ts` (spawn-only seam, no shell — source
      guard bans exec/shell:true): `model list --image/--video --json`
      choices, `account status --json` credits, `model get --json` options
      (resolution/duration/quality) + end-frame probe + caches + prewarm,
      `generate create` (no --wait) + `generate wait` submit/rejoin for
      image/video (refs via temp files; `--start/--end-image`; repeatable
      ref arrays by declared roles; `--mode omni_reference` on seedance_2_5
      with media; duration fail-loudly; pending reclaim via `generate get`),
      `resolveProject` null, ledger recorder. Binary resolver passes real
      binaries through and maps npm `.cmd`/`#!` shims to vendor/hf (MZ check).
- [x] `main/index.ts`: startup PATH probe + lazy resolver, CLI handlers.
- [x] Renderer: 3-way `MediaProviderToggle` (Record credits, data-driven
      list), App state, Settings labels/order/classifier + binary path +
      status, transport-aware storyboard copy.
- [x] Tests: `higgsfield-cli.test.ts` (18: prefixing, shim resolution,
      choices, credits, options, quality, end-frame, image/video submit +
      refs + mode + fail-loudly + pending/recheck + login hint); updated
      `providerOfModelId`/`mediaForModel`/`resolveProviderId`/
      `createProviders`/`getMediaCredits` assertions.
- [x] Verify: `tsc` clean, 582 pass + 1 skip, `npm run build` clean,
      `hf.exe version` runs, shim→vendor resolution proven against a real
      npm install.
- [x] LIVE (user authed 2026-09-11): `account status` →
      `{credits:73.24,email,…}`; `model list` → 32 image + 35 video
      `{display_name,job_type,type}`; `model get` →
      `{params:[{name,type,default,enum?}],rules}` with NO medias block
      (start/end-image and ref arrays are params) and mostly open integer
      durations (veo3_1_lite-style closed string enums parse too);
      `generate list` jobs carry `{id,status,result_url}`. Defaults corrected
      to live models (`gpt_image_2_5`/`seedance_2_5`;
      `cinematic_studio_2_5` is gone from the catalog). Global npm shims
      resolve via both `.bin` and prefix-root vendor layouts. Read-only
      end-to-end proven (67 choices, credits, options, 15 end-frame models).
- [ ] Optional paid proof: one cheap `generate create` + `generate wait`
      round-trip through the provider (needs explicit spend approval).

## Review

Done except live verification (parsers are defensive: array/envelope/map
inputs, snake/camelCase keys, preferred-field then extension-scan URL
collection; every parse failure throws with the raw CLI output attached so
the first authed run diagnoses itself). Verified: `tsc --noEmit` clean, 582
tests pass + 1 pre-existing skip (18 new), `npm run build` succeeds.
Self-caught: `execFile`+`shell:true` tripped the security source guard —
rewrote to `spawn` shell:false (plus an MZ-header check so Windows npm
`.cmd`/`#!` shims resolve to vendor/hf.exe); a `const exec` variable name
tripped the same guard — renamed; `where` returns the unspawnable shim
first — resolver skips to the real binary.

---

# Higgsfield CLI per-config credit quotes on Generate buttons

User request: show the credit cost on Generate buttons before submit
(Higgsfield CLI only — OpenArt MCP has no cost surface). Must recalc on
model / resolution / length / quality / aspect / advanced-params changes
without hurting performance.

## Findings (verified this session)

- CLI seam exists: `higgsfield generate cost <job_type> --prompt … [--duration
  …] [--resolution …] [--aspect_ratio …] [--start-image/--end-image/
  --image-references/--video-references …]` (+ `generate cost workflow …`)
  mirrors `generate create` args but submits nothing (official
  higgsfield-generate skill). MCP equivalent is `get_cost:true`; web shows
  cost on the Generate button.
- Cascade today hardcodes `cost: null` for every Higgsfield choice
  (`app/src/main/providers/higgsfield-cli.ts:344` — "needs a `generate cost`
  preflight"), so `VideoGenModal` (`boards.tsx:724-729`) only ever shows the
  balance line for `higgsfield-cli:*` picks. OpenArt CLI already overlays
  static per-model cheapest quotes via `model cost --json`
  (`openart-cli.ts:327`); this plan adds the first *per-config* live quote.
- Generation surfaces sharing one hook (from grep): `VideoGenModal` →
  `generateVideo` (`ProductionWorkspace.tsx:2252`); node graph
  `generateFrameNode`/`generateVideoNode`/`generateEditVideoNode`/
  `generateEditNode`/`generateTweenBlock` (ibid. 1890–2108); `RefGenModal` →
  `generateReferenceImage` (703); character `generateCharacterSheet` (712);
  style `generateStyleFrame` (839). Bulk `generateBoards` (1088) stays out of
  scope (per-frame × N shown instead, if at all).
- Cost drivers are structural (model, resolution, duration, aspect, quality,
  variant/mode, ref *counts*) — prompt text and ref *bytes* don't price.
  The probe must therefore send a truncated constant prompt and must NOT
  upload temp files.

## Plan

- [ ] 0. Live probe (read-only, authed CLI): `generate cost --help` + one
      image + one video `generate cost` with known params. Lock: exact argv,
      JSON output shape(s), which flags move the price (esp. refs: counts vs
      paths), whether ref flags can be omitted, median latency. No code until
      shapes are recorded.
- [ ] 1. Provider seam (`providers/higgsfield-cli.ts`, never `index.ts`
      domain logic): optional `MediaProvider.getGenerationCost?(req)` +
      `GenerationCostRequest` in `shared/ipc.ts` (`model`, `kind`,
      `resolution?`, `durationSec?`, `aspectRatio?`, `quality?`,
      `refCounts {images,videos}`, cost-relevant `params` subset only).
      Arg builder reuses the submit path's role logic minus temp files;
      tolerant parser (`credits`/`total_credits`/`cost`/`price`, nested
      `data`); never throws — `null` on any failure; in-memory cache keyed
      by stable JSON (TTL ~5–10 min, cap ~64, last-good fallback) mirroring
      `schemaCache`. Other providers omit the method (OpenArt MCP: no
      surface; OpenArt CLI keeps its static overlay).
- [ ] 2. IPC (`shared/ipc.ts` + `ipc-channels/production.ts` one entry +
      preload mechanically): `production:generationCost` → `mediaFor(model)`
      routing so non-Higgsfield ids return `null` with zero spawns. Lesson:
      main-process handlers need a full dev restart (`out/main/index.js`
      check) or the renderer sees "No handler registered".
- [ ] 3. Renderer hook + VideoGenModal first: `useGenerationCost(req,
      { enabled, debounceMs: 400 })` — enabled only for
      `higgsfield-cli:*` ids (prefix check, no IPC otherwise); request-id
      stale guard (same `live` pattern as `boards.tsx:603`); states
      `calculating…` / `◎~X` / hidden-on-null; submit never blocked.
      Button becomes `Generate video (◎~12)`; existing `prod-video-cost`
      line keeps balance. Recalcs on structural changes only, never on
      prompt keystrokes.
- [ ] 4. Roll out to remaining surfaces with the same hook: image Submit
      frame, edit-image nodes, `RefGenModal`, character sheet, style frame,
      video / edit-video nodes. Tween = ONE probe × block count
      client-side, not N spawns.
- [ ] 5. Tests at the seam (fake `run`, cf. `app/test/higgsfield-cli.test.ts`
      pattern): argv shape, tolerant parse variants, failure→null, cache-hit
      makes no second spawn, foreign/auto id → null without spawn; renderer
      hook test for debounce + stale-guard. Then `npm run typecheck`,
      `npm test` (app), `npm run build`.
- [ ] 6. Live verify (needs authed CLI + explicit spend approval for the
      control): probe latency p50/p95, quote accuracy vs one cheap real
      generation's billed credits, rapid dropdown flips show no stale price.

## Performance notes (why this doesn't hurt)

- Debounced (~400 ms) + cached + gated (Higgsfield ids only) +
  fire-and-forget: steady-state cost is ~0 spawns; worst case one short local
  spawn per settled config — same order as the `model get` already fired on
  every model change, noise next to a minutes-long generation.
- No uploads on the probe path (counts/flags only); prompt sent as a short
  constant.

## Review

Done, verified (`npm run typecheck` clean, 687 pass + 1 pre-existing skip,
`npm run build` clean, 7 new provider tests green):

- Phase 0 (live, read-only): `generate cost` mirrors `create` args, `--json`
  → flat `{credits: N}` (fractional, e.g. 32.5); prompt required but never
  moves the price (long vs short prompt → same 32.5); refs don't move it
  either (seedance_2_5 5s/720p = 32.5 with and without `--start-image`); p50
  ~380–480 ms per probe. Kling3_0 live check: no `resolution` param (the
  CLI rejects it) — the provider's emit-only-declared logic already handles
  this; 5s quotes 8.75.
- Phase 1: `GenerationCostRequest` (`shared/ipc.ts`) + optional
  `MediaProvider.getGenerationCost` (`providers/types.ts`) +
  `HiggsfieldCliProvider.getGenerationCost` (constant `"cost probe"` prompt,
  no media flags/zero uploads, submit-mirroring emission, tolerant parser,
  5-min TTL + 64-cap cache incl. nulls, never throws) + `refreshProbes`
  clears it.
- Phase 2: `production:generationCost` channel + `mediaFor(model)` handler
  (non-Higgsfield → null, zero spawns; failures → null). Build output
  confirmed to carry the handler (main-restart lesson).
- Phase 3/4: `useGenerationCost` (400 ms debounce, stale-while-revalidate,
  Higgsfield-ids-only gate) + `GenerationCostSuffix` (for `.map` rows) +
  `costAspect`/`formatGenerationCost` wired into: VideoGenModal button +
  cost line, 4 node-graph gen views, tween per-block buttons, RefGenModal
  (both tabs), character sheet, classic edit popup, storyboard Submit frame,
  style-frame buttons. OpenArt surfaces untouched (static overlay/balance
  only — no cost surface on MCP).
- Self-caught: tween/node buttons inside `.map` can't call hooks — added the
  suffix component instead of restructuring; kling resolution lesson above;
  edit-video has no duration control so its quote omits `--duration`
  (advisory, same default the server applies).
- Not verified (needs explicit spend approval): quote-vs-actually-billed
  accuracy on one cheap real generation. Restart dev (`npm run dev`) so the
  running main process picks up the new handler.

---

# Non-timing-out generation downloads + per-surface Fetch (pending jobs)

User report: generation downloads shouldn't time out (image gens sometimes take
a long time; a Higgsfield image gen just timed out). When a timeout or any
post-submit error happens, the node/panel that submitted should show a **Fetch**
button that pulls down *that specific job's* result.

## Findings (verified in code)

- Only the **classic board** surface has any recovery: providers set
  `shot.pendingImageGen` (a single per-shot field) on the *wait-timeout* only, and
  `production:recheckBoard` reclaims it into `graphImageGens` via
  `recordGraphImageGen`. `BoardCard` renders the `◷` recheck.
- Recovery is **lost on every other surface**: `generateFrameNode` /
  `generateEditNode` run under `runProductionStep`, and all video runs under
  `runVideoJob` — on error those runners rethrow *before* the commit
  (`rebaseProduction`), so a pending record written by the provider never hits
  disk. `generateReferenceImage`/`generateCharacterSheet`/`generateStyleFrame`
  (and `suite:generate`) have no pending concept at all.
- Recovery is only recorded for a **timeout**, not for a download failure or a
  CLI/MCP error. In `higgsfield-cli.ts:createAndWait`, a `fetchBytes` failure
  throws `Couldn't download…` with the `jobId` dropped; a `generate wait` process
  failure (`cli()`) also drops it. `OpenArt` video's 20-min deadline throws a
  plain `Error` with the `historyId` dropped (`openart.ts:897`). So even video
  "recovery" would need the handle carried on every failure.
- The single-slot `shot.pendingImageGen` also can't disambiguate destinations:
  an edit-node run writes the same field, but `recheckBoard` always lands the
  result in the image-gen node — a latent wrong-destination bug.
- Wait caps: image = 150 s (`higgsfield-cli.ts:122`, `openart.ts:74`), video =
  20 min. The download `fetch` itself is unbounded (no AbortController) — the
  timeout the user hit is the **wait cap**, not the download.

## Decisions (confirmed with user)

- Scope: **image + video** — every generation surface gets recovery.
- Timeout: **generous cap + guaranteed recovery**. Raise the image wait cap to
  match video (20 min); never bound the download fetch; always persist the
  submitted job so the Fetch button can reclaim it.

## Design

One **pending-jobs registry** on the production, keyed by a typed **surface
target**; providers throw a typed `MediaJobError` carrying the submitted job's
handle on any post-submit failure; a single IPC fetch routes the result to the
target's existing recorder.

- **`shared/ipc/pending.ts`** (new, re-exported from `shared/ipc.ts`):
  - `PendingJobTarget` union: `imagegen:<shotId>` (classic board + image node —
    identical destination), `editgen:<shotId>:<nodeId>`, `video:modal:<shotId>`,
    `video:node:<shotId>`, `editvideo:<shotId>`, `tween:<shotId>:<blockId>`,
    `reference:<refId|new:name>`, `character:<id|name>`, `style:<styleId>`,
    `suite`.
  - `pendingTargetKey(target)` / `parsePendingTargetKey(key)` (one home for the
    grammar).
  - `PendingJob` = `{ target, kind, model, prompt, resolution?, aspectRatio?,
    quality?, durationSec?, params?, sourcePath?, applyToOutput?, jobId?, url?,
    at }`. `sourcePath`/`applyToOutput` mirror the submit handler so the applier
    can reproduce it exactly (video node vs modal, edit-video).
  - `PendingImageGen` → `@deprecated`, migrated on load.
- **`Production.pendingJobs?: Record<string, PendingJob>`** — main-owned.
  `normalize` preserves it; `applyRendererState` must NOT copy it from incoming
  (fresh wins — the renderer never edits it); add to `rebaseProduction`'s
  top-level copy list. A one-time read migration folds `shot.pendingImageGen`
  into `imagegen:<shotId>` and deletes the field (gated by
  `PRODUCTION_SCHEMA_VERSION`, bump).
- **Provider seam (`providers/types.ts`)**:
  - `SubmittedJob` handle (`jobId?`, `url?`, `kind`, `model`, `prompt`,
    `resolution?`, `aspectRatio?`, `quality?`, `durationSec?`, `params?`).
  - `MediaJobError extends Error { readonly job: SubmittedJob }`. Make the three
    existing pending errors (`HiggsfieldCliPendingError`,
    `OpenArtImagePendingError`, `OpenArtCliPendingError`) extend it so existing
    messages/tests survive; add it to `createAndWait`'s wait-process failure and
    download-failure throws, and to OpenArt MCP/CLI image download failures and
    the OpenArt video deadline. Only a failed submit (no id) stays a plain
    `Error` (nothing spent, nothing to fetch).
  - Generalize `recheckPendingImage(rec)` → `fetchJob(job: SubmittedJob):
    Promise<{ buf: Buffer; ext: string } | null>` on `MediaProvider`; each
    transport re-polls by `jobId` / re-downloads `url` and derives `ext` (video
    from the URL path; image sniffed from bytes). `null` = still rendering.
  - Providers stop writing `shot.pendingImageGen`.
- **Main recording (`index.ts` wiring + one helper)**:
  - `recordPendingJob(id, target, handle)` / `clearPendingJob(id, target)` /
    `findPendingJob(id, target)` — load-fresh, mutate, save under
    `enqueueProduction` (never clobber concurrent jobs). One home so no handler
    rolls its own.
  - `runProductionStep`/`runProductionJob`/`runVideoJob` gain an optional
    `pendingTarget`; their `catch` calls `recordPendingJob` when the error is a
    `MediaJobError`, then rethrows as today. `boardsOrPrompts` wraps its injected
    `ImageGenFn` per shot to record `imagegen:<shotId>` inside
    `generateBoards`'s per-shot catch (that step succeeds, so the registry rides
    the normal rebase). `suite:generate` records in its own catch.
  - Each handler **clears its target at submit start** (a re-submit supersedes a
    stale entry), mirroring the old `delete shot.pendingImageGen`.
- **Fetch (`production:fetchPendingJob` IPC)**: load `p`, resolve the target's
  `PendingJob`; `mediaFor(job.model).fetchJob(job)`; `null` → emit "still
  rendering"; a dead-job `Error` → clear + emit; bytes →
  `applyFetchedJob(p, job, buf, ext)` (new `pipeline.ts` function, provider-free),
  bill once via the existing `ledger.recordGeneration` using the job's kept
  config, clear the entry, save, return the Production. `suite` is bespoke
  (returns a `SuiteEntry` appended to the suite session file, not the production).
- **`pipeline.applyFetchedJob(p, job, buf, ext)`** routes on `job.target` to the
  *existing* recorders: `imagegen` → `writeBoardFrame` +
  `recordGraphImageGen` + `hookImageGenToOutput`; `editgen` → + `recordGraphEditGen`
  + `syncBoardOutputToPipe`; `video` → `writeShotVideo` + `recordGraphVideoGen`
  (+ `applyVideoOutput` when `applyToOutput`); `editvideo` →
  `recordGraphEditVideoGen`; `tween` → `recordTweenBlockGen`; reference/character/
  style → write the file and update/create the entry (reuse the handlers' write
  logic, extracted). Pure over the recorders → unit-testable.
- **Timeouts**: `IMAGE_WAIT_TIMEOUT_MS` (`higgsfield-cli.ts`) and
  `IMAGE_WAIT_DEADLINE_MS` (`openart.ts`) → 20 min (matching video); recheck
  stays 60 s. No timeout is added to the downloads.
- **Renderer**: shared `<PendingFetchButton>` (busy state + icon, same shape as
  the existing recheck control) rendered wherever a matching entry exists:
  `BoardCard` (replace the `◷`), each node-graph gen node
  (`NodeGraphModal.tsx` — image, edit, video, edit-video, tween blocks), the
  video modal, `references.tsx` / `RefGenModal`, the character builder, the
  Design style-frame buttons, and the Image Suite. Clicking calls
  `fetchPendingJob(prodId, key)` and `setProd(next)` (suite refreshes its
  session). `BoardCard`'s `pending` prop reads `prod.pendingJobs` instead of
  `shot.pendingImageGen`.
- **Docs**: update `CONTEXT.md` (new `PendingJob`/`pendingJobs`, `MediaJobError`,
  `fetchJob`, image wait cap; `pendingImageGen` deprecated→migrated).

## Plan

- [ ] 1. `shared/ipc/pending.ts`: `PendingJobTarget`, key build/parse,
      `PendingJob`/`SubmittedJob`; `Production.pendingJobs`; re-export; mark
      `PendingImageGen` deprecated. Key round-trip unit tests.
- [ ] 2. `providers/types.ts`: `MediaJobError` + `SubmittedJob`; rename
      `recheckPendingImage`→`fetchJob({buf,ext})`.
- [ ] 3. Higgsfield CLI: carry the handle on wait-failure, download-failure, and
      timeout (image + video + edit-video); throw `MediaJobError`; implement
      `fetchJob` for image/video; drop `shot.pendingImageGen` writes; image cap →
      20 min. Update `higgsfield-cli.test.ts`.
- [ ] 4. OpenArt MCP + CLI: same `MediaJobError`/`fetchJob` conversion; carry the
      `historyId` on image download failure and the video deadline; image cap →
      20 min. Update `openart.test.ts` / `openart-cli.test.ts`.
- [ ] 5. `productions.ts`: preserve `pendingJobs` in `normalize`; never copy it
      in `applyRendererState`; migrate `shot.pendingImageGen` (bump schema
      version). Add `pendingJobs` to `rebaseProduction`'s copy list (`index.ts`).
- [ ] 6. `index.ts`: `recordPendingJob`/`clearPendingJob`/`findPendingJob`;
      `pendingTarget` on the three runners + catch recording; `boardsOrPrompts`
      per-shot wrapper; clear-at-submit in every generation handler.
- [ ] 7. `pipeline.applyFetchedJob` + `production:fetchPendingJob` IPC (contract
      entry + preload mechanically) with reclaim billing.
- [ ] 8. Renderer `<PendingFetchButton>` + wiring on all surfaces (board, node
      graph ×5, video modal, references, character, style, suite).
- [ ] 9. Tests: target keys, provider handle-on-failure (timeout, download fail,
      dead job) for all three transports, `applyFetchedJob` per target, runner
      persistence-on-error. `npm run typecheck`, `npm test` (app), `npm run
      build`.
- [ ] 10. Live (needs spend approval): force one slow Higgsfield image + one video
      past the cap, Fetch each, confirm result lands in the right node/panel and
      bills once. Update `CONTEXT.md`.

## Notes / follow-ups

- Record-at-submit (rather than only on failure) would also survive an app quit
  mid-wait; it needs the target threaded into the provider call. Out of scope
  here, noted as the next deepening.
- Non-shot surfaces use a renderer-knowable key (`reference:new:<name>`,
  `character:<id|name>`, `style:<id>`, `suite`). If collisions ever matter, add a
  renderer-supplied `pendingKey` to those request types.

## Review

_(pending implementation)_

---

# Shot Sequence canvas, take 3: hide image gen; video-only shelf

User: (1) the sequence canvas should not have the image-generation node;
(2) the right shelf should keep only video generation and video editing, each
addable multiple times.

## Plan

- [x] `NodeGraphModal` gains `hiddenTools` (hide, not disable): hidden kinds are
      not rendered, not draggable, and stripped from a stored graph (the
      ensure-effect materialization filters their nodes + edges). Hiding
      "imagegen" also hides the composer prompt node that feeds it.
      (`unavailableTools` — the disable-with-hint version — was removed.)
- [x] Sequence host passes `hiddenTools={["imagegen","edit","tween","cameraGrid","upscale"]}`;
      the shelf then shows only **Video generation** + **Edit video**. The
      provider gate (`videoEditUnavailable`) still disables the edit-video tile
      when the active provider has no video-edit path, and Magic stays hidden.
- [x] Video generation is already multi-instance (drag the tile repeatedly;
      `vid0..N`).
- [ ] **Edit-video multi-instance: NOT done** — it is still a singleton in the
      data model (`graphEditVideo*` flat fields, 280 references across 19 files,
      139 in `NodeGraphModal` alone). Making it a list is the same size as the
      original "multiple video-generation nodes" migration and wants its own
      pass: `GraphEditVideoNode` + id helpers, `graphEditVideoNodes[]` +
      output node id, `migrateEditVideoNodes`, materialize/connect/merge/ports,
      pipeline record/select, `generateEditVideoNode` by nodeId + pending
      target, the modal's per-node factory/reconciliation/select/cycle/busy, and
      the workspace/host wiring. Asked the user whether to do it next.

## Review

Done and verified for (1) + the shelf restriction: `typecheck` clean, app suite
**1225 pass**, `build` clean, core 147 pass. The sequence canvas now renders no
image-generation or composer node (nor any shot-only generator), and its right
shelf lists exactly Video generation and Edit video; a stored graph that
carries any hidden node has it stripped on open. `sequence-graph.test.ts`
asserts the absence of the imagegen/composer nodes and the two-tile shelf.

(2) is half-delivered: video generation is multi-instance today; edit-video is
a single node in the data model and needs the list conversion described above.

## Follow-up: sequence canvas bugs + edit-video multi-instance

### Fixed: a second video node vanished
Root cause: the sequence host built each `seq.graph` patch as a FULL object
from its render-time `seq` closure. Adding a node writes twice in one tick
(`onGraphField({graphVideoNodes})` then the layout save), so the second write
carried a stale copy of the list and clobbered the first. Fix: the workspace
now owns `updateSequenceGraph(sequenceId, patch | (graph) => patch)`, which
evaluates an updater against the FRESHEST on-disk state (exactly like
`saveGraphShotFields` for shots), and every host callback (node field patches,
pipes, select/cycle, layout, style/brand) goes through it. Regression test:
`sequence-graph.test.ts` drops the video tool and asserts both `videogen` and
`videogen:vid1` survive. Verified: typecheck, 1226 app tests, build, core 147.

### Edit-video multi-instance (model conversion) — planned, not started
The edit-video node is a singleton (`graphEditVideo*` flat fields, ~280
references across 19 files, 138 in `NodeGraphModal`). Recommended design:
**unify it into the existing `graphVideoNodes` list** with a `mode?: "generate"
| "edit"` field (absent = generate; ids `vidN` / `evN`), reusing everything the
video list already has — per-node id scheme, materialize pairs, `mergeVideoNodes`
(by id, non-gens fields renderer-owned), per-node select/cycle/busy/pending,
output binding (`graphOutputVideoNodeId` names either mode; both produce a
clip), and `recordGraphVideoGen(shot, nodeId, …)` (works for `evN`). The flat
fields become migration-only (`migrateEditVideoNodes` folds them into an `ev0`
entry, like `migrateVideoNodes` did for the video singleton), and the canvas
nodes keep the `editvideo`/`editvideoprompt` kinds via `editVideoGenNodeId`/
`editVideoPromptNodeId` (`ev0` keeps the bare ids). `GraphSource` gains
`{ kind: "video"; nodeId }` for the edit node's source socket. The palette's
Edit-video tile appends another entry like video generation; generation routes
per mode (`onRunEditVideo(nodeId, …)`), and the sequence canvas needs a
`production:generateSequenceEditVideo` handler mirroring
`generateSequenceVideo` (borrow an anchor member shot, call
`mediaProvider.generateVideoEdit`, relocate to `out/sequences/<id>/`). The
alternative (a second `graphEditVideoNodes[]` list) duplicates the video list's
plumbing. Awaiting the user's design nod, then implementing with the full suite
as the guard.

## Review — edit-video multi-instance (model conversion)

Implemented the planned unification. The edit-video node is now a multi-instance
`graphVideoNodes` entry with `mode: "edit"` (`ev0`, `ev1`, …), with the flat
`graphEditVideo*` fields read once by `migrateEditVideoNodes` (folded into `ev0`,
output re-expressed as `videogen` + `graphOutputVideoNodeId: "ev0"`) and never
written again.

What changed:

- `shared/ipc/graph.ts`: `GraphVideoNode.mode`, `GraphSource` `{kind:"video"}`,
  and the `editVideoGenNodeId`/`editVideoPromptNodeId`/`parseEditVideo*`/
  `nextEditVideoNodeId`/`editVideoNodes` id helpers. `production.ts` flat fields
  marked `@deprecated`; `graphOutputSource`'s `"editvideo"` member noted
  migration-only.
- `main/pipeline.ts`: `migrateEditVideoNodes` (called alongside
  `migrateVideoNodes` in `migrateBoardArtwork` + `mergeRendererScenes`); dropped
  the flat media-path/scrub/rename special cases (the `graphVideoNodes[*]`
  passes now cover both modes); removed `recordGraphEditVideoGen` (callers use
  `recordGraphVideoGen(shot, nodeId, …)`).
- `shared/graph`: `materialize.ts` builds one pair per edit entry (source edge
  from `{kind:"video"|"ref"}`, output from the named node across both modes),
  `connect.ts` handles the `editvideo`/`editvideoprompt` canvas ids
  (`nodeKindForId`, `promptPipeFor`, `connectionToEdge`, `graphEdgesForDetach`),
  `ports.ts` lets `editvideo` accept `videogen`/`editvideo`/`ref`, and
  `render.ts` reads the per-node `{editvideoprompt: nodeId}` target.
- `shared/generations.ts`: edit takes are found on `graphVideoNodes` (kind
  `"video"` with the node id); `generationInUse` blocks an edit node's output
  feed and a wired source clip.
- `main/index.ts`: `generateEditVideoNode` takes `nodeId`, resolves the node's
  source, reuses the video-node pending target, and applies to the output when
  piped; new `production:generateSequenceEditVideo` (contract + `CascadeApi`).
- Renderer: `NodeGraphModal` builds one edit pair per list entry (multi add /
  remove-all / delete, per-node select/cycle/busy/pipe, prompt draft appliers);
  `ProductionWorkspace` keys edit-video busy per `shot:node` and reroutes the
  pipe through `pipeVideoToOutput`; `sequence-graph.tsx` wires `onRunEditVideo`.
- Docs: `CONTEXT.md` "Edit-video node" term, the "Shot sequences" module row,
  and the node-graph term updated to the unified list.

Tests: updated the flat-field tests to the unified list (graph-connect,
graph-materialize, productions, ref-delete, ref-rename, video-layout,
generation-delete). Added (a) `migrateEditVideoNodes` load-path migration
(`graph-migration.test.ts`), (b) a second edit-video node persists
(`sequence-graph.test.ts`), (c) per-node take cycle (`edit-video-node.test.ts`,
new). No existing assertion weakened.

Verification: `app` typecheck clean; `app` tests **1231 passed / 1 skipped** (105
files); `app` build clean; `core` tests **147 passed** (16 files).

---

# Video stills: save the paused frame as a reference (all video lightboxes)

User: when zoomed in on a video, save the frame the video is paused on as a
reference image, named `Video still_00`, `_01`, … Confirmed scope: every video
lightbox, ffmpeg exact-frame capture, `_00`-based naming (matches `Saved Ref`).

## Design (deep module + seams)

- New deep module `app/src/main/video-still.ts`: pure `videoStillName`
  (first-free `Video still_NN`, case-insensitive, starts at 00 — mirrors
  `savedRefName`) + `extractVideoStillFrame(absVideo, timeSec, deps)` behind
  the ffmpeg seam (`{ resolveBin, run }`, same shape as the thumbnail poster's
  deps). Accurate seek (`-i … -ss t`, not the poster's fast input-seek) so the
  still is the paused frame, full resolution (no 720p cap), `-q:v 2` JPEG.
- `pipeline.ts` owns reference creation (locality): async
  `saveVideoStillAsReference(p, videoRel, timeSec, deps)` validates the file is
  on disk, clamps `timeSec >= 0`, extracts, writes
  `referencesDir/<name>.jpg` (collision-suffixed), appends an image
  `CustomRef`. Imports the extractor — no cycle (video-still never imports
  pipeline).
- IPC: `saveVideoStill(productionId, videoRel, timeSec)` on `CascadeApi` +
  `production:saveVideoStill` channel (one contract entry; preload follows
  mechanically). Main handler wires the real `{ resolveFfmpeg, runFfmpeg }`
  deps, saves, emits.
- Renderer: one shared `SaveVideoStillButton` (productionId + videoRel +
  videoRef for `currentTime` + onSaved) so the five lightboxes don't duplicate
  capture logic. Each lightbox carries its video's rel in zoom state (graph
  already has `rel`; refs/boards/moodboard/outdated add it) and threads
  `onSaved → applySnapshot` through existing mutate paths (workspace `apply`
  for boards/graph/moodboard/references; `onMutate` for outdated).

## Plan

- [ ] `video-still.ts` + `pipeline.saveVideoStillAsReference` + unit test
      (`video-still.test.ts`: naming, still saved as image ref, missing file
      throws, negative time clamps — faked ffmpeg seam).
- [ ] IPC contract + channel + main handler.
- [ ] `SaveVideoStillButton` + wire into all five video lightboxes
      (references, boards, node graph, moodboard, outdated).
- [ ] `npm run typecheck`, `npm test`, `npm run build` (app); `CONTEXT.md`
      glossary touch-up if warranted.

## Review

Done. Pause any video lightbox and **Save this frame** captures exactly that
timestamp as a new `Video still_00` (`_01`, …) image reference.

What shipped:
- `main/video-still.ts` (new deep module): pure `videoStillName`
  (first-free suffix, case-insensitive, starts at 00 — mirrors `savedRefName`)
  + `extractVideoStillFrame` behind the ffmpeg seam (`{ resolveBin, run }`,
  same shape as the thumbnail poster). Accurate output-seek (`-i … -ss t`, not
  the poster's fast input-seek) at full resolution, `-q:v 2` JPEG, temp-file
  cleanup per the `video-ref.ts` convention.
- `pipeline.saveVideoStillAsReference` (async): validates the clip is on disk,
  extracts, writes `referencesDir/<name>.jpg` (collision-suffixed), appends an
  image `CustomRef` — no prompt tag, like Save-as-reference.
- IPC: `saveVideoStill(productionId, videoRel, timeSec)` + channel
  `production:saveVideoStill`; main handler wires the real
  `{ resolveFfmpeg, runFfmpeg }` deps. No schema entry needed (same as
  `saveGenerationAsReference`).
- Renderer: one shared `SaveVideoStillButton` (reads `currentTime` from the
  lightbox video, owns IPC + busy/error, stops propagation so the lightbox
  doesn't close) in all five video lightboxes — Design references, storyboard,
  node graph (incl. sequence canvas), moodboard, outdated panels. Each zoom
  state carries the clip's rel (graph ref nodes gained `mediaPath` + the
  `ref` reconciliation equality case, per the stale-node-data lesson).
- Tests: `video-still.test.ts` (6) pins naming, accurate-seek argv, negative
  clamp, no-binary rejection, the saved image ref + suffix increment, and the
  missing-file throw (faked seam, no binary needed).

Verify: `npm run typecheck` clean; `npm test` 1308 passed + 1 skipped (115
files, incl. the 6 new); `npm run build` clean with the handler in
`out/main/index.js`. Note: the running Electron main process keeps the build
it started with - a full dev restart is needed before the new IPC responds
(the known main-restart lesson).

# Chat voice input (local Whisper) + on-demand vision & screen capture

User: two chat-agent capabilities found in other agents. (1) let the model SEE
images/videos it produces to judge them (character consistency, artifacts) and
decide to redo; (2) natural voice input (stream-of-consciousness). Must not
break any existing functionality.

## Decisions (confirmed with the user)

- **Whisper delivery:** bundle the `whisper.cpp` binary in the installer
  (cross-platform seam), download the ggml model on first use.
- **Dictation UX:** click-to-toggle mic in the composer, with LIVE (rolling)
  text, committed on stop.
- **Screen capture:** agent-callable tool ONLY; captures the whole primary
  display. No composer screenshot button.
- **Vision feedback:** the model must NOT receive images automatically. It gets
  access to ALL images (MCP results, references, generated frames/clips) but
  CHOOSES what to look at by calling a tool. Generation flows must expose the
  on-disk path so the model can inspect a frame and decide to regenerate.
- **Platform:** Windows only at launch (`--win nsis`); keep the seams
  cross-platform for later.

## Non-breakage contract (applies to every item below)

- Every core change is additive with a default that reproduces today's wire:
  `ToolRunResult.modelImages` absent + `AgentConfig.visionEnabled` false =>
  byte-identical messages. No existing tool returns `modelImages`.
- Every new IPC channel is one `ipcContract` entry (preload follows
  mechanically); the `SettingsView` coverage test is updated in the same step
  that adds a settings key.
- New settings keys default to today's behavior (voice off; capture off until
  enabled).
- The microphone/capture permission handling is scoped and additive; it must
  never deny a permission the app currently gets by default.
- `electron-builder.json` changes are additive (`extraResources`, maybe
  `asarUnpack`).

---

## Part A - Voice input (local Whisper)

### A1. Deep module `app/src/main/voice.ts` (new)

Follows the `ffmpeg.ts` shape exactly (pure node, injected `run`/`resolveBin`
seam = the test surface).

- `resolveWhisperBinary()`: locate the bundled `whisper-cli`/`main` binary -
  dev from `resources/whisper/`, packaged from
  `process.resourcesPath/whisper/` (mirror `resolveFfmpeg`); null when absent.
- `whisperModelPath(model)`: `<userData>/whisper/ggml-<model>.bin`.
- `ensureWhisperModel(model, onProgress)`: if absent, download from the
  whisper.cpp HF repo, verify size/sha, write temp + atomic rename; emit
  progress. Returns the path.
- Pure helpers (unit-tested): `wavFromPcm16(pcm, sampleRate)` (build a 16 kHz
  mono PCM WAV header+data), `parseWhisperOutput(raw)` (text from `--output-*`
  / the JSON form).
- `transcribe(audio, opts, deps)`: spawn the CLI with
  `-m <model> -f <wav> --output-txt --no-prints` (or `-oj`), parse, return
  `{ text }`. deps `{ resolveBin, run }` are injected.

### A2. Renderer capture hook `useVoiceInput` (new)

- `getUserMedia({ audio })`; `AudioContext({ sampleRate: 16000 })`; an
  `AudioWorklet` (fallback `ScriptProcessor`) collects `Float32` -> `Int16`
  PCM.
- Rolling live text: every ~1.2 s send the accumulated utterance PCM to
  `voice:transcribe` (`{ samples, sampleRate, final:false }`); render the
  returned provisional text (distinct style). On stop, send `final:true` and
  commit the final text into the composer `input`.
- A single in-flight request at a time; a newer buffer supersedes a pending
  one (drop stale responses) so audio never backs up.

### A3. IPC (new fragment `shared/ipc-channels/voice.ts`, merged into `ipcContract`)

- `voice:status` (invoke) -> `{ available: boolean, model: string,
  modelReady: boolean }` (binary present + model downloaded).
- `voice:prepare` (invoke) -> ensure the model, resolve when ready; progress
  via an `onVoiceProgress` subscription if needed (hand-wired in preload like
  the other `on*`).
- `voice:transcribe` (invoke) -> `{ text, final }`.
- Main handlers wire the real deps; no domain logic in `index.ts`.

### A4. Composer wiring (`App.tsx`)

- A mic button beside Attach; visible only when `voiceEnabled` and
  `voice:status` is available. Click toggles recording; the live text streams
  into the existing `input` state; no change to `send()` semantics.
- Microphone permission: add a scoped `session.setPermissionRequestHandler`
  that allows `media` for the main window and falls through for everything
  else (additive).

### A5. Settings

- `settings.ts`: `voiceEnabled: boolean` (default false), `whisperModel:
  "tiny.en" | "base.en" | "small.en"` (default `base.en`), optional
  `voiceLanguage`.
- `SettingsView`: add the mirroring keys; add a `Voice` `SettingsSection`
  (category Tools & Integrations) and update the coverage test.

### A6. Packaging + tests

- `electron-builder.json`: `extraResources` the `whisper/` binary dir;
  `asarUnpack` if any binary sits in node_modules.
- `app/test/voice.test.ts`: WAV builder, output parser, binary resolution
  (packaged vs dev), missing-binary path, model-path naming, and a
  `transcribe` call against a fake `run` (argv assertions).

---

## Part B - On-demand vision + screen capture

### B1. Core loop - opt-in model images (`core/src`)

- `types.ts`: `ToolRunResult.modelImages?: string[]` (data URLs the MODEL
  should receive; `images` stays UI-only, unchanged).
- `AgentConfig.visionEnabled?: boolean`.
- `agent.ts`: `executeToolCall` returns `{ text, modelImages }`; in `send`,
  collect `modelImages` across the turn's tool calls, and - only when
  `visionEnabled` and the list is non-empty - push ONE synthetic `user`
  message carrying the image parts AFTER all `tool` messages are appended
  (keeps tool messages contiguous; a user-message image part is the most
  widely supported form across OpenAI-compatible endpoints, unlike images on
  the `tool` role). No tool returns `modelImages` today, so nothing else
  changes.
- `core/test`: modelImages becomes one user turn; absent => identical message
  array; `visionEnabled:false` => images dropped.

### B2. App vision tools `app/src/main/vision-tools.ts` (new deep module)

Host seam injected (the test surface). Two tools, both returning
`modelImages`:

- `view_image({ path })`: workspace-confined read (`resolveSafe`-style,
  `mustExist`), reject non-image / oversize, downscale via injected
  `nativeImage` to `<= 1024` px JPEG, return `{ text, modelImages }`. This is
  how the model looks at MCP images, references, and generated frames/clips
  (video: a still is extracted first - reuse the `video-still`/thumbnail
  seam).
- `capture_screen()`: injected `capture` seam; in production uses
  `desktopCapturer.getSources({ types: ["screen"], thumbnailSize:
  primaryDisplaySize })` in MAIN (Electron exposes `desktopCapturer` to main),
  saves the PNG under `<workspace>/cascade-images/`, returns
  `{ text, modelImages }`. `requiresApproval: true` (privacy) so it prompts
  outside autonomous mode and runs unattended inside it; a settings toggle can
  disable it outright. Fallback if thumbnails come back empty on a Windows
  setup: a `System.Drawing` PowerShell capture behind the same seam.

### B3. Model-vision gating

- Resolve the active chat model's vision flag in `ensureAgent` (via the
  existing `/models` path + `normalizeModelList`'s `vision`, memoized) and set
  `AgentConfig.visionEnabled`. Add `view_image` + `capture_screen` to
  `extraTools` ONLY when vision is enabled (and capture when the setting is
  on), so a non-vision model is never advertised tools it can't use; core also
  guards defensively.

### B4. Expose inspectable paths to the model

- `productionDigest` (production-tools.ts): add the relative frame/clip paths
  (e.g. `artworkPath`, `videoPath`) and reference `imagePath` so the model can
  call `view_image` on a generation and judge whether to redo it. Additive
  fields; update `production-tools.test.ts` snapshots.

### B5. Settings + tests + packaging

- `settings.ts` + `SettingsView`: `screenCaptureEnabled: boolean` (default
  false) owned by a section (Voice/Agent); capture approval already covers
  consent when it is on.
- `app/test/vision-tools.test.ts`: `view_image` path guard + downscale arg,
  oversize/non-image rejection, `capture_screen` writes a file and returns an
  image (both against faked seams).
- No new packaging (uses built-in Electron `desktopCapturer`).

---

## Verification (must pass before done)

- `app`: `npm run typecheck`, `npm test`, `npm run build`.
- `core`: `npm test`.
- Manual: dictate into the composer (live text + commit); ask the agent to
  generate a frame then `view_image` it and report/adjust; `capture_screen`
  prompts once (non-autonomous) and runs unattended (autonomous).

## Open risks / fallbacks

- `desktopCapturer.getSources` can return empty thumbnails on some Windows
  configurations -> PowerShell `System.Drawing` fallback behind the capture
  seam.
- Whisper streaming latency/accuracy: default `base.en`; the rolling-buffer
  approach trades a little latency for correctness, and the binary/model seam
  lets us swap engines later.
- First-run model download UX (offline/proxy): surface a clear status and let
  the user retry; the feature stays hidden until the model is ready.
- The synthetic user-message form for model images is a deliberate choice for
  provider compatibility; if Gab's models reject it, the tool-message
  content-parts form is the fallback (one localized change in `agent.ts`).

## Status

- [x] Part A (voice) - done
- [x] Part B (vision/capture) - done

---

# Review - Part B (on-demand vision + screen capture)

Shipped the model's "eyes", strictly on demand: images are only ever put in
front of the model when the model asks, and only on a vision-capable model.
Nothing is auto-included.

What shipped:
- Core (`core/src/types.ts` + `agent.ts`): `ToolRunResult.modelImages` (data
  URLs the MODEL receives, distinct from the UI-only `images`),
  `AgentConfig.visionEnabled`, and `toolImageContent()`. `executeToolCall` now
  returns `{ text, modelImages }`; `send()` collects a turn's `modelImages` and
  appends ONE synthetic `user` turn after the tool messages, gated on
  `visionEnabled`. Existing tools return no `modelImages`, so their stream is
  byte-identical.
- `main/screen-capture.ts` (new deep module): `capturePrimaryDisplay` with a
  soft-imported Electron `desktopCapturer`/`screen` and an injectable
  `CaptureDeps` seam; long-edge cap 2560; PNG data URL.
- `main/vision-tools.ts` (new deep module): `makeVisionTools(host, {capture})`
  over a `VisionHost` seam. `view_image` (workspace-confined via core
  `resolveSafe`, image-extension + 24 MB guards, downscale to the model,
  read-only) and `capture_screen` (approval-gated, saves the PNG under
  `<workspace>/cascade-images/` so the model can re-view it).
- Wiring (`index.ts`): `makeVisionHost` (real capture + `nativeImage`
  downscale/`toJPEG(82)`); `modelVisionCache` records each model's vision flag
  from `models:list`; both tools are added to a chat agent's `extraTools` only
  when the resolved model has vision (`AgentConfig.visionEnabled`), and
  `capture_screen` additionally only when `screenCaptureEnabled`.
- `productionDigest`: shots gain `artworkPath`/`videoPath`, references gain
  `imagePath` (working-folder-relative) so the model can `view_image` a
  generation and decide to regenerate.
- Settings: `screenCaptureEnabled` (default true) + a Settings → Agent
  checkbox; `settings:get/setScreenCaptureEnabled` channels; setting it
  recycles agents so the tool appears/disappears next message.

Tests: `core/test/vision-model-images.test.ts` (4: attaches on visionEnabled,
drops when disabled, no-op when a tool returns none, coalesces + orders after
tool messages) and `app/test/vision-tools.test.ts` (9: mime mapping, load,
escape rejection, non-image, missing, required path, capture gating, capture
save/return, capture failure). The settings-panel test mock gained the new
settings getter.

Verify: `core` tests **161 passed**; `app` typecheck clean, tests **1464 passed
+ 1 skipped** (129 files), build clean.

Design notes:
- The synthetic `user`-turn form (rather than images on the `tool` role) is
  deliberate: it is the most widely supported shape across OpenAI-compatible
  endpoints. If a provider rejects it, the tool-message content-parts form is a
  one-place change in `agent.ts`.
- `capture_screen` defaults ON but is approval-gated (and runs unprompted only
  in autonomous mode, the user's blanket consent); `screenCaptureEnabled` is the
  hard kill-switch. `view_image` needs no toggle and is the main "inspect my
  generation" path.
- Windows note: `desktopCapturer.getSources` can return empty thumbnails on some
  setups; the `CaptureDeps` seam leaves room for a PowerShell `System.Drawing`
  fallback without touching the tools.

## Status

- [x] Part A (voice) - done
- [x] Part B (vision/capture) - done

---

# Review - Part A (voice input, local Whisper)

Shipped the whole voice path. The composer gains a microphone button (shown only
when `voiceEnabled`), and dictation streams live text into the message box.

What shipped:
- `main/voice.ts` (new deep module, pure node): `resolveWhisperBinary`
  (override → env → packaged → dev `resources/whisper` → PATH),
  `ensureWhisperModel` (ggml download to `userData/whisper` behind an injected
  `fetchTo` seam), `pcm16ToWav`, `parseWhisperText`, `transcribeWav` (spawn
  seam), `coerceWhisperModel`.
- `shared/voice.ts` (new): `WhisperModel` + `WHISPER_MODELS` +
  `DEFAULT_WHISPER_MODEL` + `VoiceStatusIpc`/`VoiceProgressIpc`.
- `renderer/src/voice-input.ts` (new): `useVoiceInput` — `getUserMedia` +
  16 kHz `AudioContext`/`ScriptProcessor`, rolling interim transcription (one
  in-flight request, newest-wins), commit on stop, 120 s auto-stop.
- IPC: `shared/ipc-channels/voice.ts` (9 channels) + `onVoiceProgress`
  subscription; main handlers resolve app paths and persist settings; preload
  follows the contract.
- Settings: `whisperCliBinary`/`voiceEnabled`/`whisperModel` in `settings.ts` +
  a new **Voice** section (Tools & Integrations) with enable, model picker,
  status/Download, and a CLI-path override.
- Packaging: `scripts/fetch-whisper.mjs` installs `whisper-cli.exe` + DLLs into
  `resources/whisper/` (gitignored, `.gitkeep` keeps the dir);
  `electron-builder.json` `extraResources` ships it; `npm run fetch:whisper`.
- CSS: `.composer .mic` (+ `.on` pulse) and `.voice-error`.

Bug caught + fixed during verification: the model URL was wrong (`.../models/`
prefix). The converted ggml files live at the whisper.cpp HF repo ROOT
(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<size>.bin`);
a regression test now pins the exact URL. Verified live: the fetched
`whisper-cli.exe` + `ggml-tiny.en.bin` transcribed `samples/jfk.wav` with the
exact argv `transcribeWav` builds.

Tests: `test/voice.test.ts` (12). Three App test mocks gained the two new
`getVoiceEnabled`/`getVoiceStatus` stubs (partial API mocks).

Verify: `app` typecheck clean; `app` tests **1454 passed + 1 skipped** (128
files); `app` build clean; `core` tests **157 passed**.

Note (known main-restart lesson): the running Electron main keeps the build it
started with — a full `npm run dev` restart is needed before the new `voice:*`
IPC responds and the fetched binary is resolvable in dev.

## Status

- [x] Part A (voice) - done
- [ ] Part B (vision/capture) - not started

---

# Architecture hardening: one source of truth per responsibility

Source: `Cascade Architecture Review.pdf` (2026-10-12, extracted to text). The
brief: several parts of the app can describe the same state differently, then
overwrite or "heal" one another later — generated media has too many addresses
(paths in many fields), the node graph has parallel representations (ports,
views, equality, materializer, connect, merge, submit can drift), the
storyboard mirrors and the shot pipe's selected output can disagree, and
busy/queue state is inferred locally per window. Direction: incremental
migration toward a media registry, one stored graph as the canvas's sole read
path, a main-process job ledger, one selected output per shot, intent commands
instead of whole-project saves, and an ownership table with a test that fails
on unclassified fields. Rollout order: lock down today's behavior with
guardrail tests → introduce authoritative services behind compatibility layers
→ narrow write paths → retire the mirrors. Do NOT rewrite the app.

## Handoff scope (first three risk-reducing changes)

### Workstream 1 — completeness guardrails (node registration + field ownership)

- [ ] 1.1 Extract the per-type reconciliation `equal` chain from
      `NodeGraphModal.tsx` (4208–4225) into a shared pure module
      (`shared/graph/reconcile.ts`) so a test can import it; wire
      `NodeGraphModal` to it (no behavior change).
- [ ] 1.2 `shared/graph/kinds.ts`: a typed per-kind registration
      (`kind → { canvasType (nodeTypes key, incl. the documented
      `output`→`frame` alias), equality, submitChannels, structural? }`)
      consumed by `NodeGraphModal`'s `nodeTypes` keys + equality chain +
      submit dispatch where mechanical. `GraphNodeKind` stays the enum.
- [ ] 1.3 Node-registration completeness test (`app/test/node-registry.test.ts`):
      iterate every `GraphNodeKind` (derived from the type, not a hard-coded
      array — the existing 15-kind vs 13-kind drift in `graph-ports.test.ts:22`
      vs `graph-model.test.ts:58` is the bug class) and fail if any of these is
      missing: `ports.TABLE` row (`nodeDecl`), a `nodeTypes` view, an equality
      case, a `nodeKindForId` resolution for its canonical id, a materializer
      emission (fixture shot with every domain field set → `materializeGraph`
      emits the kind), a merge/normalize policy entry, and at least one
      declared submit channel.
- [ ] 1.4 `main/shot-ownership.ts`: machine-readable ownership table for
      `ProductionShot` — a `Record<keyof ProductionShot, OwnershipEntry>`
      (owner: main | renderer | command | derived | deprecated; update
      mechanism; merge behavior). Include the ~70 fields (deprecated flat
      `graphVideo*`/`graphEditVideo*` fields classified `deprecated`).
- [ ] 1.5 Ownership test (`app/test/shot-ownership.test.ts`): the compile-time
      `Record` fails the build when a new field appears unclassified; assert
      the table matches reality — `mergeRendererShot`'s DENIED set + special
      cases are generated/derived from the table (make the table the source,
      `mergeRendererShot` imports it), and every currently flow-through field
      (`audio`…`outdatedAt`, `graphOutputSource` family, node sub-fields) has
      an explicit entry.
- [ ] 1.6 Verify: `npm run typecheck`, `npm test`, `npm run build` (app).

### Workstream 2 — one selected output per shot (visible interop fix)

Today `shot.artwork`/`shot.videoPath` (storyboard/animatic/export read) and the
pipe (`graphOutputSource` + node take selections; canvas reads) are two
answers to "what is this shot showing?", kept in sync by `syncBoardOutputToPipe`
at load/save/rebase plus ad-hoc renderer mirror writes in every pipe/unpipe/
select handler (ProductionWorkspace 2519–2763, 3010–3082). Per the brief's
transitional option: keep `artwork`/`videoPath` as derived read models, written
by exactly one write-through function; arbitrary callers stop setting them.

- [ ] 2.1 `shared/selected-output.ts`: pure `resolveSelectedOutput(shot)` —
      one resolver over the pipe (imagegen/editgen/upscale/videogen/tween/ref)
      returning the current media (path, kind, source node). Unit-test every
      branch (the acceptance matrix: canvas select → storyboard, storyboard
      promote → canvas, export uses the same).
- [ ] 2.2 Main-side single write-through (`pipeline.ts`):
      `setShotSelectedOutput(shot, selection)` = the ONE function that updates
      the pipe fields AND re-derives `artwork`/`videoPath` (via
      `syncBoardOutputToPipe`, which stays as the derive step). `selectBoardFrame`,
      `recordBoardEdit`, `applyVideoOutput`, `applyRefToOutput`,
      `hookImageGenToOutput`, `hookVideoGenToOutput`, `unstitchTween`,
      `deleteReference`, `replaceVideoGenTake`, `importBoard*` route through it.
- [ ] 2.3 New command `production:selectGraphTake` (IPC contract entry): a
      narrow selection command (shot id + node kind/id + take index, or ref id)
      used by canvas select/cycle AND storyboard promote/history-browse —
      validates, calls `setShotSelectedOutput`, returns the updated production.
- [ ] 2.4 Renderer: strip the ad-hoc `artwork`/`videoPath` mirror writes from
      `pipeImageToOutput`/`pipeRefToOutput`/`pipeVideoToOutput`/`pipeTweenToOutput`/
      `pipeEditToOutput`/`pipeUpscaleToOutput`/`unpipe*`/`selectGraphGen`/
      `cycleGraphGen` — they patch pipe fields only; mirrors arrive from main
      (via the returned production). Canvas output preview and any renderer
      resolver read `resolveSelectedOutput`.
- [ ] 2.5 Tests: canvas select older take → storyboard shows it immediately
      (and vice versa); stale renderer save cannot clobber the selection;
      `boardFrameHistory`/promote still correct; export (`assemblyPlan`) uses
      exactly the shown output; reload + reopen agree. E2E fixture: generate →
      select → save → reload → export.
- [ ] 2.6 Verify: `npm run typecheck`, `npm test`, `npm run build` (app).

### Workstream 3 — main-process job ledger (authoritative busy state)

Today busy state is React-local per window (`genQueue`, busy Sets), cleared by
promise resolution; main's `enqueueGeneration`/`generationQueues` chains are
invisible; the detached window only sees a peer-published `CanvasBusySnapshot`
relay that misses every non-canvas surface and can't recover a missed
completion. A window opened mid-generation shows nothing running.

- [ ] 3.1 `main/jobs.ts`: deep module — `createJobLedger()` with a job record
      `{ id, productionId, shotId?, nodeId?, kind, state: queued|running|
      succeeded|failed, attempts, startedAt/finishedAt, result?, error? }`,
      `beginJob`/`finishJob`/`failJob`, `snapshot(productionId)`, and a
      subscription emitter. Wrapped around the existing runners
      (`runProductionStep`, `runProductionJob`, `runVideoJob`, recheck flows,
      magic-prompt batches) so every real generation gets a record — no change
      to scheduling.
- [ ] 3.2 IPC: `production:jobsSnapshot` (invoke) + `production:jobsChanged`
      (send, broadcast to ALL windows — not `safeSend` to the main window
      only); the detached window requests the snapshot on
      `did-finish-load`/open, then listens.
- [ ] 3.3 Renderer: node/storyboard busy display = union of ledger `queued|
      running` jobs for the production + the local `GenerationQueue` (UI
      serialization stays renderer-side for now); remove reliance on
      `canvas:busyChanged` peer mirroring for real jobs (keep the channel as a
      fallback until all surfaces read the ledger).
- [ ] 3.4 Crash reconciliation: a persisted ledger file (userData, per
      production) so a `running` job at startup becomes `interrupted` and
      surfaces as a visible recoverable state (paired with the existing
      `pendingImageGen`/`pendingVideoGen` recheck affordances) — no indefinite
      spinner, no silent drop.
- [ ] 3.5 Tests (`app/test/job-ledger.test.ts` + wiring): reopen
      mid-generation shows the current state; both windows agree without
      renderer-to-renderer mirroring; completion clears both; a lost
      completion event cannot leave a spinner (snapshot on subscribe);
      crash-after-provider-return reconciles. Also pin the "no indefinite
      spinner" invariant: every non-terminal job either exists in the ledger
      or is in a visible recovery state.
- [ ] 3.6 Verify: `npm run typecheck`, `npm test`, `npm run build` (app);
      full restart of the packaged/dev app before testing (main-process
      change).

### Regression scenario to keep permanently (added in 2.5/3.5)

Open a project in the main and detached windows. Start a generation, edit a
prompt, move a node, and reorder the storyboard before the generation
completes. Then select the new result, save, close, reopen, and export. The
same output, graph layout, prompt, order, and terminal job state must appear
everywhere. Success looks boring: a completed generation remains selected,
every surface agrees, and unrelated edits cannot make it disappear.

## Deferred (per the rollout plan — Phase 4 active, the finale)

- Phase 4: retire mirrored `artwork`/`videoPath` writes, convert
  `syncBoardOutputToPipe` to one-time migration, shrink `applyRendererState`
  to legacy import, remove renderer queue state duplication. Plus the
  remainder: entity-revision conflict gating (stale-delete rejection),
  idempotency pins for the intent commands.

---

# Phase 4: retire the compatibility code

End state: the node pipe is the only writer of "what a shot shows";
`artwork`/`videoPath` survive only as the ref-output store (a ref-piped
frame has no node history to live in) plus the legacy read for unpiped
classic docs. Every surface resolves through the shared resolver instead
of hand-reading mirrors.

## Plan

- [ ] 4.1 Shared reader: `resolveShotDisplay(shot)` — pipe set → live pipe
      resolution (`resolveSelectedOutput` + feed still); pipe unset →
      legacy mirrors (classic docs + existing fixtures keep working).
      Switch readers: storyboard card, `boardFrameHistory` current entry,
      animatic projection, `assemblyPlan`, outdated panels, thumbnail guard,
      `generationInUse` output check, `chainSourceForEdit`, ref-refresh
      target, `replaceVideoGenTake` dead write.
- [ ] 4.2 Writers stop: `setShotSelectedOutput` sets pipe fields only;
      `applyVideoOutput` loses its pin/backfill (clip lives in history,
      still resolves from the feed); `production:applyGraphOutput` video
      branch becomes validate+bind; ref-import paths keep recording their
      rendered frame (their only take store); renderer drops mirror patches
      from ALL pipe/unpipe/select handlers; `deleteReference`/`removeVideo`
      go through the pipe (no mirror surgery).
- [ ] 4.3 `syncBoardOutputToPipe` → one-time migration only (kept in
      `migrateBoardArtwork`); removed from merge, rebase, and the
      write-through. `mergeRendererShot` drops the explicit-null
      artwork/videoPath branches (renderer stops sending them).
- [ ] 4.4 Queue-state removal: drop the `canvas:busyChanged` peer publish +
      main relay (the ledger drives both windows); keep the contract entry.
- [ ] 4.5 Entity revisions: optional `baseRev` on destructive structural
      commands (`deleteShot`, `reorderShot`, `removeOutdatedShot`) — mismatch
      rejects with the fresh rev (recoverable conflict); idempotency pins
      (repeat a command after an uncertain response → same document) for
      layout/select/text/reorder/insert/delete.
- [ ] 4.6 Shrink `applyRendererState` to the legacy boundary (dead mirror
      branches removed; documented), full census of the remaining whole-doc
      surface.
- [ ] 4.7 Tests + verify (`typecheck`, `test`, `build`), `CONTEXT.md`, review.

## Review

Done — the compatibility layer is retired. The node pipe is the only writer
of "what a shot shows"; `artwork`/`videoPath` survive only as the ref-output
store (a ref-piped frame has no node history to live in) plus the legacy read
for unpiped classic docs.

**Readers (4.1).** New shared `resolveShotDisplay(shot)` — pipe set → live
pipe resolution (clip + feed still); pipe unset → legacy mirrors. Switched:
`boardFrameHistory` (current entry via display), storyboard card (frame/
clip/badge/lightbox/zoom/menus/video-modal all display-resolved), outdated
panels, animatic/export projection fill (`applyShotSequences` shot items +
sequence posters), `assemblyPlan` per-shot events, thumbnail + full-image
guards, `generationInUse` output check, `chainSourceForEdit`,
`useShotAsStyleFrame`, classic/edit-video submit fallbacks, sequence member
frame refs, canvas output preview (`buildDerived`), node source-frame
fallbacks, zoom navigation, external-edit matching, boards-done count,
`videoUrl`.

**Writers stop (4.2).** `setShotSelectedOutput` sets pipe fields only;
`applyVideoOutput` deleted (6 call sites: validate+bind for
`applyGraphOutput`, nothing elsewhere — the recorded take + bind resolve);
`hookImageGenToOutput` backfill, `replaceVideoGenTake` mirror re-point, and
`production:removeVideo`'s mirror delete all removed (removeVideo unlinks via
the service + unbinds video pipes through the write-through); renderer
dropped mirror patches from ALL pipe/unpipe/select/delete gestures (pipe
fields only — the display updates optimistically from the pipe itself).

**Migration-only sync + merge cleanup (4.3).** `syncBoardOutputToPipe`
removed from the merge, the job rebase, and the write-through; kept in
`migrateBoardArtwork` only (docstring says so). `mergeRendererShot` dropped
the explicit-null artwork/videoPath branches + the legacy editvideo
ride-through; `artwork`/`videoPath` flipped to command-owned + denied in the
ownership table (the derived skip set follows automatically).

**Queue-state removal (4.4).** Deleted the `canvas:busyChanged` peer publish
effect + the main relay (+ `lastMainCanvasBusy` + `remoteCanvasBusy` state);
the union is ledger-only. Legacy channel entries stay for the contract guard.

**Revisions + idempotency (4.5).** `assertFreshRevision` (pure, in
productions.ts) gates `mutateShots(id, mutate, baseRev?)`; destructive
structural commands take an optional trailing `baseRev` (`deleteShot`,
`reorderShot`, `removeOutdatedShot`, `deleteShotSequence`) — mismatch throws
naming the fresh rev, and the renderer's `apply` refreshes to the fresh
document on conflict (recoverable, never silent). Deletes are idempotent
no-ops when already gone (`shotter.removeShotById`, outdated/sequence
presence checks); `insertShotAt` takes a caller id (renderer passes
`uid("shot")`) so a retry returns the existing shot; layout/select/reorder
repeats pinned as fixed points. Schema validators cover the new args.

**applyRendererState (4.6).** Shrunk to the legacy boundary: mirror branches
gone, docstrings updated. Remaining whole-doc surface (by grep census):
51 `saveField` (design/admin fields), ~23 `saveGraphShotFields` (node
wiring/prompts/membership), 30 `onGraphField` (graph object), 6 direct
saves — full removal waits on edge/node commands, now explicitly out of
scope.

**Tests.** Converted ~40 mirror assertions to display assertions across
pipeline/productions/selected-output/assembly/board-history/board-frames/
tween/shot-table; new: layout repeat + select repeat + insert/reorder/delete
idempotency + `assertFreshRevision` accept/reject + reorder-vs-stale-layout
race + unknown-future-node survival + load guarantee. Two self-caught
during the pass: the primary is excluded from history by design (my first
history expectation was wrong), and rapid same-millisecond generation
timestamps tie in sort order (stable node order wins — deterministic, not
flaky).

Verify: `app` typecheck clean; `app` tests **1559 passed + 1 skipped** (138
files); `app` build clean. `core` untouched. Main-process + IPC change —
fully rebuild AND restart the app before testing.

---

# Phase 3: narrow the write paths + stored graph as the sole canvas read

Inventory (whole-document save census, renderer side): 51 `saveField(`
call sites (styles, references, characters, categories, brand, VO/music
volumes, animatic config, sequences, scenes), 23 `saveGraphShotFields(` (shot
pipes, node wiring/prompts, tween edits — selection/pipe now mostly
commands), 30 `onGraphField(` (graph object + node params/prompts/wiring/
membership), 6 direct `saveProduction(` calls. Already commands before this
pass: `updateBoardPrompt`, `selectGraphTake`, `updateShot` (shot audio/visual
text), `reorderShot`/`insertShot`/`deleteShot`, all generation submits.

## Plan

- [ ] 3.1 Inventory whole-doc saves + the canvas's inline materialize
      fallbacks.
- [ ] 3.2 `production:updateGraphLayout` — per-key layout merge (concurrent
      moves of different nodes fold together; node deletes named explicitly
      via `remove` so a stale snapshot can't delete by absence), shared merge
      in `shared/graph/layout.ts` (renderer optimistic apply + main handler
      compute the same next layout), schema-validated payload, renderer
      `saveGraphLayout` routes through it (one save per drag gesture, as
      before).
- [ ] 3.3 Race test: fresh storyboard reorder + stale whole-doc layout save
      → order keeps, layout edit still lands.
- [ ] 3.4 Stored graph as the sole canvas read: `ensureShotGraphs` runs the
      flag→graph normalization for every shot lacking wiring at load (both
      load paths — scenes, outdated bucket, sequence facades, so shots
      created after their document's migration are covered); the modal's
      open-time normalized graph is the single derivation shared by all
      connect/detach handlers (inline per-handler re-materialization
      removed); unknown future nodes + their wiring survive normalization
      unvalidated (normalize keeps unknown-kind edges; `migrateShotGraph`
      carries the nodes) instead of being dropped.
- [ ] 3.5 Tests: layout merge (fold/remove/viewport/empty), payload
      validation, reorder-vs-stale-layout race, load guarantee (v3 graphless
      shot gains a graph; second load a fixed point), unknown future node
      survival.
- [ ] 3.6 Verify: `npm run typecheck`, `npm test`, `npm run build`;
      `CONTEXT.md` rows; census recorded here.

## Review

Done.

- `shared/graph/layout.ts`: `mergeGraphLayoutPatch` — per-key fold of
  positions/sizes/collapsed, explicit `remove` ids, outright viewport
  replace, absent sections untouched. Read by both the main
  `production:updateGraphLayout` handler and the renderer's optimistic apply,
  so the two compute the same next layout. Payload validated at the IPC
  boundary (`updateGraphLayout` schema entry: finite coordinates, key length
  caps, viewport shape, string-array `remove`).
- The renderer's `saveGraphLayout` is now async-with-applySnapshot (same as
  the selection command): optimistic per-key apply, then the authoritative
  returned snapshot. Node deletes send their removed ids (the modal's
  drag-end save names them) — a stale snapshot that merely lacks a node can
  never delete it. Sequence-canvas layouts stay whole-doc via `onGraphField`
  (out of scope).
- Stored graph: `ensureShotGraphs(p)` fills missing wiring for scene shots,
  outdated shots, and sequence facades on every load (both paths, on the
  cached doc before the clone); the seven inline `?? materializeGraph`
  fallbacks in `NodeGraphModal` collapsed onto the one open-time normalized
  graph (`fallbackGraph`), which is null-branch-free for every loaded
  document; unknown future nodes/edges carried through `migrateShotGraph`
  and kept unvalidated by `normalizeGraph`.
- Race test: a fresh reorder survives a stale whole-doc save that still
  applies its layout edit (main owns structure, renderer owns layout).

Known remainder (Phase 4): edge/node add/delete commands, entity-revision
conflict gating (explicit stale-delete rejection), retiring the
`artwork`/`videoPath` mirrors + `syncBoardOutputToPipe`-as-migration, and
the remaining whole-doc save surface above.

Verify: `app` typecheck clean; `app` tests **1552 passed + 1 skipped** (138
files; +6 graph-commands, +2 graph-migration, +1 productions race);
`app` build clean. `core` untouched. Main-process change — fully restart
the app before testing.

## Review

Done — all three starter workstreams landed, verified by typecheck + tests +
build at each step.

**WS1 — completeness guardrails.**
- `shared/graph/reconcile.ts` + `shared/graph/kinds.ts`: the reconciliation
  equality chain extracted verbatim from `NodeGraphModal` (per-canvas-type
  rules + the unknown-type EQUAL fallback — the historical default), plus a
  declarative `NODE_KIND_REGISTRY` per kind (canvas type incl. the
  `output`→`frame` alias, shot state field, submit channels, canonical ids).
  `NodeGraphModal`'s reconciliation now calls `nodeDataEqual` instead of its
  inline `else if` chain.
- `main/shot-ownership.ts`: every `ProductionShot` field classified
  (owner × merge rule); the compile-time `Record<keyof ProductionShot, …>`
  fails the build on an unclassified field. `mergeRendererShot`'s DENIED set
  is now derived from the table (`SHOT_MERGE_DENIED_FIELDS` ∪
  `SHOT_INDEX_FIELDS`) — the table and the merge can't drift. The derived set
  adds three fields the renderer never writes (`graphTweenReencoded`,
  `outdated`, `outdatedAt`) — a stale whole-document save can no longer
  overwrite them (grep-verified the renderer only reads them).
- `node-registry.test.ts` (7) iterates every kind: ports row, node view,
  equality rule, `nodeKindForId` resolution per canonical id, materializer
  emission from a fully-loaded fixture, ownership classification of each
  kind's state field, and submit channels that exist in the live
  `ipcContract`. `shot-ownership.test.ts` (6) pins the classify-everything
  contract, the deny/index buckets, and an end-to-end
  stale-save-cannot-overwrite-main-owned-state case.

**WS2 — one selected output per shot.**
- `shared/selected-output.ts`: `resolveSelectedOutput(shot)` — the one
  resolver over the pipe (imagegen/editgen/upscale/videogen/tween/ref),
  shared by renderer and main.
- `pipeline.ts`: `setShotSelectedOutput(shot, sel)` — the single write-through
  for the pipe + `artwork`/`videoPath` mirrors (derives via
  `syncBoardOutputToPipe`, which now resolves through the shared resolver).
  `selectBoardFrame`, `recordBoardEdit`, `hookImageGenToOutput`,
  `hookVideoGenToOutput`, `unstitchTween`, `applyRefToOutput`,
  `importBoardDataUrl`, `importBoardVideo`, and the classic `generateVideo`
  flow all land there; the renderer's pipe/unpipe/select handlers dropped
  their hand-written mirror logic (optimistic mirrors derive from the shared
  resolver; main re-derives authoritatively on every save).
- New `production:selectGraphTake` command (contract + schema validator +
  preload + handler): storyboard Make Primary (`{path}`), canvas take
  select/cycle (`{kind, nodeId, index}` — index moves, mirrors re-derive only
  when the node feeds the output), and canvas unpipe (`{kind:"unpipe"}`) now
  share one main-side write-through; both surfaces apply the returned
  production.
- `selected-output.test.ts` (14): every resolver branch, every write-through
  kind, canvas↔storyboard interop (select → storyboard mirror, promote →
  fixed point), and the end-to-end regression (generation lands mid-session →
  selection → stale whole-document save → merge keeps selection → export
  resolves the shown output).

**WS3 — main-process job ledger.**
- `main/jobs.ts` (`createJobLedger`, injected persist/load/now/newId seams) +
  `shared/ipc/jobs.ts` (`JobRecord`/`JobSnapshot`, `jobForChannel`,
  `jobLabel`, `jobsToCanvasBusy`). The `handle()` IPC wrapper records every
  generation channel's job — begin on invoke, succeed/fail with the result —
  so a generation cannot ship without a job record and no call site had to
  opt in (29 runner call sites untouched).
- `production:jobsSnapshot` (invoke) + `production:jobsChanged` (send,
  broadcast to ALL windows, not just the main one). Non-terminal jobs persist
  to `userData/jobs.json`; on startup a job that was running at crash time is
  marked `interrupted` — a visible terminal state pairing with the existing
  pending/recheck affordances, never an indefinite spinner.
- Renderer: fetches the snapshot on open + subscribes; the canvas busy
  display is now the union of the ledger's running jobs + the local
  `GenerationQueue` + the legacy `canvas:busyChanged` peer snapshot (the
  peer relay stays as a fallback), so the main and detached windows agree
  from the ledger alone — the storyboard cards ride the same union through
  the existing derived sets.
- `job-ledger.test.ts` (11): lifecycle, per-production snapshots, failure
  reasons, unsubscribe, terminal window, crash → interrupted → dismiss,
  persist-only-running, the full channel map, and the canvas projection both
  windows compute identically.

**Known residuals (documented, deferred per the rollout plan):**
- The same-arrays `takeGenIndex` rule still lets a whole-document save that
  was captured before a command selection move the index back when the
  histories agree (the diverged-histories case is fixed — fresh wins). Node
  take selections on the sequence canvas still ride whole-document saves, so
  the index rule can't blanket-flip yet — this is Phase 3's entity-revision
  work.
- `syncBoardOutputToPipe` remains the recurring derive step (load/save/
  rebase); converting it to one-time migration and retiring the mirrors is
  Phase 4.
- Agent-tool-driven generations (the `ipcListeners` host path) bypass the
  IPC wrapper and aren't ledger-recorded; the media registry (Phase 2) will
  be the place to unify that too.
- Workflow guardrail: the new IPC handlers (`production:selectGraphTake`,
  `production:jobsSnapshot`/`jobsChanged`) and the `handle()` wrapper are
  main-process changes — fully rebuild AND restart the app before testing.

### Follow-up (user feedback)

**Startup crash — fixed.** The contract-drift guard at the end of
`registerIpc` throws when any declared channel has no handler, and
`production:jobsChanged` (a main→renderer broadcast the renderer subscribes
to in preload, never sends on) had none — so the app died at startup with
"declared in the contract but has no handler". Fixed with the
pattern-consistent no-op `on("production:jobsChanged", () => {})`
registration (every other main→renderer send channel has one); the guard now
passes and the bundle carries the registration.

**Legacy projects — verified, no conversion needed.** No persisted shape
changed across the three workstreams (`PRODUCTION_SCHEMA_VERSION` stays 3,
all migrations untouched), so legacy documents keep opening through the
existing on-load normalization (the brief's migration principle: normalize
on load, write the new model on save). Added
`productions.test.ts` → "legacy project end-to-end": a schema-v2 project
(flat `graphVideo*` fields, artwork history, pending contingency, classic
unpiped shot) opens and migrates to `vid0` + derived mirrors, survives a
stale whole-document renderer save, accepts a promote through the new
selection write-through, reopens identically (fixed point), and the export
resolves exactly the shown output. A project from ANY older version is
covered by the existing v1/unversioned migration tests plus this v2
end-to-end case — if a doc is somehow too old (below the minimum), it fails
loudly with the version named, per the existing guard.

Verify (follow-up): `app` typecheck clean; `app` tests **1528 passed + 1
skipped** (136 files); `app` build clean (the `jobsChanged` registration is
in the main bundle).

---

# Media registry: one stable ID per media file, one move/delete service

Brief recommendation 1 (rollout Phase 2): a generated frame or clip should
keep the same identity even if its file is moved, renamed, or adopted from a
temporary generation directory. Transitional form (per the rollout's
"introduce authorities behind compatibility layers"): path fields stay the
transport for now — the registry adds stable identity, lifecycle state
(present/missing/deleted), and ONE adoption/move/delete service, so the
path-patch lists and unlinks stop being hand-rolled per flow. Phase 4 later
swaps fields to media ids and reads them through the registry.

## Plan

- [ ] 2a.1 `shared/media-registry.ts` (pure): `MediaEntry
      {id, path, kind, origin, state}` + `normalizeMediaRegistry`
      (dedupe by path, drop terminal `deleted`, keep `missing`) +
      pure helpers (`entryForPath`, `markMissing`). `Production.media?`
      additive field.
- [ ] 2a.2 `main/media.ts`: `createMediaService` — `register(p, rel, kind,
      origin)` (upsert by path, stable id), `move(p, fromRel, toRel)` (fs
      rename + registry re-point; null on failure — an interrupted move
      leaves the old state recoverable), `remove(p, rel)` (unlink + state),
      `markMissing(p, rel)`, `relocatePrefix(p, fromPrefix, toPrefix)`
      (folder renames follow via prefix rewrite). Main-owned:
      `applyRendererState` fresh-wins `media` like `promptOverrides`; read
      repair on load/save.
- [ ] 2a.3 Wire the file-write choke points to register: `writeBoardFrame`,
      `writeShotVideo`, `writeStyleFrame`, `importBoardDataUrl/Video`,
      `saveGenerationAsReference`, `saveVideoStillAsReference`,
      camera-grid cutout.
- [ ] 2a.4 Wire the movers/deleters through the service:
      `relocateBoardsForRenumber`, `archiveShotsToOutdated`,
      `restoreOutdatedShot`, `relocateClipToSequence`, the legacy
      `relocateBoardLayout`/`relocateVideoLayout` migrations,
      `deleteGeneration` unlink, `production:removeVideo`,
      `refreshBoardLinks` re-point.
- [ ] 2a.5 Missing state surfaces: mark `missing` when a thumbnail/image
      probe finds the file gone; the storyboard card shows an explicit
      "Missing file" badge instead of a blank frame.
- [ ] 2a.6 Ownership tie-in: derive `mergeRendererShot`'s special-case skip
      list from the ownership table (`SHOT_SPECIAL_FIELDS`) so the merge and
      the table can't drift; extend the ownership test.
- [ ] 2a.7 Tests: `media-registry.test.ts` (pure) + `media-service.test.ts`
      (temp-fs moves/removes, interrupted move recoverable, prefix rewrite)
      + productions merge (media main-owned) + movers keep the registry in
      sync + delete-in-use still blocked.
- [ ] 2a.8 Verify: `npm run typecheck`, `npm test`, `npm run build`;
      `CONTEXT.md` row; full app restart (main-process change).

## Review

Done — the transitional media registry landed (brief recommendation 1,
rollout Phase 2a): stable identity + lifecycle state behind ONE file service,
with path fields still the transport until Phase 4 swaps them to ids.

- `shared/media-registry.ts` (pure): `MediaEntry {id, path, kind, origin,
  state}`, `normalizeMediaRegistry` (dedupe by path, drop terminal
  `deleted`), `mediaEntryForPath`, `upsertMediaEntry`, `remapMediaPaths`,
  `mediaKindForRel`. `Production.media?` is the additive field (older
  documents open with an empty registry; it fills on the first load).
- `main/media.ts`: `createMediaService(resolveAbs)` — the ONE door for
  files: `register` (idempotent per path; the brief's "register a result
  before exposing it"), `moveFile` (fs rename + registry re-point; null on
  failure so an interrupted adoption leaves the old path + registry intact —
  recoverable, never a broken published path), `removeFile` (unlink +
  terminal `deleted` state), `markMissing`, `remapPaths` (folder-level moves
  follow), `bootstrap` (load-time: upsert every referenced path,
  present/missing from disk, prune unreferenced entries). Wired in
  `pipeline.ts` as the `mediaFiles` singleton over the realpath-verified
  `assetPath`.
- Write choke points register: `writeBoardFrame`, `writeShotVideo`,
  `writeSequenceVideo`, `writeStyleFrame`, `importBoardDataUrl/Video`,
  `saveGenerationAsReference`, camera-grid sheet generation + panel cutouts.
  Movers/deleters ride the service: `relocateClipToSequence`,
  `moveShotMediaDir` (outdated archive/restore), `relocateBoardsForRenumber`
  (registry follows only paths that actually landed), the legacy
  `relocateBoardLayout`/`relocateVideoLayout` migrations, `deleteGeneration`,
  `removeOutdatedShot`, `production:removeVideo`.
- Missing state: `loadProduction` bootstraps the registry (present/missing
  from disk, stable ids — bootstrapped on the cached doc before the clone);
  the storyboard card shows an explicit **"missing file"** badge instead of
  a silently blank frame. The registry is main-owned (`applyRendererState`
  fresh-wins, like `promptOverrides`).
- Ownership tie-in: `SHOT_SPECIAL_FIELDS` now derives the merge's special-
  case skip list from the ownership table (the two can't drift).

Tests: `media-registry.test.ts` (14: pure helpers + service + interrupted
move + bootstrap + outdated/renumber keep the registry in lockstep — a moved
file still resolves from storyboard/canvas/history), `productions.test.ts`
(+2: registry main-owned over a stale renderer save; load bootstrap present/
missing), `shot-ownership.test.ts` (+1: the derived special set).

Verify: `app` typecheck clean; `app` tests **1543 passed + 1 skipped** (137
files); `app` build clean. `core` untouched. Main-process change — fully
restart the app before testing.

**Known residual:** the registry is transitional — fields still store paths
(Phase 4 swaps them to media ids). Registration covers the generation/import/
adoption flows; files written by raw provider download paths still land in
the registry via their write choke points (`writeBoardFrame`/`writeShotVideo`
are every provider's finish line). Suite outputs (Image Suite) live outside
production fields and aren't registered yet.

---

# Stale pending badge fix (shot 0200, 0000_Co-Mo Santa Tests)

- [x] Diagnose: badge = `shot.pendingImageGen` stamped 2026-10-14T19:04Z;
  ledger + two later billed takes (19:05/19:30) proved superseded-success
  runs never cleared it; probe test reproduced against real provider.
- [x] Fix: supersede clears now notify the persistence sink even when the
  run never records its own pending — `openart.ts` image + video,
  `openart-cli.ts` + `higgsfield-cli.ts` image/video/edit.
- [x] Regression tests in `openart.test.ts` (sync image + sync video); full
  gate 1942 passed; `npm run build` clean. Existing stale record on 0200
  clears via right-click "Clear pending frame", a Recheck, or the next
  generation on that shot (now fixed path).

---

# Image Suite bug batch (wrong prompt / edit style / style desync / Edit in Suite / tag scroll)

- [x] 1. Wrong prompt displayed: a finished generation became the selection
      without re-syncing the draft, and `selectEntry` leaked the previous
      draft's absent optionals. New pure `draftFromSuiteEntry` exact replay,
      used on select, generation completion, and finished recheck.
      `suite-prompt-display.test.ts` (select another entry mid-generation,
      then the result shows its request prompt) + pure replay cases in
      `suite.test.ts`.
- [x] 2. Edit prompts inherited Generate's Style paragraph (shared draft)
      with no dropdown to remove it. `suiteDraftForMode` strips paragraph +
      pick on every path into Edit (tab, seed, replay, restore); submit
      strips again as the last gate. Pinned in `suite-ui` / `suite-style` /
      `suite-prompt-display` tests.
- [x] 3. Style dropdown read only `styleId` while the paragraph carried the
      applied text (handoff seeds also dropped `styleId`). Dropdown now
      derives from the applied text (`suiteStyleSelectValue`); unowned text
      shows removable Custom, never a false None; `reconcileSuiteDraftStyle`
      repairs the stored pick toward the text.
- [x] 4. "Edit in Suite" could land on the wrong image: a stale persisted
      `sourceRefId` shadowed the seed's `sourcePath` in picker/canvas/
      submit. `applySuiteSeed` makes the seed's source (and style)
      authoritative and mutually exclusive. Opening the suite also really
      closes the graph/sequence canvas (`suite-open-workspace.test.ts` —
      leaving the suite no longer resurrects the graph).
- [x] 5. The @ tag autocomplete (the one list behind the side panel, node
      graph, and Image Suite) moved its highlight without scrolling.
      `ReferencePromptEditor` now scrolls the highlighted tag into view on
      selection change (`prompt-autocomplete-caret.test.ts`).

## Review

Verify: app `npm test` (typecheck + 2011 passed, 2 skipped), core
typecheck + 199 tests, `npm run build` clean. Not run live in Electron:
a real vendor generation round-trip and pixel-level tag-list scrolling
(jsdom pins the `scrollIntoView` call, not real scrolling).

## 2026-10-29 - Bug batch (import button / oversize downsample / 720p video checkbox)

- [x] Item 1: design-page reference import button - NOT REPRODUCED (jsdom probe: click calls picker and saves; design and moodboard share RefFigure + attachRefArtwork). Reported, moved on.
- [ ] Item 2: oversize (>15MB) image import popup + convert-to-JPEG (main image-downsample module + picker dialog + renderer drop guards + tests).
- [ ] Item 3: Downsample reference video to 720p checkbox on video nodes (not Genjutsu).


### Review (2026-10-29 bug batch)

- Item 1: NOT REPRODUCED. Design and moodboard tiles are the same RefFigure + attachRefArtwork + pickReferenceImage; a jsdom probe clicking the design import button called the picker and saved imagePath. No code change; probe removed. Needs repro steps (which card/state?) to proceed.
- Item 2: DONE. Shared limit+copy in src/shared/image-import.ts; main shrink ladder in src/main/image-downsample.ts (nativeImage seam); native popup in production:pickReferenceImage; production:downsampleImage IPC for drops/pastes via renderer helper components/production/image-downsample.ts + confirm popup at all five guards + category/graph drops. Tests: image-downsample.test.ts (7), oversize-image-import.test.ts (3).
- Item 3: DONE. GraphVideoNode.downsampleVideoRefs; checkbox on videogen + edit-video nodes only (never Genjutsu; hidden on sequence canvas); main proactive720pSwaps reuses create720pReference + existing swap application; only proven >720p inputs swap; failures stop the submission. Tests: video-retry.test.ts additions (4), video-node-downsample.test.ts (2).
- Gate: tsc clean; full vitest 1995 passed / 2 skipped; 2 files failed to COLLECT with sandbox EPERM realpath (prompt-focus-switch, tween) and both pass alone (6/6, 48/48) - environmental, no assertion failures.

# Assembly page: placeholder slate holds layout before first render (Item 1, 2026-11-09)

- [x] `AssemblyPanel` always occupies the video grid slot: a blank
      `prod-assembly-placeholder` slate (same `prod-assembly-render` sizing
      class + aspect-ratio from stored render dims, else the selected
      resolution) renders until a `renderPath` exists; the player carries
      the same aspect-ratio, so the config card never shifts when the MP4
      lands. Raised by Chuck 2026-11-05.
- [x] Test: `app/test/assembly-panel.test.ts` (placeholder present/slot/size
      before render; replaced by the player after).
- [x] Verify: focused test + tsc clean; full suite 2416 passed / 1 failed
      (pre-existing `group` guard) / 15 skipped; build clean. Live built-app
      probe (seeded production, two launches): placeholder 518x291.375 at
      (224,206), card at (758,206); after adding a render the video box was
      identical and the card did not move.

---

# Ctrl+Mouse Wheel zoom in all views, panel-aware

Ask: Ctrl+wheel zooms every view; over a panel with its own zoom control
(e.g. Design reference categories) it zooms only that panel within its
existing range; elsewhere it applies the page zoom. It must not scroll
while zooming; plain wheel is unchanged.

- [x] Inventory: page zoom = Electron zoom level (Ctrl+=/-/0 in main,
      ±5). Slider zooms with no wheel handling: Script zoom (80–180),
      Storyboard frame size (180–440), per-category reference tile size
      (80–320). Wheel-owning canvases already zooming themselves with
      `preventDefault`: moodboard (0.1–8), timeline (0.25–40), media
      lightbox (1–8), node graph (React Flow, min 0.2). Design "Panel
      width" is a width, not a zoom — left to the page zoom.
- [x] Tests first (red: missing module / conditional-panel case):
      `app/test/ctrl-wheel-zoom.test.ts` (12) — panel-only zoom with
      clamping on the real `ReferenceCategorySection`, page fallback,
      nested wheel-owning canvas, plain-wheel passthrough, IPC contract
      + validator, page-level clamp.
- [x] `components/common/ctrl-wheel-zoom.ts`: `useCtrlWheelZoom`
      (callback-ref zone claim: preventDefault + stopPropagation,
      `defaultPrevented` guard) and `installCtrlWheelPageZoom`
      (window bubble-phase fallback, installed once in `main.tsx`).
- [x] Page zoom IPC: `zoomPageBy` (`window:zoomPageBy`, send) +
      finite-number validator + `nextPageZoomLevel` shared range; main
      steps the sender window and emits `zoom:changed`; keyboard zoom
      reuses the same clamp.
- [x] Verify: focused 12/12; neighbors 99 + design-ref-grid 10/10
      (one EPERM load flake, green alone); tsc clean; full suite 2540
      passed / 1 failed (pre-existing `group` guard) / 15 skipped;
      build clean; ui:verify exit 0; live CDP probe on the built app:
      native zoom cancelable, plain wheel scrolls only, Ctrl+wheel
      zooms ×1.162 (single step) with zero scroll.

---

