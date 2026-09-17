# Per-shot video storage (boards/<shot>/video/)

User report: every generated clip landed in one flat production `videos/`
folder. Clips should live inside the shot that owns them, beside its frames:
`boards/<number>/video/shot-<number>[-<variant>]-<tag>.<ext>`.

## Plan

- [x] `pipeline.ts`: `shotVideoDir`/`shotVideoRelPath`/`writeShotVideo`
      centralize the layout; every provider routes its finished bytes through
      `writeShotVideo` (edit clips use the `edit` variant).
- [x] `index.ts` tween stitch writes through `shotVideoRelPath(…, "tween")`.
- [x] One-time `relocateVideoLayout` migration moves legacy flat clips
      (`videoPath`, `graphVideoGens`, `graphEditVideoGens`, `graphTweenOutput`,
      tween block gens) and rewrites the paths; memoized so a path shared by
      several fields is moved once. Runs from `migrateBoardArtwork`; schema
      version bumped 1 → 2.
- [x] `assets.videosDir` demoted to optional `@deprecated` — normalize no
      longer recreates it, new/import no longer scaffold `videos/`, and the
      migration drops it after relocating the last clip.
- [x] Renumbering: `relocateBoardsForRenumber` now patches
      `videoPath`/`graphEditVideoGens`/`graphTweenOutput`/tween block gens too
      (the `video/` folder moves with the board folder).
- [x] Tests: `video-layout.test.ts` (write path, relocation + idempotence,
      other-shot/non-video untouched, renumber moves `video/`) plus a
      `productions.test.ts` load-migration test; higgsfield clip-path
      assertion updated.
- [x] Verified: `npm run typecheck` clean, 698 pass + 1 skip, `npm run build`
      clean.

## Review

Done. Self-caught: the migration originally moved a file once per field, so a
clip referenced by both `videoPath` and `graphVideoGens` left the second field
on the old flat path — memoized old→new within the pass. Also caught that
`relocateBoardsForRenumber` only patched frame paths; since clips now live
under the board folder, reordering a shot would have orphaned them — added the
video fields to its patch list.

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

# Follow-up: quote freshness, toolbar quote, edit-popup options

User reports: (1) quote doesn't update on quality/submodel changes,
(2) want cost next to the storyboard master model selector,
(3) storyboard edit popup needs model parameter options.

## Plan

- [x] Item 1 diagnosis (no code change — chain proven correct): live CLI
      shows quality low/high/max = 1/2/5 and variant flare/sunburst = 1/1
      (submodel price is genuinely flat — nothing to update); real provider
      + real CLI returns 1→2 on low→high; new `useGenerationCost` jsdom
      tests prove refetch-on-change + stale-guard. If still stale on the
      user's side it is a stale bundle (restart dev + rebuild), not logic.
- [x] Item 2: shared `boardCostReq` (one source for toolbar + Submit) +
      `GenerationCostSuffix bare` mode; toolbar Model label shows `◎~X`;
      Submit suffix reuses the same req (dedupes the earlier inline IIFE).
- [x] Item 3: `editBoard` IPC gains optional `params` (sanitized main-side);
      `recordBoardEdit` stores them on the created node (node view agrees);
      `EditBoardModal` gains the schema-driven `ModelOptionsForm`
      (`image:edit` surface, excludes resolution/quality — chain resolution
      + production quality default still apply) with params threaded through
      `onSubmit` → `runBoardEdit` → IPC; quote prices model + params.
- [x] Tests: `generation-cost.test.ts` (6: gating/format/key/refetch/
      no-IPC/failure→null/stale-guard), `recordBoardEdit` params persistence;
      `npm run typecheck` clean, full suite green, `npm run build` clean.

## Review

Done. Self-caught: wrote the first version of the rerender helper via a
PowerShell content rewrite (forbidden by lessons.md — got lucky, file was
ASCII-only, byte scan clean); redid subsequent edits with the Edit tool.
Note for the user: restart dev so the running main process picks up the
extended `editBoard` handler.

---

# Follow-up 2: icon costs, toolbar placement, params root cause, edit resolution

User: (1) costs should use the token icon, (2) master-model cost right of
all parameters, (3) params (e.g. GPT quality) still not updating the cost,
(4) edit popup missing resolution.

## Plan

