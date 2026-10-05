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
| Agent core | `core/src/` | The streaming agent loop (tool-calling, approval gating, undo journal, compaction). The deep, tested module. The approval gate is skipped wholesale by `AgentConfig.autonomousMode` (no per-call prompt; file mutations are still journaled and every tool still emits events). Session grants (`initialAllowedTools`/`initialAllowedGroups`, seeded by the host from the chat file) spare a rebuilt agent from re-asking "always allow" decisions, and `onApprovalGrant` lets the host persist a new grant. The turn cap is `AgentConfig.maxIterations` (default 250, host-configurable). |
| LLM provider registry | `app/src/shared/providers.ts` | The abstraction over OpenAI-compatible chat vendors (Gab, Cheaper Inference, OpenAI, …): each provider is one `ApiProvider` entry (base URL, default model, optional `balance` endpoint). A `balance` entry is the endpoint path + JSON field + unit, so `ChatClient.balance(endpoint)` fetches generically (gab credits via `/credits` → `total_available`; Cheaper Inference's wallet via `/account/balance` → `available_usd`). Cost semantics are **derived, not hardcoded** — `detectCost` classifies a raw `/models` entry from its own fields (`credit_cost` → per-message credits, `pricing.*_per_million` → per-token USD, else unknown) and `assignCostTiers` ranks the list cheapest→priciest for providers that can't price a single message. `normalizeModelList` + `extractModelList` keep the `models:list` IPC provider-agnostic. Adding a provider = one registry entry, never UI code. |
| ChatClient | `core/src/chat.ts` | The provider-agnostic OpenAI-compatible streaming client (`complete`/`completeOnce`/`balance`) every LLM call rides on; takes `apiKey` + `baseUrl` so the registry supplies the vendor. Background jobs (compaction, chat titles) use `AgentConfig.helperModel` — the cheapest discovered model, cached per provider in settings — never a hardcoded model id. |
| Harness skills | `app/src/main/skills.ts` | The chat-side skill system: markdown instruction files the agent pulls in on demand via `read_skill`. Flat files or namespaced directories (`skills/spec/research.md` → `spec:research`); optional frontmatter (`kind: sequential|advisory|utility`, `triggers`, `namespace`) parsed by `parseFrontmatter`; advertised grouped-by-kind in the system prompt (`prompts.skillsPrompt`) so the model knows how to treat each. Bundled harness skills in `app/skills/` (`spec:` RPI, `oracle:` advisory, `code:` utilities) are seeded into `userData/skills/` on startup (`seedSkills`). |
| Plan mode | `core/src/planmode.ts` + `app/src/shared/commands.ts` | The Research→Plan→Implement gate: `AgentConfig.planMode` turns on a system-prompt directive and `planGate` blocks `write_file`/`edit_file`/`run_command` in the loop until the plan is approved. Toggled per chat (persisted on the session), surfaced via a composer chip and `/plan-mode on|off`. **Autonomous mode** is the inverse: `AgentConfig.autonomousMode` skips the approval gate entirely (a system-prompt directive tells the model not to ask for confirmation), toggled per chat from the composer chip or `/autonomous on|off` (alias `/auto`), with a Settings default for new chats. The two are mutually exclusive (turning one on clears the other). `/research /plan /implement /finish /architect /challenge /review /commit` expand to skill instructions (`expandCommand`). |
| OpenArtClient | `app/src/main/providers/openart.ts` | The whole OpenArt integration: model discovery, live form-schema introspection, per-model option assignment, async image/video generation + polling, project resolution, video-options cache. Takes the `McpManager` as its constructor seam — that interface IS the test surface. Implements `MediaProvider` (foreign Higgsfield model ids resolve to the house default). Image polling prefers the **non-blocking** `openart_creation_get` (the blocking `creation_wait` is only a fallback) and tolerates transient per-call errors until the deadline, so a batch of concurrent waits can't pile up behind the MCP client's per-call timeout and discard a frame whose job already finished server-side. Any failure past submission that isn't a hard `OpenArtImageFailedError` (FAILED/CANCELLED) records the job as pending — on the shot (`shot.pendingImageGen`, reclaimed by `production:recheckBoard`) and through an optional `ImageGenFn` `onPending` sink for targets that aren't shots (a style frame, `production:recheckStyleFrame`). Video jobs get the same contingency across every flow: a wait cap or a failed result download records `shot.pendingVideoGen` (the call site tags its `target`), reclaimed by `production:recheckVideo`, which re-polls the vendor job, writes the clip, and applies it to the classic `videoPath`, the video node, the edit-video node, or an in-betweener block (billing the ledger once, like an image recheck). |
| MediaProvider | `app/src/main/providers/` | The abstraction over image/video vendors: the `MediaProvider` interface (`types.ts`), the global registry (`registry.ts`), vendor-neutral `resolvePromptRefs` + `citePrompt` (`refs.ts` — both vendors bind references positionally from the submitted array, probed live on each), and the `HiggsfieldProvider` adapter (`higgsfield-cli.ts` — CLI-driven, `generate create/wait/get`, temp-file reference path, no project concept; ordinary non-tween submissions ride the reference path, dropped video refs downscaled to 720p first via `video-ref`; only in-betweener `frameRefs` bind start/end slots; `imageUpscaleModels()` probes the catalog's upscale families — Topaz, Bytedance Image Upscale — and `imageGenFn` omits `--prompt` when the model's schema declares none, since upscalers reject it). index.ts resolves the active vendor per call from the global settings selection. Model ids are namespaced (`higgsfield-cli:<id>`, legacy `higgsfield:<id>` routes to the CLI) where they leave the provider. An explicit model pick that isn't in the active vendor's catalog **throws instead of substituting** (a stale cross-vendor pick from a provider switch once billed a job to the wrong model while the dropdown showed another); only `auto`/empty fall back to the house default. |
| MCP manager | `app/src/main/mcp.ts` | Connecting/owning MCP servers; namespaced tools; the `callRaw*` host-side call surface the media providers use. Config is the Claude Desktop-compatible `{ "mcpServers": … }` document in `userData/mcp.json`, reached over IPC as text (`mcp:getConfig`/`mcp:setConfig`) — main validates and rewrites it; the type lives in the MCP config grammar below. |
| MCP config grammar | `app/src/shared/mcp-config.ts` | The one home for the `mcpServers` document shape (`McpServerConfig`/`McpConfigFile`, imported by `main/mcp.ts` so the type isn't duplicated) plus the pure parse/serialize/edit helpers the Settings **MCP Servers** section uses: tolerant `parseMcpConfigText` (readable error, never silently drops an unparseable config), `serializeMcpConfig`, `mcpTransport` (url ⇒ http, command ⇒ stdio), `upsertMcpServer`/`removeMcpServer` (position-preserving rename/edit), `validateMcpServer`, `cleanMcpServer` (drops blank fields + the unused transport's, preserves unknown keys), and the field-text codecs (`linesToArgs`/`envToText`/`textToNames`…). Unit-tested in `app/test/mcp-config.test.ts`. |
| ModelgenClient | `app/src/main/modelgen.ts` | The 3D AI Studio REST integration: Tencent Hunyuan Pro text/image-to-3D generation (submit → poll → download), GLB bytes + credit balance. Takes the API key getter and an `HttpFetch` as constructor seams — that injection IS the test surface (`app/test/modelgen.test.ts`). |
| Pipeline | `app/src/main/pipeline.ts` | Prompt derivation + deterministic transforms (script breakdown, board prompts, animatic planning). Receives `ImageGenFn` from the active `MediaProvider` — never imports a vendor. |
| Assembly | `app/src/main/assembly.ts` | Step 5 editor handoff + render: media gathering into `out/assembly/`, CMX3600 EDL, After Effects rebuild `.jsx`, manifest, and the 3-pass ffmpeg render. Pure builders are unit-tested; `assemble()`/`renderAnimatic()` take an injected ffmpeg `run`/`probe` seam (`app/src/main/ffmpeg.ts`). `assemblyPlan` also reports `suspiciousStills` — a shot rendered as a still even though the production shows a video generation (pending job, `videogen` output pipe, or stored clip takes) — and `assemble()` emits it as a hard warning + writes it into the manifest, so the "clip exists on disk but isn't registered" failure can't silently ship a frozen-still render. |
| ffmpeg seam | `app/src/main/ffmpeg.ts` | Locating the ffmpeg binary (bundled `ffmpeg-static`, asar-unpacked when packaged, else PATH) + `runFfmpeg`/`probeMedia` that `assembly.ts` injects. Pure node — never imports Electron. |
| Reference thumbnails | `app/src/main/thumbnails.ts` | The `?thumb=1` query on `cascade-media://` URLs: `loadRefThumbnail` resizes a reference image to a 256px long edge and compresses to JPEG (~65), or extracts a video's **middle-frame 720p poster** via an injected ffmpeg seam (`setVideoPosterDeps`, wired in `index.ts` from `ffmpeg.ts`; `isVideoPath` picks the branch), served from a bounded memory cache then a versioned durable cache under `userData/thumb-cache/` (`<sha1>-<mtimeMs>-<size>.jpg` — valid exactly while its source is unchanged), then a fresh encode; any failure falls through to the full file. `regenerateRefThumbnails` pre-encodes every production's reference media — images and video clips (`referenceThumbnailPaths` in `productions.ts`) — from Settings → Regenerate thumbnail cache and prunes stale entries. The node-graph side shelf's tiles use it (`refThumbUrl` in `NodeGraphModal.tsx`), so does the Step 2 reference grid (`RefFigure` row variant in `references.tsx` — 140px tiles that would otherwise decode a full-resolution file each), and so do the moodboard shelf tiles (`MoodboardShelf`) — moodboard canvas video nodes render the poster (never a playing `<video>`; playback is lightbox-only), image canvas nodes render the full-res file (a canvas is a working surface), zoom/lightbox URLs keep the full-res file, and prompt sends read the original from disk, so nothing downstream sees the thumb. Image responses over `cascade-media://` (`serveMediaFile` in `media-protocol.ts`, and the `?thumb=1` branch in `index.ts`) carry a strong `ETag` + `private, max-age=0, must-revalidate` (304 on `If-None-Match`) rather than `no-store`, so a culled/re-mounted tile reuses its decoded bitmap instead of re-reading and re-decoding the file; video/audio keep `no-store` (range responses). |
| Production store | `app/src/main/productions.ts` | Production document persistence + migration. |
| Production agent tools | `app/src/main/production-tools.ts` | The chat side's door into the Production Assistant: `makeProductionAgentTools(host)` builds the `cascade_*` agent tools (`cascade_list_productions`, `cascade_list_models`, `cascade_model_options`, `cascade_create_production`, `cascade_import_production`, `cascade_ingest_script`, `cascade_set_style`, `cascade_generate_style_frame`, `cascade_generate_character_sheet`, `cascade_generate_magic_prompts`, `cascade_set_shot_prompt`, `cascade_generate_storyboard`, `cascade_plan_animatic`, `cascade_generate_video`, `cascade_recheck_video`, `cascade_assemble`) over a small `ProductionToolHost` seam — that injection IS the test surface (`app/test/production-tools.test.ts`). The host (wired in `index.ts`) dispatches each named op to the SAME handler the Production UI calls (via a captured `ipcListeners` map), so the agent's work is written into the production folder by the app, never ad hoc; `setStyle` (no IPC channel — the renderer persists styles via a document save) calls `productions.upsertProductionStyle`, and `generateVideo` composes the styled prompt main-side before dispatch (`composeVideoPrompt` in `pipeline.ts`, the same `renderPromptText`/`promptRefsFor` pair the renderer uses at submit time — the UI's video prompt is rendered at submit too, so a tool-driven clip carries the same Style/Brand the UI would). Reference *images* attach only when a shot cites them: `cascade_generate_magic_prompts` writes the content prompts that cite `@[Name]` (the designed path), or `cascade_set_shot_prompt` authors one directly. `cascade_assemble` reads the pure `assemblyPlan` back through `host.assemblyReport` and surfaces `suspiciousStills` (a shot with a video generation but no registered clip) as a hard warning, so a frozen-still render can't pass as a finished cut. The digest exposes each shot's `durationSec`/`hasVideo`/`pendingVideo`. The tools merge into every workspace-bound chat agent in `ensureAgent`, so a generic "make me a short film" request creates a real production and drives the pipeline. The `production:film` skill (`app/skills/production/film.md`, seeded like the harness skills; also listed in `electron-builder.json` `extraResources`) teaches the workflow — use the `cascade_*` tools for every generation, cite references, verify each clip registered, and never raw-generate + copy, or assets land outside the production. |
| Shotter | `app/src/main/shotter.ts` | The 4-digit shot-numbering module: 100-grid derivation (`nextNumber`/`insertMid`/`renumber`), mid-numbered shot inserts with a full-renumber escape hatch, cross-scene reorder with board-folder relocation, and the manual `setShotNumber` override (one shot only — rejects malformed/sub-0100 numbers and any slot another shot already owns, since assembly keys `shots/<number>.*` filenames on it; board folder relocates to follow), and the scene-level surface (`blankScenes` — the 1-scene × 5-blank-shots skeleton for script-less productions — and `insertScene`, which splices an empty scene and renumbers later scene ordinals 1..N; scene ordinals are display-only, shot numbers untouched). |
| Expense ledger | `app/src/main/ledger.ts` | The running tally of every AI generation + manual purchased-asset rows: price-rule matching (`matchPriceRule`), per-production entry files (`userData/ledger/<productionId>.json`, each with its own `userData/ledger/<productionId>.csv` mirror), and the global rules singleton (`userData/ledger.json`, `version: 2` — pricing is per-model, never per-project). Entries are scoped to the `productionId` that produced them; a generation with no production is dropped rather than shown everywhere, and hard-deleting/archiving a production removes/archives its ledger (`removeProject`/`archiveProject`). Loading a `version: 1` file splits its entries per production (unscoped legacy rows discarded). Receives generations via `OpenArtClient`'s `onGeneration` constructor seam — that injection IS the test surface. |
| Generation management | `app/src/shared/generations.ts` (+ `deleteGeneration` in `pipeline.ts`) | The one home for stored-take ownership: `findGeneration(shot, rel)` locates a `GraphGenItem` across the image / edit-image / video (generate + edit mode) histories and tween blocks, `generationInUse` reports what a take currently feeds (output frame/clip, video/edit source, tween keyframe, stitched output) so deletion can be blocked, and `removeGeneration` prunes the entry + repairs the selection + purges the legacy `artworkHistory` mirror. Main's `deleteGeneration` unlinks the file (and the frame's same-tag archived original) behind the same guard; the renderer's right-click menus confirm with one shared warning. Any generated image or clip can also be saved as a reference — `saveGenerationAsReference` (channel `production:saveGenerationAsReference`) copies the file into `referencesDir` as a new `CustomRef` named `Saved Ref_00`, `_01`, … (`savedRefName`) without tagging a prompt, so the copy survives deleting the source generation. The one renderer menu (`components/generation-menu.tsx`) is shared by every media surface (storyboard cards carry their own copy); whenever a take's `src` is known it leads with the same native actions as every other image — Save as… / Copy image / Edit externally / Open file folder — so generated images keep right-click save/copy/edit (video takes get Save video / Open folder only, inferred from the path extension). `artworkHistory`/imported frames aren't generations and aren't offered for deletion. |
| Document store | `app/src/main/store.ts` | The generic JSON-document store (`createStore`) behind sessions, productions, and agents: atomic temp+rename writes, newest-first list, archive/ soft-deletes, decode/encode hooks, side-file hooks. Settings stays a bespoke singleton (encryption + memo cache). |
| IPC contract | `app/src/shared/ipc.ts` | The single channel map (`ipcContract`) that derives the renderer API, drives the preload adapter, and validates every main-process handler. Adding a channel = one contract entry, not three files. |
| Look contract | `app/src/shared/look.ts` | The storyboard-cohesion vocabulary every image path shares: the verbatim LOOK clause (`buildLookClause`/`withLookClause`), prompt assembly order (`assembleImagePrompt`), per-shot style resolution (`resolveShotStyleEntry`/`styleFrameForShot`), board seed (`ensureLookSeed`), the neutral-subject frame prompt (`styleFramePrompt`), and the adapter-level `GenerationRequest` (frame at index 0, 16:9, frozen model/resolution). Adapters do transport only — no private LOOK copies. The LOOK clause and the frame scaffold come from the prompt-template registry (below) and every builder takes an optional override parameter, so a user's Settings override applies at generation *and* export. |
| Prompt editing | `PromptContentEditor.tsx` + `TriplePrompt.tsx` + `production/prompt-panel.tsx` | The one text-editing stack every prompt surface shares. `TriplePrompt` decomposes the wire text into Style/Content/Brand boxes; Content is the `contentEditable` `PromptContentEditor`, which renders `@[Name]` as atomic chips while the plain text stays the single source of truth. Invariants: (1) while a box (or a chip) actually holds focus, external value changes are **deferred** (`deferExternalWhileFocused`) so a save round-trip / refetch can never rebuild the DOM and drop the caret — every surface, the side panel included, passes it; (2) Backspace/Delete edit the TEXT model, so a chip is one unit (deleting the space beside it deletes only that character; deleting INTO it removes the whole chip) — never the browser's whole-element delete; (3) the editor owns its undo/redo (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) with a coalescing snapshot stack, because programmatic rebuilds destroy the native history; (4) the `@` autocomplete inserts THROUGH `PromptContentHandle.insertRefTag`, so it stays an internal edit rather than an external rebuild, and a graph socket connect that adds a tag calls `PromptContentHandle.focusAfterTag` so the caret lands right after the new block (focused, ready to keep typing). The node prompt views share one `usePromptNodeDraft` hook (`NodeGraphModal.tsx`): every node (the composer included) keeps a local draft and commits on blur/close — only tag reorders publish live — so a per-keystroke publish can't fire a save/refetch/re-render that jumps the caret; the side panel catches up the moment the user clicks off the node. `ProductionWorkspace.isPromptTextarea` recognizes the content editor so the `getBoardPrompt` refetch never overwrites in-flight typing. Pasted text goes through the clipboard module below (HTML → structured plain text), and the Content box's whitespace survives the `parsePromptBoxes`/`composePromptBoxes` round trip verbatim — only the Style/Brand paragraphs are normalized. |
| Clipboard paste | `app/src/renderer/src/clipboard.ts` | The one conversion from a paste's clipboard flavors to plain text. When the rich `text/html` flavor is present it converts block elements to blank lines, `<br>` to a single newline, keeps `<pre>` whitespace, preserves literal newlines inside pre-wrap text (our own chat bubbles), and drops serialization whitespace between block children; a plain-only clipboard passes through (CRLF-normalized). Both the chat composer (`App.tsx`) and the prompt content editor paste through it, so paragraph/line breaks copied from AI-chat web pages survive instead of collapsing. |
| Prompt templates | `app/src/shared/prompt-templates.ts` | The user-editable creative prompt wording (Settings → Advanced → **Prompts**): a registry of `PromptTemplateDef`s (`cameraGrid`, `videoMotion`, `editImage`, `characterSheet`, `styleFrame`, `lookClause`) each with a built-in text and optional `{{placeholder}}`s, plus `resolvePromptTemplate(id, overrides)` (override if non-blank, else built-in) and `renderPromptTemplate(text, vars)`. The built-ins live here only — `look.ts` (`LOOK_CLAUSE`/`STYLE_FRAME_*`) and `pipeline.ts` (`characterSheetPrompt`/`buildEditGenPrompt`) resolve from it, so the shipped wording and the editor can't drift. Mechanical grammar (JSON shapes, `@imageN` tokens, Style/Brand markers) deliberately stays in code. Main reads overrides once per handler from `settings.getPromptTemplates()` and threads them as optional params (the camera-grid prompt is resolved main-side at generate time); the renderer caches them (`components/production/prompt-templates.ts`, primed like `media-defaults.ts`) to seed the video motion default. Persisted as `settings.promptTemplates` (id → text; absent = built-in). |
| Production views | `app/src/renderer/src/components/production/` | The workspace's extracted panels — `animatic.tsx` (Step 4 playback engine + timeline), `boards.tsx` (board cards + gen modals), `prompt-panel.tsx`, `references.tsx`, `brand.tsx`, `hex.ts`, `assembly.tsx` (Step 5 export package + render) — orchestrated by `ProductionWorkspace.tsx`. |
| Generation queue | `app/src/renderer/src/components/production/gen-queue.ts` + `main/index.ts` (`enqueueGeneration`) | The "Generating (N queued)" model. Renderer: a pure per-target `GenerationQueue` (singleton `genQueue`, `useGenStatus` hook, `genButtonLabel`/`nextRegenRound`/`countByShot` helpers, unit-tested in `app/test/gen-queue.test.ts`) runs ONE job per target key (`genKeys.image`/`edit`/`cameraGrid`/`upscale`/`suite`/`reference`/`character`/`styleFrame`) at a time — `active` stays set between consecutive jobs so a button never flickers idle — while distinct targets stay concurrent; queued clicks increment `pending`, so every image-gen button (storyboard card + prompt-panel Submit frame, the node graph's image/edit-image/camera-grid/upscale nodes, the Image Suite, the reference/character/style-frame panels) stays clickable and reads "Generating… (N queued)". The storyboard keeps its batch optimization: `nextRegenRound` takes one occurrence per shot (distinct frames generate in parallel inside one `regenerateBoards` batch), repeats run in the next round. Main: long-running jobs (`runProductionStep`, `runProductionJob`, and the two magic-prompt LLM batches) run on a separate per-production `enqueueGeneration` chain and commit their rebased result through the shared `enqueueProduction` FIFO, so a prompt save (`production:updateBoardPrompt`, still on `enqueueProduction`) commits immediately while a frame renders instead of waiting minutes for it. |
| Image Suite | `app/src/renderer/src/features/suite/` + `main/suite.ts` | The Production Assistant's dedicated image generation & editing workspace (Spec 01): a panel that replaces the step content (like Expenses), a three-pane shell (`ImageSuite` — history rail / canvas / prompt panel) over the open production, with non-destructive branching history and an A/B compare wipe. Vendor-blind — it lists models through `listOpenArtModels` and submits through `suite:generate`, which resolves the active `MediaProvider`; adding a backend changes nothing here. Sessions persist per production (`userData/suites/<prodId>.json`, atomic) via `suite:loadSession`/`saveSession`/`deleteEntry`/`exportEntry`; outputs land in `<outDir>/suite/` so no reference is created or replaced. The shared `ImageGenForm` (extracted from `RefGenModal`) is the one generation form both surfaces render; `suite-handoff.ts` carries a popup's mode/prompt/model/source into the suite via `OpenInSuiteButton` (RefGenModal, reference tiles, node edit node, board prompt) and the shared right-click "Edit in Suite" (node-graph takes, storyboard cards, suite results). The generate flow carries a **Style** picker (the pure `suite-style.ts` `withSuiteStyle` mirrors the chosen style's text into the draft prompt; `SuiteGenerateRequest.styleId` drives the frame + LOOK clause main-side), and `OpenInSuiteButton` from a shot prompt seeds the shot's style id so a handoff stays cohesive. The canvas pairs frames through the pure `suite-compare.ts` (`resolveSuiteCompare` — a selected edit compares its resolved `sourceRefId`/`sourcePath` as "Before edit" against its result), rendered as a draggable vertical wipe (either side right-clicks to the same native save / copy / edit-externally actions); an edit handoff reveals the source as the lone "Before edit" frame until the first result lands, and the edit-source picker lists references as thumbnails with a magnifier lightbox. |
| Reference Moodboard | `app/src/renderer/src/features/moodboard/` | The production-scoped PureRef-style canvas (Spec 02): every `CustomRef` drawn as a freely placed/resized/rotated node reusing the sidebar's `RefFigure` (`variant="node"`, full-resolution artwork — the board is a working surface), over a pan/zoom viewport with marquee select, z-order, category filters, and markdown notes. Navigation matches the node-graph canvas: the wheel zooms toward the cursor, and the middle/right button drags pan (a right-drag suppresses the trailing node context menu); the minimap's viewport frame drags live. An off-board shelf (`MoodboardShelf`) lists the refs not on the canvas — removed via `hideNodes` (`offBoardRefs` reads the non-hidden nodes) — and dragging a tile onto the canvas or clicking it puts it back (`placeNewRef` un-hides and re-fronts). All layout math is pure and unit-tested (`moodboard-layout.ts` — `normalizeMoodboardLayout` repairs persisted numbers on read, `reconcileMoodboard` auto-places new refs and prunes orphans, `snapMove`/`fitViewport`/`zoomAt`/`visibleNodes`/`offBoardRefs`). Multi-selected refs can be **grouped into a frame** (Ctrl/Cmd+G, or the toolbar Group button): `groupNodes` sizes a `MoodboardFrame` (`Production.moodboard.frames`, additive) around the selection, pulling members out of any frame that held them (`ungroupFrames`/`removeFrame` reverse it via Ctrl+Shift+G, the frame's × button, the header's right-click menu, or the toolbar). A frame carries an editable label (double-click the header) and an accent color from `MOODBOARD_FRAME_COLORS`; only its header and resize handle take the pointer (the body is click-through so marquee select still works), and dragging the header — or any member node — translates the frame with every member. Membership is edited by drag: dropping a ref inside a frame joins it (`settleFrameMembership`), Alt-dragging one out removes it (the grabbed node moves alone instead of the group), and a ref dropped outside keeps its frame. `normalizeMoodboardLayout` repairs frames (palette key, member dedupe/prune) and `reconcileMoodboard` drops dead members and empty frames; the canvas only forwards gestures. Layout persists additively as `Production.moodboard` through the normal merge save (`applyRendererState`) — no new IPC, no vendor calls; shelf tiles ride the existing `?thumb=1` cache. |
| Detached canvas window | `app/src/main/detached-window.ts` + `renderer/src/components/DetachedCanvasApp.tsx` | The single "popped out" second window (Spec 03) hosting either the node graph or the reference moodboard on another monitor. `DetachedCanvasController` owns one `BrowserWindow` (created via an injected `createWindow` seam — that injection IS the test surface, `app/test/detached-window.test.ts`): a second `window:openDetachedCanvas` focuses + retargets the existing window rather than duplicating, main tracks the current `DetachedCanvasContext` so a late/reloading window gets it on `did-finish-load`, and `canvas:selectionChanged` (a send) forwards the main window's storyboard selection to the detached graph. Same preload/`webPreferences` as the main window (contextIsolation on, sandboxed, `nodeIntegration: false`); target validated against `["graph","moodboard"]`. The renderer boots the same bundle with `?window=detached&target=…` (`main.tsx` routing → `DetachedCanvasApp`), which renders `ProductionWorkspace` in detached mode: no picker (loads the production directly), chrome hidden, graph forced open on the selected frame, moodboard shown. Closing the main window closes the detached one; closing the detached one emits `window:detachedClosed` so the main window clears its state and marks its own graph read-only while detached. Selection also drives the **composer** prompt, not just the shot-derived prompt nodes: the detached effect sets `promptShotId` (not only `graphShotId`) so the shared board-prompt fetch fills `focusedPrompt`, which the composer node reads as its value (otherwise only the video/edit prompt nodes — derived from `shot` inside `NodeGraphModal` — would update on a frame change). In-flight node jobs are mirrored across the two windows so "Generating…" shows wherever the graph lives: each `ProductionWorkspace` publishes its local busy sets via `canvas:busyChanged` (a send), main relays the sanitized `CanvasBusySnapshot` to the sibling (`normalizeCanvasBusy` is the IPC-boundary guard), and each window renders the union of its own and the mirrored sets; main caches the main window's latest snapshot and replays it to the detached window on its first publish so a job started before the pop-out still shows. |
| Camera grid node | `shared/ipc/camera-grid.ts` + `main/camera-grid.ts` | The camera-grid graph node (Spec 04; **4×4 / 3×3 / 2×2** — 16 / 9 / 4 panels): a generator node (`GraphNodeKind "cameraGrid"`, node id `"cameraGrid"`) with a **style socket** (`in-style`, the top socket like every prompt), a **source-image input** (`in-image`), **reference sockets** (`in-ref-0…N` + `in-ref-open`), and a **grid-image input** (`in-grid`, a manually supplied sheet to cut up — the fallback when the auto download fails; pinned to the bottom of the node in its own orange, distinct from the brand hue) that renders a generated cols×rows sheet of camera angles and lets the user marquee panels out into standalone references. The node and the export editor both carry a grid-size dropdown (`CAMERA_GRID_SIZES` / `cameraGridSizeKey`) writing `CameraGridData.cols`/`rows`; changing it re-divides the panels (no regeneration) — the editor's dropdown is how an imported grid image declares its true size. `cameraGrid:generate` renders the shared `cameraGrid` prompt with `cameraGridPromptVars(cols, rows)` so the cell count/arrangement and the size-scaled `{{distribution}}` clause match the chosen geometry; a wired style socket prepends the shot's effective style (`Style: …`) exactly like every other prompt (the stored graph edge is the authority, `CameraGridData.styleConnected` the not-yet-migrated fallback). Its state lives on `ProductionShot.graphCameraGrid` (`CameraGridData`: `sheetPath`, `cols`/`rows`, optional `panels`/`panelLabels`, `source`/`gridSource`/`refIds` wiring, `styleConnected`, per-node `model`/`resolution`/`params`, `inset`, `generation` provenance) — **not** `GraphNode.data`, which owns topology + positions only. `shared/ipc/camera-grid.ts` is the one home for the pure grid math (`cameraGridPanels`, `gridRectFromPoints`/`clampGridRect`/`insetGridRect`, `touchedPanelIndices` — panels a marquee touches by any amount, `unionGridRects`, `resolveCameraGridPanels`/`resolvePanelLabels`, `normalizeCameraGridData`/`normalizeGraphSource`, `placeCameraGridRef`/`removeCameraGridRefAt`) and the vendor-blind request types; both the renderer selection and main's rect validation read it. `main/camera-grid.ts` is the deep cutout module behind `cameraGrid:cutout`: decode (`nativeImage` in prod, injected seam in tests) → `pixelRect` → crop → atomic write → `CustomRef` per rect, with collision-suffixed names (`camera-grid-<nodeId>-<n>[-2].png`). `cameraGrid:generate` resolves the shared `cameraGrid` prompt template (Settings → Prompts) and submits it through the **same `submitGraphImage` path as the edit-image node** (wired source at reference 0, falling back to the shot frame; wired references + `@[name]` tags appended; no aspect override), then writes `referencesDir/grids/…` and replaces `sheetPath` in place while carrying the wiring/picks forward. Wiring the **grid-image socket** calls `cameraGrid:importGridImage`, where main resolves the wired source to bytes and writes a copy into `referencesDir/grids/` (the cutout handler requires the sheet to live in the references folder), returning its path; the renderer sets `sheetPath` + `gridSource` itself (production state stays renderer-owned — main only writes the file). A fresh generation clears `gridSource`. The node itself only shows a clickable **thumbnail**; selecting/exporting happens in the full-res `CameraGridEditor` popup (marquee + a global **inset** slider that shrinks every crop proportionally so the gutters between cells are removed, persisted as `CameraGridData.inset`). `applyCameraGridRefs` (`shared/graph/connect.ts`) rebuilds the positional reference edges from `refIds`; `mergeCameraGrid` (`productions.ts`) keeps main's sheet/provenance against a stale renderer save, but follows whichever side wrote the sheet more recently via `CameraGridData.sheetAt` (a generation and a grid-image import both write `sheetPath`, so without it an import was reverted to the generated sheet on the next save). Exports land in the `camera-grid` reference category (created on demand) and are placed as canvas ref nodes. |
| Shot sequences | `shared/ipc/shot-sequence.ts` + `production/sequence-bar.tsx` / `production/sequence-graph.tsx` | a span of storyboard shots played as ONE generated clip (Spec 06). **The sequence canvas IS the node graph** — `production/sequence-graph.tsx` is a thin host that renders `NodeGraphModal` on a shot-shaped facade, so every node, shelf, and control is the same one a shot uses; the only differences are its pre-population and that its output binding replaces the span. The state lives on `ShotSequence.graph?: ProductionShot` (the exact shot shape; `id` = sequence id, `number` = its name) — `sequenceGraphShot(seq)` builds the facade, `onGraphField` patches merge straight in, and `mergeShotSequences` (`productions.ts`) defers to `mergeRendererShot` for the sub-document (main owns the take histories, the renderer the wiring/prompts/picks/layout). `shared/ipc/shot-sequence.ts` is the one home for the pure span math: the `ShotSequence` type (ordered `shotIds`, `enabled`/`muted`/`accent`/`durationSec`, `graph`), the projection (`applyShotSequences` — an enabled sequence whose members sit in one contiguous run collapses into ONE item at the run's first slot; the item shows the OUTPUT node's media: a clip plays, an image is held, and an unbound output is a slate block; a span broken by a reorder plays its shots individually, like a disabled one; duration = `seq.durationSec` or the members' sum), the output resolution (`sequenceOutputMedia(seq, { shots, refs })` mirrors the node graph's own output-node logic over `graphOutputSource` + the feeding node's selected take / tween output / reference — including a member frame cited as `seqframe:<shotId>`; `sequenceSelectedTake` is the generated take the delete flow preserves), read repair (`normalizeShotSequences` — dead members pruned, outdated panels kept as live members so a re-ingest preserves sequences and a restore brings them back, and the LEGACY flat model (`videoNodes`/`output`/`graphLayout`) folds into `graph`). A sequence canvas also carries a **timed multi-shot timeline** (`ProductionShot.graphSequence.segments`, `SequenceSegment[]`): one segment per member shot (a per-shot `durationSec` and a prompt that defaults to the frame's effective prompt — Magic when on). The canvas's video generator renders as the **Sequence** node (its clip-length selector seeds from the timeline total) and its prompt node as the `sequenceprompt` type (Style + a "Visuals" body with reference sockets + one row per segment showing the frame, an editable seconds count, the prompt, and Revert, plus a "Sequence Total: N Seconds" footer; the member frames are locked `in-frame-<i>` sockets on the node's left edge, and there is no Brand node or socket). Generation assembles the style-only rendered Visuals followed by one multi-shot line per segment — `"Hard Cut to Shot N. X Seconds. Framing Reference <<<image_K>>>"` + the shot's style-stripped prompt, K = the frame's submitted position — and uploads the member frames in order (first = source, rest = references); the pure segment math (`normalizeSequenceSegments`/`sequenceTotalDuration`/`seedSequenceSegments`/`sequenceSegmentLine`/`stripSequenceFrameTags`) and the timeline migration live in `shot-sequence.ts`. The sequence canvas hides its node palette (`hidePalette`). The bar math (`sequenceBarSpans` — one measured span per grid row). Shift-click ranges on the Step 3 storyboard create a sequence (`createShotSequence(id, frames, existing)`; a shot belongs to at most one — `sequenceOverlapReason`), which seeds the graph with a video-generation node citing every member frame (`@[Shot NNNN]`). The accent bar under the members (default accent cycles; right-click recolors; enable/disable; delete) opens the canvas. The host supplies the member frames as `locked` `GraphRef`s (`sequenceFrameRefs` — live-linked to each shot's current `artwork`, plain name, not renameable or deletable, never `CustomRef`s) plus all real references, and implements the graph's host-computed callbacks locally: the output pipes (`onPipe*ToOutput`/`onUnpipe*`) and take select/cycle patch the graph state, `onRunVideoGen` resolves the video prompt's `@[Shot NNNN]` citations (and any legacy `refIds`) to input ids, strips the frame tags from the vendor prompt, and submits `production:generateSequenceVideo` (main resolves the ids, borrows the first member shot for the shot-parameterized provider call, and relocates the clip to `out/sequences/<id>/` so renumbering can't orphan it). The sequence canvas hides what it has no storage or use for: `NodeGraphModal`'s `hiddenTools` prop drops the image-generation node (and the composer prompt node feeding it) and the shot-only generators entirely — they are not rendered, not draggable, and stripped from a stored graph — leaving the right shelf with **video generation and video editing only** (both are multi-instance, riding `graphVideoNodes`). Its `onRunEditVideo` resolves an edit node's `source` (a sequence video node's selected take, or a reference) and submits `production:generateSequenceEditVideo` (main borrows the first member shot, relocates the clip with `relocateClipToSequence`, and records it on the sequence's video node). `subjectLabel` names the header, and Magic Prompt is hidden. While enabled the span is replaced in the animatic AND the Step 5 export (`assemblyPlan` emits one `SQ<NNNN>` event — clip, held still, or blank — with the member numbers in `skippedShots`; `edlReelFor` names the reel); disabling plays the frames individually. Deleting a sequence — or losing its last member for good (`removeShotsFromSequences`) — preserves its clip first as a video reference in the auto-provisioned "Shot Sequences" category (`saveSequenceVideoAsReference`), warned in the confirm dialog; individual takes delete via `production:deleteSequenceTake`, and a take saves as a reference through `production:saveGenerationAsReference`'s optional `sequenceId`. Persisted as `Production.shotSequences` (additive). |
| Settings registry | `app/src/renderer/src/components/settings/` | The Settings panel's information architecture (Spec 05): a two-pane shell (`SettingsPanel.tsx` — searchable categorized **left rail** + scrollable **section pane**) built from a registry (`registry.tsx`) where each `SettingsSection` (`types.ts`) declares `{ id, title, category, keywords[], owns[], render, onReset? }`. **Presentation only** — persistence stays on `main/settings.ts`'s existing IPC methods, so `settings.json` key names are untouched. `owns` is the coverage contract (`settings-panel.test.ts` asserts every `SettingsView` key is owned by exactly one section, and a compile-time `Record<keyof SettingsView, true>` turns a schema addition into a test failure). Search is a dependency-free fuzzy scorer + label highlighter (`search.ts` — `fuzzyScore`/`matchSections`/`highlightSegments`); the panel keeps every section mounted (hidden when inactive) so deferred edits survive a switch, tracks dirtied sections via `context.tsx`, and guards close with Save/Discard/Cancel. Deep links `#settings/<sectionId>` and `openSettings("providers")` (`open-settings.ts`) select a section; the existing **Model Customizer**, `McpSection`, media-provider toggle, thumbnails, Dev Mode, agents/skills, 3D key, and the **Prompts** editor all fold in as sections (no setting lost or renamed). |

## Core domain terms

- **Harness** — the chat-side methodology that teaches the agent how the user
  works: a set of skills, workflows, and gates (in the spirit of Martin Richards'
  "Building Your Own Agent Harness"). Built around a Research → Plan → Implement
  loop where the agent researches the workspace (`spec:research`), writes a plan
  (`spec:plan`), implements it test-first (`spec:implement`), and validates it
  (`spec:finish`) — backed by `oracle:` advisory and `code:` utility skills.
  **Plan mode** (`AgentConfig.planMode` + `core/src/planmode.ts` `planGate`) is
  the enforced gate: while on, the agent cannot write/edit files or run commands
  until the user approves the written plan. **Autonomous mode**
  (`AgentConfig.autonomousMode`) is the inverse: the approval gate is skipped so
  a long unattended run isn't interrupted (per-chat chip + `/autonomous on|off`,
  alias `/auto`; mutually exclusive with plan mode). The system prompt also
  carries a task-list directive (only when `todo_read`/`todo_write` are present)
  that keeps the durable todo list current — one `running` item at a time, each
  marked `done` the moment its step succeeds. Slash commands (`/research`,
  `/plan`, `/implement`, `/finish`, `/challenge`, `/architect`, `/review`,
  `/commit`, `/plan-mode on|off`, `/autonomous on|off`) expand in
  `app/src/shared/commands.ts` (`expandCommand`).
  The harness is designed to be **engineered** the same way as the software it
  produces — add skills for how you write code, test, and think about design.
- **Production** — one project folder with a 5-step pipeline state machine
  (`Production` in `shared/ipc.ts`). Owns scenes, styles, references, brand, assets.
- **Active Production workspace** — the chat side's folder chip can bind a chat
  to the Production Assistant project the user currently has open instead of a
  fixed folder ("Active Production"). The binding is a per-chat
  `SessionFile.followProduction` flag plus a global `settings.followProduction`
  default for new chats; main records the open project as
  `settings.activeProductionId` on `production:load`/`create`/`import` and
  resolves `activeProductionFolder()` through `productions.getProductionMeta` on
  demand. The resolution is the pure `sessions.resolveWorkspace` (follow wins,
  then pure chat, then the per-chat folder, then the default) consumed by
  `workspaceFor`, so the production folder rides the same
  `AgentConfig.workspaceRoot` sandbox as any folder — no separate agent
  workspace. Opening another project re-points every follower chat
  (`rebindFollowChats` drops their live agents so the next message rebuilds
  against the new root) and main emits `workspace:changed` so the chip re-reads
  `workspace:state` (a `WorkspaceState` of effective folder + follow flag + the
  active production).
- **Image Suite** — the Production Assistant's dedicated image
  generation/editing/upscaling panel (a step-content panel beside Expenses, not
  a top-level view). It runs against the workspace's open production and keeps
  its own non-destructive timeline: every submit is a new `SuiteEntry`
  (branching from the selected entry via `parentId`), outputs live in
  `<outDir>/suite/`. Its three modes (`SuiteMode` = `generate` | `edit` |
  `upscale`) each draw from their own model pool: generate/edit from their
  `image:generate`/`image:edit` surfaces, upscale from the capability list
  (`imageUpscaleModels` — the provider's live upscale probe ∪ the user's
  `image:upscale` assignments). Edit reuses a reference's (or a frame's) current
  image as the source; upscale uploads the source as the sole reference and
  submits no prompt (upscalers reject one). The generate flow always exposes a
  **Style** dropdown drawn from the production's Design styles (None + each
  style): picking one mirrors its prompt text into the draft's Style paragraph
  (read-only preview) and `suite:generate` applies full cohesion — the style
  frame is uploaded at reference 0 and the shared LOOK clause prepended, exactly
  like storyboard generation. The history rail is a flat newest-first list.
