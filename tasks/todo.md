# Import existing production folders

## Problem
A Cascade production folder (boards/, script.md, voiceover/, etc.) that isn't
registered in `userData/productions/` (new PC, wiped app data, copied folder)
doesn't show up in the Production Assistant. There is no way to re-register it.
"Remove from Cascade" explicitly keeps files on disk, so re-import must be possible.

## Plan
- [x] `productions.ts`: add `importProduction(folder)` — validate the dir exists;
      return the already-registered production when one points at that folder
      (resolved-path comparison, idempotent, no dupes); else create a fresh doc
      with `meta.name = basename(folder)`, `meta.folder = folder` (the folder
      ITSELF — unlike `newProduction`, which creates a subfolder), scaffold
      missing asset dirs non-destructively (`mkdir recursive` only, never
      delete/overwrite), save + return.
- [x] `shared/ipc.ts`: add `importProduction(folder)` to `CascadeApi` +
      `"production:import"` to `ipcContract` (preload adapter is mechanical).
- [x] `main/index.ts`: add `production:import` handler — validate arg, ensure
      the dir exists, call `importProduction`, `addRecentProduction`, return.
- [x] Renderer `ProductionWorkspace.tsx`: add `importExisting()` (folder picker
      → `importProduction` → open) + "Import existing…" button on the welcome
      screen next to Create, with busy/error handling.
- [x] Tests: extend `app/test/productions.test.ts` — doc points at the folder
      itself, missing dirs scaffolded, existing files preserved, re-import
      returns the same id.
- [x] Verify: `npm run typecheck` ✓, `npm test` ✓ (374 passed, 1 skipped), `npm run build` ✓.

## Review
Import adopts the picked folder as-is (no subfolder — the mirror image of
create). Pipeline state starts fresh since the old JSON is gone; the user
re-ingests the script from Step 1. Re-import is idempotent via resolved-path
comparison, so no duplicates.