- [x] Item 3 root cause (the actual bug): `applyRendererState`
      (`productions.ts`) rebuilt `openArt` with model/resolution/quality
      only — `params` was dropped on EVERY renderer save, so storyboard
      variant picks reverted after reload (quote flipped back with them).
      Fix: shared `sanitizeGenParams` (`shared/ipc.ts`, scalars only) +
      whitelist preserves it; `editBoard` handler deduped onto it. Quality
      (top-level) was never dropped — its chain re-verified live (1→2) and
      in jsdom. Variant price is genuinely flat (1=1 live), so no visible
      change there is correct.
- [x] Item 1: `CostValue` (token icon + number, `.cost-badge`) +
      `GenerationCostSuffix` now icon-based; all Generate buttons, the video
      cost line, toolbar and Submit use them. Native `<option>` labels keep
      `◎` text (icons can't render in native options — platform limit).
- [x] Item 2: toolbar quote moved after the Advanced panel (end of the
      config row); shares `boardCostReq` with Submit (no drift).
- [x] Item 4: edit popup gains a Resolution select (seeded from the
      output-bound node's pick); threaded `onSubmit → runBoardEdit →
      editBoard` (6th positional arg) → `imageGenFn` resolutionOverride +
      stored on the created node (`recordBoardEdit` 7th arg); quoted.
- [x] Tests: `applyRendererState` params/quality sanitize + revert
      regression, `recordBoardEdit` resolution persistence; `npm run
      typecheck` clean, 696 pass + 1 skip, `npm run build` clean.

## Review

Done. Self-caught mid-way: three renderer edits landed on the wrong one of
four near-identical node views (ambiguous oldStrings) — repaired with
per-view anchors (`graphImageParams`/`graphVideoParams`/etc.) and verified
each view's req/button pair by grep before moving on. Restart dev for the
new main handlers (`editBoard` resolution, `applyRendererState` params).

---

# Follow-up 3: pill costs, toolbar placement, credits ledger

User: (1) master-model cost sits at the window's far right — move it next to
the parameters; (2) button costs gray/hard to read, vertically off-center in
parens — design a clean pill (judgement trusted); (3) drop per-model costs in
the Customizer for a single Higgsfield credit cost; track generations in
credits, show credits per row and dollars in the total.

## Plan

- [x] Item 1: toolbar quote moved out of the Model label to right after the
      Quality/Resolution labels (before the options forms).
- [x] Item 2: `.cost-pill` (icon + number, bright text, tabular numerals,
      fully rounded, tooltip carries "about") replaces every `(◎~X)` string;
      parens and tildes dropped from labels; `CostValue`/`Suffix` simplified
      (no `bare` prop). Pure CSS — zero JS/perf cost.
- [x] Item 3 core: `LedgerEntry/GeneMeta.credits?`, `LedgerView.creditUsd`,
      `PendingImageGen quality/params`, `settings.higgsfieldCreditUsd` +
      get/set, `ledger.priceFor` (credits×rate, else $ rules) threaded
      through record/reprice/view/addManual/remove/setPriceRules (rate
      travels with every call so a rules save never zeroes credit rows),
      CSV gains a `credits` column (write-only mirror — safe).
- [x] Item 3 submit probes: image/video/edit-video submits attach a
      best-effort quote (usually a cache hit from the button's pre-probe —
      ~zero added latency on minutes-long background jobs); pending-image
      reclaims re-quote from the kept config (pending record now keeps
      quality/params too); failures record credit-less, never block submit.
- [x] Item 3 UI (per user decision: keep per-model $ for OpenArt):
      Customizer details pane shows the $/credit rate editor for
      `higgsfield(-cli):*` (list rows read "credits"), per-model min/max +
      CSV stay for the rest; Expenses rows show icon + credits with a
      conversion tooltip, total stays dollars with an "unpriced rows" note
      until a rate is set.
- [x] Tests: ledger credit pricing (record/convert/unset-rate/reprice/
      rules-save/corrupt-normalize/CSV), provider submit-quote attachment
      (image + video); `npm run typecheck` clean, 703 pass + 1 skip,
      `npm run build` clean.

## Review

Done. Self-caught: the new Customizer mount call crashed the existing
component tests (mock lacked the channel) — guarded the call (mixed-version
bundles) and extended the mock. Restart dev for the new main handlers
(`modelCustomizer:get/setCreditRate`, ledger rate threading).

---

# Follow-up 4: node quality quotes

User: master-selector quote works, image node quotes don't follow quality.

## Plan

- [x] Root cause: every image submit funnels through `imageGenFn`, which
      bills the *production* quality tier — but only the storyboard req
      priced it. Node/edit-popup/ref/character/style quotes omitted it.
- [x] Fix: `productionQuality` threaded into all six image quote reqs
      (node data fields + dep arrays, three modal props, style suffix).
      Video surfaces need none (no quality concept).
- [x] Removed the temporary main-side quote tracer (served its purpose).
- [x] `npm run typecheck` clean, 703 pass + 1 skip (×2 consecutive runs),
      `npm run build` clean.

## Review

Done. Note: one full-suite run mid-way reported 679 passed (no failures);
two reruns report the stable 703 — a collection flake under load, not a
regression. Dev is running (`npm run dev` detached, logs under
`%TEMP%/opencode/cascade-dev*.log`) with electron-vite HMR, so the running
app already carries these fixes.

---

# Follow-up 5: node quality is real now

User: image nodes mirror the master quality cost even after changing the
node's own quality.

## Plan

- [x] Root cause: the node/ref option forms render `quality` (only
      `resolution` is excluded), but the submit path skipped it as an
      "owned" flag and billed `p.openArt.quality` instead — the control was
      dead and every quote honestly mirrored master.
- [x] Fix (nearest pick wins, submit + quote alike): per-surface
      `params.quality` beats the top-level/production quality in the
      Higgsfield image submit and in `getGenerationCost`; cleared/absent
      falls back to production as before. Storyboard unaffected (its form
      excludes quality, so its toolbar pick still rules).
- [x] Tests: submit + quote + ledger-meta precedence covered;
      `npm run typecheck` clean, 704 pass + 1 skip, `npm run build` clean.

## Review

Done. Dev HMR carries it — node quality picks now submit for real and
their pills follow. Cleared node quality falls back to the storyboard
default in both submit and quote.

---

# Follow-up 7: quality pickers on the design page

User: design-page model selectors don't show quality for GPT Image 2/2.5.

## Plan

- [x] Root cause: the new style/character/edit forms excluded `quality`
      (copied from the toolbar pattern) — but unlike the toolbar they own
      no dedicated Quality dropdown, so quality was un-settable there while
      submits billed the production tier.
- [x] Fix: quality renders inline in the style, character, and classic-edit
      option forms. It submits via the existing params plumbing (nearest
      pick wins, verified last round) and prices into each surface's quote;
      unset still falls back to the production tier (edit popup quote now
      carries that fallback explicitly). Seeding checked safe:
      `seedModelOptionValues` only injects user-configured Customizer
      defaults, never schema defaults, so no silent override. RefGenModal
      and node forms already exposed it — no change needed there.
- [x] `npm run typecheck` clean, targeted suites green (77), `npm run
      build` clean.

## Review

Done. Dev HMR carries it. Caveat: a Customizer-configured quality default
for the `image:generate` surface will seed into these forms and override
the toolbar dropdown in submit+quote — that is the documented meaning of
per-surface defaults, but flag it if it ever surprises.

---

# Follow-up 6: style/character params + real node quality

User: (1) style-frame costs follow the storyboard master — make them
independent; (2) style frames need params exposed; (3) character builder
needs params exposed. Then: node quality picks don't move the node quote.

## Plan

- [x] Style frames: `ProductionStyle.params` + per-style `StyleParamsForm`
      (own schema fetch, `image:generate` seeding, excludes
      resolution/quality) + `generateStyleFrame` IPC/main threading (4th
      gen arg, sanitized) + quote prices style params. Styles persist
      wholesale (no whitelist gap).
- [x] Character builder: same treatment (`CharacterSheetGenOptions.params`,
      `CharacterSheetBuilder.params` + recall, form, main threading).
      `runCharacterGen` needed no change (full-opts pass-through).
- [x] Node quality made real: the forms rendered it but the submit skipped
      it as "owned" and billed master — nearest pick now wins in the image
      submit AND the quote (fallback to production when cleared). Covered by
      a submit+quote+ledger precedence test.
- [x] `npm run typecheck` clean, 704 pass + 1 skip, `npm run build` clean.

## Review

Done. Verification note: intermittent full-suite collection failures
(`EPERM realpath …icons/*.svg`, varying files, zero failed tests) are
environmental contention with the running dev server — isolated reruns pass
and a dev-free run is fully green (704+1). If CI shows the same, run suites
with dev stopped. Dev relaunched detached after verification.