- **Reference Moodboard** — the Production Assistant's PureRef-style canvas of
  every custom reference (a step-content panel beside Image Suite and Expenses,
  opened from the workspace's right-hand tab cluster). Nodes reuse the sidebar's
  `RefFigure` visuals at full resolution; placements, viewport, background, and
  notes persist per production on `Production.moodboard` (additive). Navigation
  mirrors the node graph (wheel zoom, middle/right-drag pan) and the minimap
  frame drags live. "Remove from board" hides a node without deleting the
  reference; hidden refs collect in a side shelf and go back on the canvas when
  dragged or clicked.
- **Shot** — the smallest Audio/Visual unit; stable `id`, derived 4-digit `number`.
  The persistent canvas for the node graph (`ProductionShot`).
- **Outdated panel** — a shot preserved when a script is re-ingested rather than
  overwritten. `ingestScript` (`pipeline.ts`) archives every prior shot through
  `archiveShotsToOutdated`: its board folder moves to `boards/outdated/<id>/`
  (so a freshly numbered shot can't collide with it), every stored media path is
  rewritten via the shared `mapShotMediaPaths`/`shotMediaRefs` field list, and it
  is marked `outdated`/`outdatedAt` and appended to `Production.outdatedShots`.
  Outdated shots are not in `scenes`, so numbering, generation, animatic,
  assembly, and `script.md` ignore them; the Step 3 Storyboard renders them as a
  trailing read-only section (`components/production/outdated.tsx`) with restore
  (`restoreOutdatedShot` — fresh number after the global max, files moved back and
  `shot-<number>-` filenames renamed, appended to the last scene) and delete
  (`removeOutdatedShot`). Batches accumulate; `applyRendererState` keeps main's
  bucket authoritative over a stale renderer save.
- **Scene** — ordinal grouping of shots (display only).
- **Reference** — a character / product / custom-referenced image. Artwork lives
  on disk (`imagePath` under `referencesDir`); legacy inline data URLs still read.
  Custom references render in the saved `prod.references` array order (the
  Design grid groups by category preserving that order, and the node editor's
  shelf uses the same array), so dragging a tile onto another's left/right half
  reorders it (`reorderRefs` in `references.tsx`, persisted by `saveField`); a
  drop across categories also adopts the target's category. A dragged-in image
  whose derived name already exists gets a two-digit suffix (`uniqueRefName`:
  "Gondola" → "Gondola 01") instead of colliding/merging. Editing a reference
  externally (its `imagePath`/`mediaPath`) is caught **immediately** by
  `createRefWatcher` (`app/src/main/ref-watch.ts`): main follows the open
  production's reference files with per-directory watchers (reconciled on every
  `production:load`/`production:save`, `mtimeMs`/`size` signatures), re-copies a
  changed reference into every storyboard frame that pipes it to the output
  (`refreshRefCopyFromFile`), and emits `references:externalUpdate` (`onReferencesExternalUpdate`)
  so the renderer bumps the file's revision (`bumpMediaRev` → `cascadeMedia`'s
  `?v=`, which fronts the strong-ETag revalidation) and re-fetches every surface
  painting it — Design grid, node shelf, moodboard, suite — without a
  whole-document reload, so unsaved edits survive. The node canvas already read
  the live reference; the focus sweep (`checkExternalEdits`) stays as a fallback.
