# Cascade — Domain Context

Domain vocabulary for the Cascade codebase. Architecture reviews and AI agents
should use these names for modules and concepts — "service"/"component"/"API"
drift is discouraged. A **module** here means a cohesive unit with a small
interface that hides a lot of behavior.

## The product

A desktop AI agent (Electron + React) that chats with AI, edits local files,
runs shell commands, connects to MCP servers, and runs **productions** — a
5-step content pipeline: **1 Ingest** (script → scenes/shots) → **2 Design**
(styles, brand, references) → **3 Storyboard** (per-shot frames via node graph +
OpenArt) → **4 Animatic** (timing, voiceover, music, video) → **5 Export**.

## Modules and seams

| Module | File | What it hides |
|---|---|---|
| Agent core | `core/src/` | The streaming agent loop (tool-calling, approval gating, undo journal, compaction). The deep, tested module. |
| LLM provider registry | `app/src/shared/providers.ts` | The abstraction over OpenAI-compatible chat vendors (Gab, Cheaper Inference, OpenAI, …): each provider is one `ApiProvider` entry (base URL, default model, optional `balance` endpoint). A `balance` entry is the endpoint path + JSON field + unit, so `ChatClient.balance(endpoint)` fetches generically (gab credits via `/credits` → `total_available`; Cheaper Inference's wallet via `/account/balance` → `available_usd`). Cost semantics are **derived, not hardcoded** — `detectCost` classifies a raw `/models` entry from its own fields (`credit_cost` → per-message credits, `pricing.*_per_million` → per-token USD, else unknown) and `assignCostTiers` ranks the list cheapest→priciest for providers that can't price a single message. `normalizeModelList` + `extractModelList` keep the `models:list` IPC provider-agnostic. Adding a provider = one registry entry, never UI code. |
| ChatClient | `core/src/chat.ts` | The provider-agnostic OpenAI-compatible streaming client (`complete`/`completeOnce`/`balance`) every LLM call rides on; takes `apiKey` + `baseUrl` so the registry supplies the vendor. Background jobs (compaction, chat titles) use `AgentConfig.helperModel` — the cheapest discovered model, cached per provider in settings — never a hardcoded model id. |
| Harness skills | `app/src/main/skills.ts` | The chat-side skill system: markdown instruction files the agent pulls in on demand via `read_skill`. Flat files or namespaced directories (`skills/spec/research.md` → `spec:research`); optional frontmatter (`kind: sequential|advisory|utility`, `triggers`, `namespace`) parsed by `parseFrontmatter`; advertised grouped-by-kind in the system prompt (`prompts.skillsPrompt`) so the model knows how to treat each. Bundled harness skills in `app/skills/` (`spec:` RPI, `oracle:` advisory, `code:` utilities) are seeded into `userData/skills/` on startup (`seedSkills`). |
| Plan mode | `core/src/planmode.ts` + `app/src/shared/commands.ts` | The Research→Plan→Implement gate: `AgentConfig.planMode` turns on a system-prompt directive and `planGate` blocks `write_file`/`edit_file`/`run_command` in the loop until the plan is approved. Toggled per chat (persisted on the session), surfaced via a composer chip and `/plan-mode on|off`; `/research /plan /implement /finish /architect /challenge /review /commit` expand to skill instructions (`expandCommand`). |
| OpenArtClient | `app/src/main/openart.ts` | The whole OpenArt integration: model discovery, live form-schema introspection, per-model option assignment, async image/video generation + polling, project resolution, video-options cache. Takes the `McpManager` as its constructor seam — that interface IS the test surface. Implements `MediaProvider` (foreign Higgsfield model ids resolve to the house default). |
| MediaProvider | `app/src/main/providers/` | The abstraction over image/video vendors: the `MediaProvider` interface (`types.ts`), the global registry (`registry.ts`), vendor-neutral `resolvePromptRefs` + `citePrompt` (`refs.ts` — both vendors bind references positionally from the submitted array, probed live on each), and the `HiggsfieldProvider` adapter (`higgsfield-cli.ts` — CLI-driven, `generate create/wait/get`, temp-file reference path, no project concept; ordinary non-tween submissions ride the reference path, dropped video refs downscaled to 720p first via `video-ref`; only in-betweener `frameRefs` bind start/end slots). index.ts resolves the active vendor per call from the global settings selection. Model ids are namespaced (`higgsfield-cli:<id>`, legacy `higgsfield:<id>` routes to the CLI) where they leave the provider. An explicit model pick that isn't in the active vendor's catalog **throws instead of substituting** (a stale cross-vendor pick from a provider switch once billed a job to the wrong model while the dropdown showed another); only `auto`/empty fall back to the house default. |
| MCP manager | `app/src/main/mcp.ts` | Connecting/owning MCP servers; namespaced tools; the `callRaw*` host-side call surface the media providers use. |
| ModelgenClient | `app/src/main/modelgen.ts` | The 3D AI Studio REST integration: Tencent Hunyuan Pro text/image-to-3D generation (submit → poll → download), GLB bytes + credit balance. Takes the API key getter and an `HttpFetch` as constructor seams — that injection IS the test surface (`app/test/modelgen.test.ts`). |
| Pipeline | `app/src/main/pipeline.ts` | Prompt derivation + deterministic transforms (script breakdown, board prompts, animatic planning). Receives `ImageGenFn` from the active `MediaProvider` — never imports a vendor. |
| Assembly | `app/src/main/assembly.ts` | Step 5 editor handoff + render: media gathering into `out/assembly/`, CMX3600 EDL, After Effects rebuild `.jsx`, manifest, and the 3-pass ffmpeg render. Pure builders are unit-tested; `assemble()`/`renderAnimatic()` take an injected ffmpeg `run`/`probe` seam (`app/src/main/ffmpeg.ts`). |
| ffmpeg seam | `app/src/main/ffmpeg.ts` | Locating the ffmpeg binary (bundled `ffmpeg-static`, asar-unpacked when packaged, else PATH) + `runFfmpeg`/`probeMedia` that `assembly.ts` injects. Pure node — never imports Electron. |
| Reference thumbnails | `app/src/main/thumbnails.ts` | The `?thumb=1` query on `cascade-media://` URLs: `loadRefThumbnail` resizes a reference image to a 256px long edge and compresses to JPEG (~65), served from a bounded memory cache then a versioned durable cache under `userData/thumb-cache/` (`<sha1>-<mtimeMs>-<size>.jpg` — valid exactly while its source is unchanged), then a fresh encode; any failure falls through to the full file. `regenerateRefThumbnails` pre-encodes every production's reference images (`referenceImagePaths` in `productions.ts`) from Settings → Regenerate thumbnail cache and prunes stale entries. Node-graph tiles use it (`refThumbUrl` in `NodeGraphModal.tsx`) — zoom/lightbox URLs keep the full-res file, and prompt sends read the original from disk, so nothing downstream sees the thumb. |
| Production store | `app/src/main/productions.ts` | Production document persistence + migration. |
| Shotter | `app/src/main/shotter.ts` | The 4-digit shot-numbering module: 100-grid derivation (`nextNumber`/`insertMid`/`renumber`), mid-numbered shot inserts with a full-renumber escape hatch, cross-scene reorder with board-folder relocation, and the manual `setShotNumber` override (one shot only — rejects malformed/sub-0100 numbers and any slot another shot already owns, since assembly keys `shots/<number>.*` filenames on it; board folder relocates to follow), and the scene-level surface (`blankScenes` — the 1-scene × 5-blank-shots skeleton for script-less productions — and `insertScene`, which splices an empty scene and renumbers later scene ordinals 1..N; scene ordinals are display-only, shot numbers untouched). |
| Expense ledger | `app/src/main/ledger.ts` | The running tally of every AI generation + manual purchased-asset rows: price-rule matching (`matchPriceRule`), per-production entry files (`userData/ledger/<productionId>.json`, each with its own `userData/ledger/<productionId>.csv` mirror), and the global rules singleton (`userData/ledger.json`, `version: 2` — pricing is per-model, never per-project). Entries are scoped to the `productionId` that produced them; a generation with no production is dropped rather than shown everywhere, and hard-deleting/archiving a production removes/archives its ledger (`removeProject`/`archiveProject`). Loading a `version: 1` file splits its entries per production (unscoped legacy rows discarded). Receives generations via `OpenArtClient`'s `onGeneration` constructor seam — that injection IS the test surface. |
| Document store | `app/src/main/store.ts` | The generic JSON-document store (`createStore`) behind sessions, productions, and agents: atomic temp+rename writes, newest-first list, archive/ soft-deletes, decode/encode hooks, side-file hooks. Settings stays a bespoke singleton (encryption + memo cache). |
| IPC contract | `app/src/shared/ipc.ts` | The single channel map (`ipcContract`) that derives the renderer API, drives the preload adapter, and validates every main-process handler. Adding a channel = one contract entry, not three files. |
| Look contract | `app/src/shared/look.ts` | The storyboard-cohesion vocabulary every image path shares: the verbatim LOOK clause (`buildLookClause`/`withLookClause`), prompt assembly order (`assembleImagePrompt`), per-shot style resolution (`resolveShotStyleEntry`/`styleFrameForShot`), board seed (`ensureLookSeed`), the neutral-subject frame prompt (`styleFramePrompt`), and the adapter-level `GenerationRequest` (frame at index 0, 16:9, frozen model/resolution). Adapters do transport only — no private LOOK copies. |
| Production views | `app/src/renderer/src/components/production/` | The workspace's extracted panels — `animatic.tsx` (Step 4 playback engine + timeline), `boards.tsx` (board cards + gen modals), `prompt-panel.tsx`, `references.tsx`, `brand.tsx`, `hex.ts`, `assembly.tsx` (Step 5 export package + render) — orchestrated by `ProductionWorkspace.tsx`. |

## Core domain terms

- **Harness** — the chat-side methodology that teaches the agent how the user
  works: a set of skills, workflows, and gates (in the spirit of Martin Richards'
  "Building Your Own Agent Harness"). Built around a Research → Plan → Implement
  loop where the agent researches the workspace (`spec:research`), writes a plan
  (`spec:plan`), implements it test-first (`spec:implement`), and validates it
  (`spec:finish`) — backed by `oracle:` advisory and `code:` utility skills.
  **Plan mode** (`AgentConfig.planMode` + `core/src/planmode.ts` `planGate`) is
  the enforced gate: while on, the agent cannot write/edit files or run commands
  until the user approves the written plan. Slash commands (`/research`, `/plan`,
  `/implement`, `/finish`, `/challenge`, `/architect`, `/review`, `/commit`,
  `/plan-mode on|off`) expand in `app/src/shared/commands.ts` (`expandCommand`).
  The harness is designed to be **engineered** the same way as the software it
  produces — add skills for how you write code, test, and think about design.
- **Production** — one project folder with a 5-step pipeline state machine
  (`Production` in `shared/ipc.ts`). Owns scenes, styles, references, brand, assets.
- **Shot** — the smallest Audio/Visual unit; stable `id`, derived 4-digit `number`.
  The persistent canvas for the node graph (`ProductionShot`).
- **Scene** — ordinal grouping of shots (display only).
- **Reference** — a character / product / custom-referenced image. Artwork lives
  on disk (`imagePath` under `referencesDir`); legacy inline data URLs still read.
- **Character sheet** — the generated reference image for a character (built by
  the Step 2 character builder): a full body shot (front, or front + back) with a
  face-closeup inset, always neutral pose/expression/lighting on a plain gray
  background with no text overlays. Its prompt framing lives in `characterSheetPrompt`
  (`pipeline.ts`); sheets are always generated 16:9. The builder's last
  description + generation settings persist per character (`CharacterSheet.builder`),
  and every generated sheet is mirrored into the references panel's **Characters**
  category (`upsertCharacterSheetRef`) so it's citable as `@[name]`.
- **Style** — a named generation prompt (up to 5); `styles[0]` is the master.
- **Style frame** — a style's look anchor: one conditioning image on disk
  (`ProductionStyle.imagePath` under `styles/`, with `frameSource`
  upload/generated/reference/anchor) reused at reference index 0 on every shot
  that resolves to the style, cited by the verbatim LOOK clause as a look
  (never a subject). Authored in Design (generated look plate, upload, kept
  from style-from-image, or locked from an approved frame via `anchorShotId`);
  the board-wide `lookSeed` + frozen model/resolution make it repeatable.
  Styles without a frame keep the text-only behavior.
- **Brand** — palette swatches + optional font appended to every board prompt.
- **Board** — a shot's generated frame (`artwork` on the shot, in `boardsDir`).
- **Expense rule** — a pricing rule (kind + model → min/max dollar range) the
  user configures in Settings → **Models & expenses**; one range per model, so
  no per-resolution × per-length grid. The matcher (`matchPriceRule`)
  interpolates between the range endpoints by the generation's resolution and
  video length against the model's baked ladder (`resolutions[]` +
  `durMin/durMax`, read from its live form options at edit time). Exact models
  beat the wildcard, and generations matching none are priced at $0. Saving
  rules **re-prices every existing generation** (`repriceAll`, manual rows
  untouched) — history is recomputable from the rules, not frozen. The tab is
  also the model registry: `listAllModelLadders` probes BOTH media vendors
  (`providers/registry.ts`) and the UI auto-populates one price row per
  discovered model, grouped into per-vendor sub-panels (OpenArt / Higgsfield),
  plus a per-model hide toggle that writes
  `settings.hiddenMediaModels` — filtered main-side in `production:openArtModels`
  and `production:videoEndFrameModels` so every generation dropdown excludes
  hidden models without renderer changes. Image vs video is classified from
  the model's flags, which OpenArt derives from structured fields only
  (`media`/`modes`/`output_type` — never the free-text description, which is
  marketing copy that routinely mentions both modalities): a model is priced
  as an IMAGE only when `imageInput && !videoInput`, and as VIDEO whenever
  `videoInput`. The user can drag a row between the sections to override the
  auto-detected kind (`settings.modelKindOverrides`, applied main-side in
  `applyKindOverrides` so every dropdown follows it); dragging preserves the
  row's price under the new kind, and dragging a row up or down its group
  re-orders it (`settings.mediaModelOrder`, applied main-side in
  `production:openArtModels` so every dropdown lists models in the saved
  order; unknown models append in discovery order).
