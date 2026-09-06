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
| OpenArtClient | `app/src/main/openart.ts` | The whole OpenArt integration: model discovery, live form-schema introspection, per-model option assignment, async image/video generation + polling, project resolution, video-options cache. Takes the `McpManager` as its constructor seam — that interface IS the test surface. |
| MCP manager | `app/src/main/mcp.ts` | Connecting/owning MCP servers; namespaced tools; the `callRaw*` host-side call surface OpenArtClient uses. |
| ModelgenClient | `app/src/main/modelgen.ts` | The 3D AI Studio REST integration: Tencent Hunyuan Pro text/image-to-3D generation (submit → poll → download), GLB bytes + credit balance. Takes the API key getter and an `HttpFetch` as constructor seams — that injection IS the test surface (`app/test/modelgen.test.ts`). |
| Pipeline | `app/src/main/pipeline.ts` | Prompt derivation + deterministic transforms (script breakdown, board prompts, animatic planning). Receives `ImageGenFn` from OpenArtClient — never imports it. |
| Assembly | `app/src/main/assembly.ts` | Step 5 editor handoff + render: media gathering into `out/assembly/`, CMX3600 EDL, After Effects rebuild `.jsx`, manifest, and the 3-pass ffmpeg render. Pure builders are unit-tested; `assemble()`/`renderAnimatic()` take an injected ffmpeg `run`/`probe` seam (`app/src/main/ffmpeg.ts`). |
| ffmpeg seam | `app/src/main/ffmpeg.ts` | Locating the ffmpeg binary (bundled `ffmpeg-static`, asar-unpacked when packaged, else PATH) + `runFfmpeg`/`probeMedia` that `assembly.ts` injects. Pure node — never imports Electron. |
| Production store | `app/src/main/productions.ts` | Production document persistence + migration. |
| Expense ledger | `app/src/main/ledger.ts` | The running tally of every AI generation + manual purchased-asset rows: price-rule matching (`matchPriceRule`), the `userData/ledger.json` singleton, and the human-readable `userData/expenses.csv` mirror. Receives generations via `OpenArtClient`'s `onGeneration` constructor seam — that injection IS the test surface. |
| Document store | `app/src/main/store.ts` | The generic JSON-document store (`createStore`) behind sessions, productions, and agents: atomic temp+rename writes, newest-first list, archive/ soft-deletes, decode/encode hooks, side-file hooks. Settings stays a bespoke singleton (encryption + memo cache). |
| IPC contract | `app/src/shared/ipc.ts` | The single channel map (`ipcContract`) that derives the renderer API, drives the preload adapter, and validates every main-process handler. Adding a channel = one contract entry, not three files. |
| Production views | `app/src/renderer/src/components/production/` | The workspace's extracted panels — `animatic.tsx` (Step 4 playback engine + timeline), `boards.tsx` (board cards + gen modals), `prompt-panel.tsx`, `references.tsx`, `brand.tsx`, `hex.ts`, `assembly.tsx` (Step 5 export package + render) — orchestrated by `ProductionWorkspace.tsx`. |

## Core domain terms

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
- **Brand** — palette swatches + optional font appended to every board prompt.
- **Board** — a shot's generated frame (`artwork` on the shot, in `boardsDir`).
- **Expense rule** — a pricing rule (kind + model + resolution + optional video
  length → dollar price) the user configures in Settings; exact matches beat
  wildcards, and generations matching none are priced at $0. Prices are stamped
  at record time, so editing a rule never reprices history.
- **Node graph** — per-shot canvas of reference/composer/style/brand/output nodes
  whose persisted state lives on `ProductionShot.graph*` fields.
- **In-betweener** — a node-graph node that interpolates 2–5 keyframe references
  into one continuous shot. One **action block** = 1 start keyframe + 1 end
  keyframe + 1 action prompt (`TweenBlock` in `shared/ipc.ts`); each block
  generates its own start→end clip via `generateTweenBlock`, keeps per-block
  history (`gens`/`genIndex`, with a `Keyframes` view), and the selected clips
  stitch via `stitchTween` (lossless `-c copy` concat, re-encoded preview
  fallback flagged on `graphTweenReencoded`). The stitched clip feeds the frame
  output node (`graphOutputSource === "tween"`); the assembly package always
  lays the ORIGINAL per-block clips back-to-back (`TW<NNNN><X>` EDL reels) so
  no recompression reaches the editor handoff. Block derivation
  (`deriveTweenBlocks`, pair-key preservation, 1–15s gaps, 15s cap) lives in
  `pipeline.ts`; the timeline modal mirrors it client-side for display.
  End-frame capability is probed from each video model's live form schema
  (`endFrameSlotKey`, shared by the submit path and the probe): the tween
  model lists show only proven end-frame models (Auto always stays, and Auto
  itself prefers them), falling back to the full video list when none is
  proven — unproven models still receive both frames via the array fallback.
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
duplication to consolidate there (main, renderer, and OpenArtClient all import
it):

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