- **Character sheet** — the generated reference image for a character (built by
  the Step 2 character builder): a full body shot (front, or front + back) with a
  face-closeup inset, always neutral pose/expression/lighting on a plain gray
  background with no text overlays. Its prompt framing lives in `characterSheetPrompt`
  (`pipeline.ts`); sheets are always generated 16:9. The builder's last
  description + generation settings persist per character (`CharacterSheet.builder`),
  and every generated sheet is mirrored into the references panel's **Characters**
  category (`upsertCharacterSheetRef`) so it's citable as `@[name]`. The
  description box is a full `ReferencePromptEditor`: `@[name]` tags cite other
  references as visual inputs (typed via @ autocomplete, or dropped in from the
  references panel as `application/x-cascade-reference`), resolved by
  `resolvePromptRefs` in the generation handler and uploaded alongside the sheet; Refine strips the tags, refines the prose, and re-attaches them.
- **Style** — a named generation prompt (up to 5); `styles[0]` is the master.
- **Style frame** — a style's look anchor: one conditioning image on disk
  (`ProductionStyle.imagePath` under `styles/`, with `frameSource`
  upload/generated/reference/anchor) reused at reference index 0 on every shot
  that resolves to the style, cited by the verbatim LOOK clause as a look
  (never a subject). Authored in Design (generated look plate, upload, kept
  from style-from-image, or locked from an approved frame via `anchorShotId`);
  the board-wide `lookSeed` + frozen model/resolution make it repeatable.
  Styles without a frame keep the text-only behavior. A generated style frame
  whose async job outlives the wait is kept as `ProductionStyle.pendingImageGen`
  (`frameSource` stays unset) and reclaimed by `production:recheckStyleFrame`;
  style changes persist through the job rebase (the `styles` field is copied,
  like `characters`/`references`).
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
  `image:edit` (classic edit popup + edit-image node), `image:upscale`
  (upscale node + the Image Suite's Upscale mode), `video:generate`
  (video modal + video node), `video:tween` (in-betweener), and
  `video:editnode` (edit-video node). `normalizeModelSurfaces` (`shared/ipc.ts`)
  migrates the old per-picker keys (`image:master|node|reference|character`,
  `image:editnode`, `video:modal|node`) onto their pools on read.
  `video:tween` and `image:upscale` are **opt-in** (never in the default set):
  assigning a model to `video:tween` IS the user's end-frame capability
  declaration, unioned with the live probe in `production:videoEndFrameModels`
  (there is no separate manual allowlist); assigning a model to `image:upscale`
  adds it to `production:imageUpscaleModels`, which unions the probe with the
  declared ids. It also owns **pricing** (the former Settings → Models &
  expenses tab, now removed): the model list shows a read-only price range
  column and the details pane edits a model's min/max rule (re-priced on save
  by `ledger.setPriceRules`) with CSV import/export. `settings.
  hiddenMediaModels` remains the single visibility control.