- **Media defaults** — the generation dropdowns' remembered last choices
  (`settings.mediaDefaults`, one entry per context: image / video / edit /
  reference / character / tween). Every model dropdown seeds from its
  context's remembered choice (validated against the current list; existing
  per-shot/per-production persistence like `prod.openArt`,
  `CharacterSheet.builder`, `shot.graphTweenModel` wins when set) and writes
  back on change via the renderer's `production/media-defaults.ts` cache —
  so each dropdown starts where the user last left it, globally.
- **Model options schema** — the live per-model option surface, derived from
  the Higgsfield CLI's `model get <job_type> --json` (the
  `HiggsfieldCliProvider.modelOptions()` → normalized `CliModelSchema` in
  `higgsfield-cli.ts`, which `normalizeCliModelDetail` classifies into typed
  `CliOptionField`s grouped core/reference/control/advanced, with an in-memory
  TTL+LRU cache that keeps the last-good schema across transient fetch
  failures). A single generic `emitExtraParams` pass emits each present
  `params` entry, skipping media roles (the reference router owns them) and
  the flags the legacy blocks already own (resolution/quality/duration/
  aspect); `emitSchemaField` never emits an unlisted enum value or a
  non-finite number. Selections persist additively on
  `OpenArtBoardConfig.params` / `VideoGenOptions.params` (schema-agnostic,
  no migration; unknown keys ignored, so switching models never carries stale
  keys into the next submission). `<ModelOptionsForm>` organizes the schema
  into **exposed** controls (group `core`: resolution, aspect ratio, quality,
  and the GPT Image 2.5 `--variant` submodel) and a **collapsible, persisted
  "Advanced" panel** (control/advanced: `--mode`, `--thinking`, `--variant`
  for flux, background, seed, …), rendered as enum→select, integer/number→
  number, boolean→toggle, string/array→text, json→textarea, with `exclude`
  for fields a dedicated control already owns; the advanced toggle is a real
  `<button aria-expanded aria-controls>` whose collapsed state persists via
  `usePersistedCollapsed` (`persistKey`). A null schema renders nothing so the
  callers fall back to the legacy `imageModelOptions`/`videoModelOptions`
  ladders — the `production:modelOptions`   channel exposes it, and the ladder
  adapters stay as projections over `modelOptions()`. The customizer's search
  is fuzzy and also indexes each model's parameter surface (lazily, bounded),
  with synonyms so natural terms find flag spellings ("end frame" →
  `end_image`). Every generation surface
  shares one aspect-ratio default (`DEFAULT_ASPECT_RATIO` / `resolveAspectRatio`
  = `16:9`, overriding the vendor image default of `1:1`; never `16x9` on the
  wire). Every node's advanced selections persist additively, keyed by
  canonical flag (`GenParams`): `ProductionShot.graphImageParams` (image gen
  node), `graphVideoParams` (video node), `graphTweenParams` (in-betweener),
  and `GraphEditNode.params` (per edit node); reference generation carries
  them on `ReferenceImageGenOptions.params` through the injected
  `ImageGenFn`'s optional 4th argument. `scripts/export-model-options.mjs`
  dumps every model's option surface to a CSV (read-only `model list`/`model
  get`) for reviewing the exposed/advanced placement. `ImageModelOptions`/`VideoModelOptions`
  gain optional `aspectRatios`/`qualities`/`submodels`/`params:
  ModelParamOption[]` projections; OpenArt's `extractOpenArtVideoOptions`
  splits quality/definition from resolution/size so a quality enum no longer
  folds into the resolution ladder. Every provider (`openart`, `higgsfield`,
  `higgsfield-cli`, `openart-cli`) implements `modelOptions(modelId)`: the CLI
  and Higgsfield MCP build the schema from their `model get`/catalog details,
  and both OpenArt transports build it from their form-schema properties
  (`openArtSchemaFromProps`) — all through the shared `model-schema.ts`
  grammar (`buildModelSchema`).
- **Model Customizer** — the Dev Mode-only full-window page (`ModelCustomizer.tsx`,
  opened from Settings → Media generation when Dev Mode is on) that probes
  every media vendor (`modelCustomizer:probeModels` / `:probeOptions` /
  `:refresh`, read-only) and customizes: model show/hide
  (`settings.hiddenMediaModels`), image/video kind override
  (`modelKindOverrides`), dropdown order (`mediaModelOrder` — the list is
  grouped Image/Video and reordered by dragging a grip, with a resizable,
  persisted model-list pane), and per-parameter placement
  (`modelOptionExposure`, key `<namespaced model id>::<flag>` →
  core/advanced/hidden, applied main-side to `production:modelOptions` via
  `applyOptionExposure`). Dedicated fields (resolution/quality/aspect/
  duration) and media roles are locked. It also sets **per-surface parameter
  defaults** (`settings.modelParamDefaults`, key
  `<namespaced model id>::<surface>::<flag>` → value): each model's params
  table gains a typed editor per surface the model is actually assigned to
  (unticking a "Where this model appears" checkbox drops that column), and
  every generation surface seeds the defaults when the model loads via the renderer's
  `production/model-param-defaults.ts` cache + `seedModelOptionValues` (the
  user's saved per-shot/per-node value wins; media/reference roles are never
  seeded). The page also owns **where each model
  appears**: per-surface checkboxes (`settings.modelSurfaces`, key = model id →
  `ModelSurface[]`), applied main-side by `applyModelSurfaces` in `registry.ts`
  so every picker filters by `modelOnSurface`. Surfaces are deliberately coarse
  — pickers that share a model pool share a key: `image:generate`
  (Step 3 master picker, generate-image node, references, character sheets,
  style frames),
  `image:edit` (classic edit popup + edit-image node), `video:generate`
  (video modal + video node), `video:tween` (in-betweener), and
  `video:editnode` (edit-video node). `normalizeModelSurfaces` (`shared/ipc.ts`)
  migrates the old per-picker keys (`image:master|node|reference|character`,
  `image:editnode`, `video:modal|node`) onto their pools on read.
  `video:tween` is **opt-in** (never in the default set):
  assigning a model to it IS the user's end-frame capability declaration,
  unioned with the live probe in `production:videoEndFrameModels` (there is
  no separate manual allowlist). It also owns **pricing** (the former Settings → Models &
  expenses tab, now removed): the model list shows a read-only price range
  column and the details pane edits a model's min/max rule (re-priced on save
  by `ledger.setPriceRules`) with CSV import/export. `settings.
  hiddenMediaModels` remains the single visibility control.
- **Edit-video node** — a node-graph node that edits one video. It has a
  **source socket** (`in-video`: a video node output or a video reference, or
  the shot's own video when nothing is wired); references ride the edit-video
  prompt node's Reference sockets (cited as `@[name]` tags and resolved
  main-side, exactly like the video node). Its model list is the intersection
  of the `video:editnode`
  surface and the provider's live video-input probe (`videoEditModels()`);
  submission rides `MediaProvider.generateVideoEdit` (Higgsfield CLI builds
  `--video-references` from the source). Persists `graphEditVideo*` on the
  shot and pipes into the output via `graphOutputSource === "editvideo"`.
  Its icon is `EditVideoIcon` (`assets/icons/video-editing.svg`). Like the
  other generation nodes it has a dedicated **prompt node**
  (`editvideoprompt`, the shared `PromptNodeView` body, writing
  `graphEditVideoPrompt`) whose Style/Reference/Brand sockets work exactly
  like the video/edit prompt nodes.
- **Node graph** — per-shot canvas of reference/composer/style/brand/output nodes
  whose persisted state lives on `ProductionShot.graph*` fields. **Edit-image
  nodes** are a list (`graphEditNodes: GraphEditNode[]`), not a singleton: each
  has its own prompt, generation history, and `source` pipe (the image node,
  a reference, or a parent edit node), so any edit can daisy-chain into
  another (cycle-checked in `NodeGraphModal`). The output names its feeding
  edit via `graphOutputEditNodeId`; the video source via
  `graphVideoSourceEditNodeId`. The classic Edit-frame popup appends a new edit
  node to whatever chain currently feeds the output (`chainSourceForEdit` +
  `recordBoardEdit` in `pipeline.ts`) and binds it as the output — the wiring
  shows up in the graph automatically.
- **In-betweener** — a node-graph node that interpolates 2–5 keyframes
  into one continuous shot. A keyframe is a **source id** stored in
  `graphTweenRefIds` (`TweenBlock.startRefId`/`endRefId`): a reference id
  (characters/products/custom artwork) OR a generation-node sentinel —
  `TWEEN_KEY_IMGGEN` / `editgen:<nodeId>` (`editNodeKeyframe`,
  `parseEditNodeKeyframe` in `shared/ipc.ts`; the bare legacy `TWEEN_KEY_EDITGEN`
  resolves to `edit0`) — so the image node's selected frame and each edit
  node's selected edit feed the sockets
  alongside reference nodes. One **action block** = 1 start keyframe + 1 end
  keyframe + 1 action prompt (`TweenBlock` in `shared/ipc.ts`); each block
  generates its own start→end clip via `generateTweenBlock`, keeps per-block
  history (`gens`/`genIndex`, with a `Keyframes` view), and the selected clips
  stitch via `stitchTween` (lossless `-c copy` concat, re-encoded preview
  fallback flagged on `graphTweenReencoded`). Stitching is a toggle:
  `unstitchTween` drops `graphTweenOutput` and unbinds the tween output feed
  (the per-block clips and timeline stay intact, so the user can edit and
  re-stitch). The stitched clip feeds the frame
  output node (`graphOutputSource === "tween"`); the assembly package always
  lays the ORIGINAL per-block clips back-to-back (`TW<NNNN><X>` EDL reels) so
  no recompression reaches the editor handoff. Block derivation
  (`deriveTweenBlocks`, pair-key preservation, 1–15s gaps, 15s cap) lives in
  `pipeline.ts`; the timeline modal mirrors it client-side for display.
  End-frame capability is probed from each video model's live form schema
  (`endFrameSlotKey`, shared by the submit path and the probe): the tween
  model lists show ONLY end-frame-capable models — the live probe unioned
  with the user's manual allowlist (Settings → Media generation, `settings.ts`
  `endFrameModels`) — and there is no Auto option anywhere in the model
  dropdowns (every pick is explicit; legacy "auto" values resolve main-side to
  the house default). Unproven models still receive both frames via the array
  fallback when a submission slips past the lists.
  The end-frame slot is **reserved for the in-betweener**: normal video
  generation (the classic modal and the video node) never sets it — a second
  reference would otherwise become an accidental end keyframe. It still fills
  the model's required start-frame slot with its source frame (image2video
  forms reject a submission without it), and binds that frame plus cited
  `@[name]` artwork and any dropped video references through the model's array
  reference field (`videoRefsAssign` / `referenceArrayKey` in `openart.ts`).
  When references are present normal generation submits in the model's
  advertised reference mode (read from the model list's media-keyed `modes`,
  e.g. `element2video`) rather than `image2video`, and downscales oversized
  input video references to the model's allowed height first (`video-ref.ts`,
  default 720p) so a cap like Seedance's 480p–720p video-element limit doesn't
  fail the submission. Only `generateTweenBlock` passes `frames: true` to bind
  the start/end keyframe pair to the dedicated slots.
  `syncTweenBlocks` prunes dead reference keyframes but keeps gen-node
  sentinels unconditionally (a pre-generation wire must survive; generation
  reports a clear error if a keyframe still resolves to nothing).
- **Animatic** — Step 4 playback: timing, voiceover, music, per-shot video clips.
- **3D model** — a Step 2 design-page asset generated via 3D AI Studio's Tencent
  Hunyuan Pro (text-to-3D, single-image-to-3D, or multi-view image-to-3D, GLB,
  optional PBR). GLBs always land in the production's `modelsDir` (`models/`),
  are previewed in-place with a bundled `<model-viewer>` custom element
  (lazy-loaded chunk), and can be copied anywhere via a native Save-As dialog.
  Records live on `prod.models3d`. Input images arrive as data URLs resolved in
  the renderer (from dragged in-app references, external drops, or the native
  file browser).

## Serialization grammars

The prompt text is itself a protocol. `shared/prompt-grammar.ts` is the **one**
home for the serialization grammar — anything re-parsing it by hand is a
duplication to consolidate there (main, renderer, and both media providers
all import it):

- `@[name]` reference tags — `refTagMatches`/`refTagNames`/`addRefTag`/`removeRefTag`.
- `Style:` / `Brand identity:` paragraphs — `parsePromptBoxes`/`composePromptBoxes`,
  `strip/addBrandParagraph`, `strip/addStyleParagraph`.
- Loose JSON extraction from model/MCP replies — `parseJsonLooseObject`/`parseJsonLooseArray`.
- Media helpers — `dataUrlToBytes`, `IMAGE_URL_RX`, `VIDEO_URL_RX`.

The shot→token mapping (`refToken`/`refTokens`/`resolveReferenceTags`) stays in
`pipeline.ts` — that's domain logic over the grammar, not the grammar itself.
`core/` keeps its own data-URL text decoder (`core/src/types.ts`) — it is a
standalone package that must not import from `app/shared`.

## Decisions not to re-litigate

- The pipeline is deliberately **not** a free-form agent loop (see `pipeline.ts`
  header) — one-shot bounded LLM calls, distinct from the `core/` agent loop.
- No ADRs exist yet; if a future review rejects a deepening with a load-bearing
  reason, record it as an ADR here.