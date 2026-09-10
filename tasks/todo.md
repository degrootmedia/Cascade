# Rescan references folder button (design page)

User request: a button on the design page's reference panels that rescans the
production's `references/` folder so images added externally show up.

## Plan

- [ ] Contract: `scanReferencesFolder(productionId): Promise<Production>` in `shared/ipc.ts` + channel entry in `shared/ipc-channels/production.ts` (preload follows mechanically).
- [ ] Pure derivation `unclaimedReferenceFiles(files, p)` in `main/productions.ts` — image files no reference/character/product claims via `imagePath`/`mediaPath`.
- [ ] Handler `production:scanReferencesFolder` in `main/index.ts` — readdir referencesDir (image extensions only), adopt orphans (name from filename; fill a same-name empty ref instead of duplicating), save + emit.
- [ ] UI: "Rescan folder" button in `ReferenceCategorySection` (references.tsx), wired through ProductionWorkspace (`setProd(next)` + `refreshList()`).
- [ ] Tests for `unclaimedReferenceFiles` in `app/test/productions.test.ts`.
- [ ] Verify: `npm run typecheck`, `npm test` in `app/`.

## Review

Done. Clicking **Rescan folder** (design page → References, next to "Add
category") runs `production:scanReferencesFolder`:
`main/index.ts` lists image files (png/jpg/jpeg/webp/gif) in the production's
`references/` folder, `unclaimedReferenceFiles` (`main/productions.ts`, unit-
tested) filters out every path claimed by a character/product/reference via
`imagePath`/`mediaPath`, and each orphan is adopted — a new reference named
from the filename, or a same-named imageless reference filled in. Saved,
logged via the production event stream, and returned so the renderer refreshes
via `setProd(next)`. Verified: `tsc --noEmit` clean, 472 tests pass.

# Refresh Storyboard Images button (storyboard panel)

User request: a **Refresh Storyboard Images** button on the storyboard toolbar
— after the "Export storyboard PDF" button, separated by a vertical divider —
that re-links broken storyboard frame paths.

## Plan

- [x] Pure `refreshBoardLinks(p)` in `main/pipeline.ts` — for each shot, scan
      `boards/<number>/shot-<number>-*.jpg` and repoint every path that no
      longer exists on disk (`artwork`, `artworkHistory`,
      `graphImageGens[].path`, `graphEditGens[].path`) to the newest existing
      frame; valid paths untouched. Returns the count of repaired links.
- [x] Contract: `refreshBoardLinks(productionId): Promise<Production>` in
      `shared/ipc.ts` + channel `production:refreshBoardLinks` in
      `shared/ipc-channels/production.ts` (preload + contract guard follow
      mechanically).
- [x] Handler in `main/index.ts` — load production, run the pure re-link, save
      when anything changed, emit a log line, return the production.
- [x] UI: divider + **Refresh Storyboard Images** button in the
      `.prod-boards-controls` row of `ProductionWorkspace.tsx`, wired through
      `refreshBoardLinks()` (calls the IPC, `setProd(next)`, `bustAll()`,
      `refreshList()`).
- [x] Tests in `app/test/refresh-board-links.test.ts` (4 cases: broken artwork
      repointed, valid artwork untouched, history + node-gen paths mixed,
      missing board folder no-op).
- [x] Verify: `npm run typecheck`, `npm test` (487 pass), `npm run build`.

## Review

Done. The toolbar now reads … **Export storyboard PDF** | divider |
**Refresh Storyboard Images**. Clicking it runs `production:refreshBoardLinks`:
`refreshBoardLinks` (`main/pipeline.ts`) scans each shot's per-shot board
folder (`boards/<number>/shot-<number>-*.jpg`) and repoints every frame path
that no longer resolves on disk — artwork, artwork history, and both
node-graph generation nodes (image + edit) — to the newest existing frame;
paths that still resolve are left alone. Main saves + logs when any link was
repaired and returns the production; the renderer refreshes state and busts
every card thumbnail. Verified: `tsc --noEmit` clean, 487 tests pass, `npm run
build` succeeds.

# Node graph reference thumbnails (small compressed JPEGs)

User request: on large projects the node view loads slowly. The node-graph
reference thumbnails should be small compressed JPEGs — full resolution is
only needed when the user enlarges with the zoom button, or when the image is
actually sent in a prompt (which main reads from disk via `assetPath`, so it's
unaffected by what the renderer displays).

## Plan

- [ ] `main/thumbnails.ts` (new deep module): `loadRefThumbnail(absPath)` —
      soft-imports Electron's `nativeImage` (mcp.ts pattern), resizes to a
      256px max edge, compresses to JPEG (~65), caches by path+mtime with a
      bounded LRU-ish eviction. Returns `null` when nativeImage is absent
      (tests) or the file isn't a decodable image — caller falls through.
- [ ] Wire `?thumb=1` into the `cascade-media` protocol handler
      (`registerMediaProtocol` in `main/index.ts`): query param routes to the
      thumbnail module; on failure serves the full file as before. Full-res
      URLs and prompt sends are untouched.
- [ ] Renderer (`NodeGraphModal.tsx`): `refThumbUrl(artwork)` helper —
      `cascade-media://…` URLs get `?thumb=1`, legacy inline data URLs pass
      through. Reference nodes (`RefNodeView` + `buildDerived` +
      `addPlacedRef`), the side shelf items, and tween keyframe tiles display
      the thumb; the zoom lightbox + context menu keep the full `artwork`.
- [x] Tests: renderer (`ref-thumb.test.ts`) — canvas node + shelf `<img>` srcs
      carry `?thumb=1`, zoom opens the lightbox with the full-res URL; main
      (`thumbnails.test.ts`) — `loadRefThumbnail` returns null without
      nativeImage / for missing files (fallback path).
- [x] Verify: `npm run typecheck`, `npm test`, `npm run build` in `app/`.

## Review

Done. The node view now loads compressed thumbnails, not full-res files:

- **Protocol level** — `cascade-media://…?thumb=1` serves a small JPEG.
  `thumbnails.ts` (`loadRefThumbnail`) soft-imports Electron's `nativeImage`
  (mcp.ts pattern), resizes to a 256px long edge, compresses to JPEG q65, and
  caches by path+mtime (bounded at 500). `registerMediaProtocol` routes the
  query there and falls through to the full file on any failure (missing file,
  non-decodable format like SVG, or nativeImage absent).
- **Renderer** — `refThumbUrl` (`NodeGraphModal.tsx`) turns disk-backed
  `cascade-media://` artwork into `?thumb=1` variants (legacy inline data URLs
  pass through). Canvas ref nodes (`buildDerived`/`addPlacedRef` →
  `RefData.thumb`), the side shelf, and tween keyframe tiles all display the
  thumb. The zoom lightbox and the image context menu keep the full-res
  `artwork`; prompt sends were never affected (main reads the original from
  disk via `assetPath`).
- Verified: `tsc --noEmit` clean, 497 tests pass (2 new files:
  `ref-thumb.test.ts` + `thumbnails.test.ts`), `npm run build` succeeds.

# Regenerate thumbnail cache button (older projects)

User request: make the compressed-thumbnail improvement apply to older
projects too — a button in Settings that pre-creates all the low-res
thumbnails up front, so large projects don't pay the first-open decode cost
and the cache survives restarts.

## Plan

- [x] `main/thumbnails.ts`: versioned durable cache under
      `userData/thumb-cache/` — entries are `<sha1(abspath)>-<mtimeMs>-<size>.jpg`
      (version in the filename ⇒ a cache hit is valid exactly while its source
      is the same file; no stale-entry race). `loadRefThumbnail` now serves
      memory → disk → encode; `regenerateRefThumbnails(paths)` pre-encodes
      (idempotent, reuses valid entries, yields every 16 so the main process
      stays responsive) and prunes entries whose source file is gone.
- [x] `main/productions.ts`: pure `referenceImagePaths(p)` — absolute asset
      paths for every artwork-bearing character/product/reference.
- [x] Contract: `regenerateThumbnails(): Promise<{ generated; fromDisk;
      failed; projects }>` on `CascadeApi` (`shared/ipc.ts`) +
      `settings:regenerateThumbnails` channel (`ipc-channels/workspace.ts`).
- [x] Main handler (`index.ts`): iterate `listProductions()` →
      `referenceImagePaths` → `regenerateRefThumbnails`; wire
      `setThumbCacheDir(userData/thumb-cache)` at startup.
- [x] Settings UI: **Regenerate thumbnail cache** button + result line in the
      General tab (after Skills).
- [x] Tests: `thumbDiskPath` versioning + prune-keeps-resolving-entries +
      failed-count (no nativeImage) in `thumbnails.test.ts`; `referenceImagePaths`
      in `productions.test.ts`.
- [x] Verify: `tsc --noEmit` clean, 501 tests pass, `npm run build`.

## Review

Done. Settings → General → **Regenerate thumbnail cache** pre-encodes the
compressed JPEGs for every production's reference images (characters,
products, custom refs) into a durable `userData/thumb-cache/` directory, so
older/large projects load the node view fast on every launch — not just the
first. Entries are versioned by source mtime+size in the filename
(`<sha1>-<mtimeMs>-<size>.jpg`), so a hit is valid exactly while its source is
unchanged; the button reuses valid entries (idempotent) and prunes ones whose
source file is gone. `loadRefThumbnail` serves memory → disk → encode, so the
`?thumb=1` protocol path works with or without the pre-warm. UI shows a result
line (`N projects · X created · Y reused · Z skipped`). Verified:
`tsc --noEmit` clean, 501 tests pass, `npm run build` succeeds.