- **Edit-video node** — a **multi-instance** node-graph node that edits one
  video. It is an `edit`-mode entry in the shot's `graphVideoNodes` list
  (`mode: "edit"`, ids `ev0`, `ev1`, … — distinct from the generate-node ids
  `vid0`, `vid1`, …) rather than a flat singleton; the legacy `graphEditVideo*`
  fields migrate into a single `ev0` entry (`migrateEditVideoNodes`, one-way and
  cleared after) and are never written again. It has a **source socket**
  (`in-video`: any video node's output — generate or edit — or a video
  reference, or the shot's own video when nothing is wired; stored as
  `{kind:"video",nodeId}` / `{kind:"ref",refId}`); references ride the
  edit-video prompt node's Reference sockets (cited as `@[name]` tags and
  resolved main-side, exactly like the video node). Its model list is the
  intersection of the `video:editnode`
  surface and the provider's live video-input probe (`videoEditModels()`);
  submission rides `MediaProvider.generateVideoEdit` (Higgsfield CLI builds
  `--video-references` from the source). Its icon is `EditVideoIcon`
  (`assets/icons/video-editing.svg`). Like the other generation nodes it has a
  dedicated **prompt node** (`editvideoprompt`, the shared `PromptNodeView`
  body, writing the entry's `prompt`) whose Style/Reference/Brand sockets work
  exactly like the video/edit prompt nodes. Piping it to the output sets
  `graphOutputSource: "videogen"` + `graphOutputVideoNodeId` (the legacy
  `"editvideo"` output member is migration-only). Selecting/cycling its takes
  routes through the shared video-node kind + node id. The edit-video node is
  **disabled when the active provider has no video-edit path**
  (`providerSupportsVideoEdit` in `shared/ipc/media.ts`; only the Higgsfield
  CLI implements `generateVideoEdit`/`videoEditModels`, so both OpenArt
  transports are gated) — the palette tile and `addTool` block it with
  `VIDEO_EDIT_UNAVAILABLE_HINT`, mirroring the upscale node's OpenArt gate;
  the sequence canvas has a sequence-scoped edit handler
  (`production:generateSequenceEditVideo`).
- **Node graph** — per-shot canvas of reference/composer/style/brand/output nodes
  whose persisted state lives on `ProductionShot.graph*` fields. **Edit-image
  nodes** are a list (`graphEditNodes: GraphEditNode[]`), not a singleton: each
  has its own prompt, generation history, and `source` pipe (the image node,
  a reference, or a parent edit node), so any edit can daisy-chain into
  another (cycle-checked in `NodeGraphModal`). The output names its feeding
  edit via `graphOutputEditNodeId`; the video source via
  `graphVideoSourceEditNodeId`. **Video-generation nodes** are likewise a list
  (`graphVideoNodes: GraphVideoNode[]`, mirrors `GraphEditNode`): each owns its
  motion `prompt`, clip history (`gens`/`genIndex`), `source` frame
  (`imagegen`/`editgen`/`ref`/`video`), `refIds`, model/resolution/length/params,
  and `styleConnected`. The list holds **both modes**: absent/`generate` entries
  (`vid0`…) are the video-generation nodes; `mode: "edit"` entries (`ev0`…) are
  the **edit-video nodes** (the same pair machinery, a video-edit model surface,
  and an `in-video` source). Canvas ids are `videogen:<id>`/`videoprompt:<id>`
  for generate entries and `editvideo:<id>`/`editvideoprompt:<id>` for edit
  entries (the first of each keeps the historical bare `videogen`/
  `videoprompt`/`editvideo`/`editvideoprompt` ids and edge ids for backward
  compatibility; extra nodes suffix `:vid1`…/`:ev1`…), the output is named by
  `graphOutputVideoNodeId` (it may name an edit-mode entry), and the legacy flat
  `graphVideo*` fields migrate into `vid0` (`migrateVideoNodes`) and the flat
  `graphEditVideo*` fields into `ev0` (`migrateEditVideoNodes`) on load.
  Dragging either palette tile appends another node; deleting one node's pair
  removes that node.
  The classic Edit-frame popup appends a new edit
  node to whatever chain currently feeds the output (`chainSourceForEdit` +
  `recordBoardEdit` in `pipeline.ts`) and binds it as the output — the wiring
  shows up in the graph automatically. A prompt node's leading `Style:`
  paragraph is **rebuilt from the live style** while it is plugged into the
  style node (`mirrorStyleParagraph`, `shared/prompt-grammar.ts`): the style
  node is a passthrough, so editing a style's description on the Design page
  mirrors into every plugged prompt (composer, video, and each edit node) — not
  only the text baked in at connect time. Each generator's prompt→generation
  wire is **structural** (emitted by the materializer, and by `ensurePromptPipe`
  when a tool is dragged onto the canvas mid-session — it is not hand-connectable).
  Dragging a generation node's output onto any prompt reference socket copies the
  selected take into the production as a new reference
  (`production:saveGenerationAsReference`) and wires the new ref node into that
  socket (tagging the prompt), so a generated frame/clip can be reused as input
  without a separate right-click Save as reference.   **Reference nodes** show the
  artwork with its editable name beneath it (renaming rides the same
  `renameReference` atomic tag rewrite as the Design page) and an eye button that
  collapses the tile to a fixed narrow width with a small compressed thumbnail to
  the right of the name; the expanded size stays in `GraphLayout.sizes` (restored
  on expand) and `GraphLayout.collapsed` remembers the collapsed state.
  Double-clicking the artwork opens the lightbox. The graph's **reference side
  shelf** is resizable (width persisted per production at
  `cascade.prod.<id>.graph.shelfWidth`, `usePersistedNumber`), and pulled wider
  than its default it lays each category's tiles out as a wrapping grid instead
  of a one-column list. Shelf tiles always render the compressed
  `?thumb=1` artwork; each carries a magnifier that opens the full-res media in
  the lightbox. (The reference tile and the shelf are extracted modules —
  `components/graph/ref-node.tsx` and `components/graph/ref-shelf.tsx` — shared
  with the shot sequence canvas.) Saving a take as a reference (right-click → Save as reference,
  routed through the async `onSaveGenerationAsReference` resolver so the created
  ref is known) opens the shelf, clears its filter, and pulses/scrolls the new
  tile into view; the fire-and-forget `onSaveAsReference` is the fallback when
  no resolver is wired. **Magic Prompt is tag-authoritative**: its `@[name]`
  citations live in the effective prompt text (`magicPrompts`), not in the
  stored graph's edges, so when it is active `NodeGraphModal` reconciles the
  composer's ref sockets to the tag order via `wireComposerRefs`
  (`shared/graph/connect.ts` — adds the ref node + positional `ref→composer`
  edges, idempotent) and the citations show wired.
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
- **Camera grid** — the camera-grid graph node: one generated cols×rows sheet of
  camera angles of its source image, in **4×4 (16) / 3×3 (9) / 2×2 (4)**. The
  node's grid-size dropdown (`CAMERA_GRID_SIZES`) sets the geometry used for
  generation (the `cameraGrid` prompt is rendered with `cameraGridPromptVars` so
  the cell count and the size-scaled `{{distribution}}` clause follow it) and
  re-divides the export panels; changing it never regenerates. The node shows a
  clickable thumbnail; clicking it opens the full-res **`CameraGridEditor`**
  popup, where clicking a cell selects it (Shift-click adds/removes; a drag box
  selects every cell it touches) and a global **inset** slider shrinks every crop
  proportionally (removing the gutters between cells) before exporting each pick
  as a standalone reference. The editor carries the same grid-size dropdown, so a
  grid image imported/piped in can declare its true size (the dividing window
  follows it). It takes a **style socket** (`in-style`, the top socket: a wired
  style prepends the shot's effective style to the prompt), a source-image
  socket (`in-image`: the image node's frame,
  an edit node's edit, or a reference, falling back to the shot frame) plus
  reference sockets, and carries its own model/resolution/params; its prompt is
  the shared `cameraGrid` template (Settings → Advanced → Prompts), never a
  per-node copy, and its submission is the same `submitGraphImage` path as the
  edit-image node (only the prompt differs). A second single-image socket
  (`in-grid`, "Grid image", pinned to the bottom in its own orange) takes an
  already-made grid to cut panels out of
  instead of generating one — the manual fallback when the auto download fails.
  Wiring it calls `cameraGrid:importGridImage`, where main resolves the source
  to bytes and writes a copy into `referencesDir/grids/` (the cutout handler
  requires the sheet to live in the references folder), returning its path; the
  renderer then sets `sheetPath` + `gridSource` + `sheetAt` itself (production
  state stays renderer-owned — main only writes the file). Generating a fresh
  sheet clears `gridSource` (the wire is superseded). Its state lives on
  `ProductionShot.graphCameraGrid` (`gridSource?: GraphSource` alongside
  `source`). Export crops happen in main (never a renderer
  canvas), so the exported PNGs are pixel-identical to the sheet.
- **Upscale node** — a graph node with one source-image input (`in-image`: the
  image node's frame, an edit node's edit, or a reference, falling back to the
  shot frame) and one image output that feeds the output node. It offers only
  the models on the `image:upscale` capability list (`production:imageUpscaleModels`
  — the provider's live probe ∪ the user's surface assignments), carries its own
  model/resolution/params, and submits through the same `submitGraphImage` path
  as the edit-image node with an **empty prompt** (upscalers such as Higgsfield's
  `bytedance_image_upscale`/`topaz_image` reject `--prompt`; the CLI provider
  emits it only when the model's schema declares one). Models that require
  explicit output dimensions (Topaz declares `output_width`/`output_height` with
  no default) get a 2× target derived from the source image's own pixels via the
  pure `imagePixelSize` header reader (`providers/image-size.ts`); a user-set
  dimension in the node's Advanced options always wins. Outputs are stored on
  `ProductionShot.graphUpscale` (`gens` history, files written via
  `writeBoardFrame`); piping it to the output makes the upscaled frame the shot's
  artwork. Its state is merged main-side by `mergeUpscale` so a stale renderer
  save can't revert a finished upscale.
- **Shot sequence** — a span of storyboard shots played as one generated clip.
  Created from a shift-click range on the Step 3 storyboard; its accent bar
  opens the sequence's canvas, which **is the ordinary node graph**
  (`NodeGraphModal`) hosted on the sequence — pre-populated with the member
  frames as locked image nodes and a video generator rendered as the **Sequence**
  node, with image generation and the shot-only generators hidden (the shelf
  keeps video generation and video editing) and its node palette is hidden
  (`hidePalette`). The canvas's prompt node is the `sequenceprompt` type:
  Style, a **Visuals** body (reference sockets + the shared description), and one
  **timeline row per member shot** (an editable seconds count, a per-shot prompt
  seeded from the frame's **style-stripped** effective prompt with Revert, and a
  "Sequence Total: N Seconds" footer; the whole timeline persisted on
  `ProductionShot.graphSequence.segments`). The member frames are locked
  **`in-frame-<i>` sockets on the node's left edge** (beside Style/Reference),
  not inset into the rows, and a sequence canvas has **no Brand node or
  socket**. The generator's clip-length selection seeds from the timeline total.
  Generation assembles the rendered Visuals (Style only — no brand) followed by
  one multi-shot line per segment —
  `"Hard Cut to Shot N. X Seconds. Framing Reference <<<image_K>>>"` + the
  shot's prompt, where K is the frame's position among the submitted refs
  (style/Visuals first) — and uploads the member frames in order. When an
  output is piped, that output replaces the encompassed frames in
  the animatic and the Step 5 export; deleting the sequence preserves its clip as
  a "Shot Sequences" reference first. See the Shot sequences module row.
- **Animatic** — Step 4 playback: timing, voiceover, music, per-shot video clips. A clip block can carry a `videoOffsetSec` slip offset (right-drag the block): the timeline window stays put while the source frame it opens on shifts — honoured by the preview, the export render, the EDL source window, and the AE in-point alike. The block also shows an end-of-video marker (source remainder past the slip) that the trim edge snaps to.
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
- **`magicPrompts` is main-owned, keyed by shot id.** Every renderer magic edit
  goes through `production:updateBoardPrompt` (never a whole-document save —
  `applyRendererState` ignores the incoming map, like `promptOverrides`), and
  bulk/per-shot generation writes it main-side. A long generation job rebases
  only the keys it changed (`applyMagicPromptDelta`), so a snapshot captured
  before the job can't revert or blank another shot's prompt. The node-graph
  composer's draft is scoped to its shot (`NodeGraphModal` is keyed by
  `graphShotId`), so a frame switch flushes the departing draft to its own shot
  instead of copying it onto the next, and it **publishes every edit to the
  shared `focusedPrompt` live** — the composer and the classic side panel are
  two views of one prompt and must never diverge. That live prompt is itself
  **shot-scoped** (`focusedPromptShot`): the editor only renders `focusedPrompt`
  when it belongs to the focused shot, and the side panel is keyed by
  `promptShotId`, so no stale/async write can surface one frame's prompt under
  another. Prompt reads never block on the save queue indefinitely (bounded
  300ms race), so a save stuck behind a generation can't leave the side panel
  blank.
- No ADRs exist yet; if a future review rejects a deepening with a load-bearing
  reason, record it as an ADR here.