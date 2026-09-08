# Media model dropdowns: memory, eyeball, reorder

## Plan

### 1. Remember last chosen model + settings (all generation dropdowns)

New settings-backed memory, global per dropdown context (survives restarts):

- `settings.mediaDefaults: Record<context, { model?, resolution?, durationSec?, aspectRatio? }>`
  - contexts: `image` (Step-3 sidebar + graph image node), `video` (video modal + graph video node),
    `edit` (edit-frame modal + graph edit node), `reference` (ref gen modal),
    `character` (character builder), `tween` (in-betweener timeline)
- IPC: `settings:getMediaDefaults` / `settings:setMediaDefault(ctx, patch)` (merge per context)
- Renderer seam: `production/media-defaults.ts` — `primeMediaDefaults()` (async cache warm),
  `getMediaDefault(ctx)` (sync), `rememberMediaDefault(ctx, patch)` (optimistic + fire-and-forget).
  Components import it directly — no prop threading.
- Per dropdown: seed initial state from remembered (validated against the current list, existing
  fallbacks unchanged); onChange remembers. Existing per-shot/per-production persistence stays
  (prod.openArt, CharacterSheet.builder, shot.graphTweenModel) — remembered value is the default
  when those are unset.
- Step-3 sidebar also syncs `prod.openArt` to the displayed model so Generate Storyboard always
  matches the dropdown, and new productions seed from the last chosen model.

### 2. Eyeball icon — hide hidden models in Models & expenses (visual only)

- Session-only toggle in the tab (default: hidden rows shown, current behavior).
- New Eye/EyeOff SVG icons + icons.tsx exports.
- When off: hidden rows are skipped in each group + a "N hidden models not shown" hint.

### 3. Drag to reorder models (order persists in dropdowns)

- `settings.mediaModelOrder: string[]` (provider-namespaced model ids, cleaned/dedupe/cap).
- IPC: `settings:getMediaModelOrder` / `settings:setMediaModelOrder`.
- Shared helper `sortByModelOrder` (ipc.ts, next to isImageModel/isVideoModel); applied in
  `production:openArtModels` main-side so EVERY dropdown follows the saved order.
- Settings tab: rows drag-reorder within their provider+kind group (row-level drop targets with
  insert highlight; drop on group padding still re-classifies kind, unchanged); reorder persists
  immediately + dispatches the provider-changed event so dropdowns re-read.

### Tests

- `app/test/media-models.test.ts`: sortByModelOrder (known order, unknown-last stable, empty
  order) + isImageModel/isVideoModel classification.
- Verify: `npm run typecheck`, `npm test`, `npm run build` in `app/`.

## Files

- shared/ipc.ts (types, contract, sortByModelOrder), main/settings.ts (2 new settings),
  main/index.ts (4 handlers + sort in openArtModels)
- renderer: production/media-defaults.ts (new), ProductionWorkspace.tsx, NodeGraphModal.tsx,
  boards.tsx, references.tsx, TweenTimelineModal.tsx, SettingsPanel.tsx, icons.tsx + 2 SVGs,
  styles.css
- app/test/media-models.test.ts (new)

## Review

Implemented as planned. Verification: `npm run typecheck` ✓, `npm test` 413 passed ✓
(8 new in `app/test/media-models.test.ts`), `npm run build` ✓.

Deviations / notes:
- `production/media-defaults.ts` degrades to cache-only when `window.cascade`
  lacks the API (test harnesses stub a subset) — first full-suite run caught it.
- Fixed a latent no-op: the "cascade:media-provider-changed" listener only
  updated the provider id (same-value setState never refetched the models), so
  hidden/kind/reorder changes wouldn't re-sort dropdowns. It now refetches the
  model list directly.
- Graph image node: `prod.openArt` (per-production persistence) wins when set
  and valid; the remembered choice fills the gap — matches the glossary rule.
- Eyeball toggle is session-only by decision; reorder persists immediately and
  dispatches the provider-change event so dropdowns re-read the sorted list.