# Node-graph shelf performance (large projects)

Opening the node editor in large projects is slow: the shelf renders every
reference's `?thumb=1` tile at once (unbounded `cascade-media://` loads).

## Plan

- [ ] `production/persisted-state.ts`: `usePersistedCollapsed(key, initial?)` —
      absence means `initial`; explicit open persists `"0"` (was: removed).
- [ ] `NodeGraphModal.tsx`: `ShelfThumb` — `cascade-media://` thumbs load only
      after first paint + when scrolled into view (IntersectionObserver,
      200px margin) + max 4 in-flight (module semaphore, released on
      load/error/unmount); data-URL artwork + canvas nodes render as today
      (plus `loading="lazy"`).
- [ ] `NodeGraphModal.tsx`: `ShelfGroup` windowing (first 24 + Show more),
      auto-collapse groups over 24 refs, `query` filter prop; shelf header gets
      a filter input.
- [x] Tests in `app/test/graph-shelf.test.ts`: small groups still expanded,
      large group windowed + auto-collapsed + show-more, filter narrows items.
- [x] Verify: `npm run typecheck`, `npm test` in `app/`.

## Review

Done. The shelf no longer mounts every tile + thumbnail at once:

- `ShelfThumb` (`NodeGraphModal.tsx`): disk-backed thumbs arm only when the
  tile scrolls near the viewport (IntersectionObserver, 200px margin) and
  while one of 4 load slots is free (module semaphore, released on
  load/error/unmount); data-URL artwork renders immediately, rows always
  render with a blank placeholder holding layout. Canvas ref tiles got
  `loading="lazy"`. Dropped an earlier first-paint gate — viewport + slots
  are the real wins, with no hang mode when rAF stalls.
- `ShelfGroup`: renders the first 24 matching tiles + Show more, groups over
  24 refs start collapsed (persisted choice still wins), shelf header has a
  name filter (`qShelfMatch` shared with the no-match empty state).
- `usePersistedCollapsed(key, initial?)`: absence means `initial`, explicit
  open persists `"0"` (was: entry removed) so new defaults don't fight the
  user's choice; existing callers keep `initial = false`.
- Tests: new scale cases in `graph-shelf.test.ts`, lazy-gating case in
  `ref-thumb.test.ts` (controllable IO stub; old immediacy assertions kept
  for the no-IO environment). Verified: `tsc --noEmit` clean, 504 pass +
  1 pre-existing skip.
