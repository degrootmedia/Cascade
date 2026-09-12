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
