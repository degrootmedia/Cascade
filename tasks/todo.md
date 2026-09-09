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
