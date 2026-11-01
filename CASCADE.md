# Cascade – working rules for the coding agent

These rules apply to every batch of work on this repo. See `CONTEXT.md` for the domain vocabulary.

## Standing workflow rules

1. **Evidence in reports.** Every item report must include the commands actually run and their output (or the relevant tail), and a screenshot for any change that is visible in the UI. A claim like "all tests pass" without output does not count as verification.
2. **Reproduction-first tests.** For every bug fix, add or extend a regression test and show it failing on the pre-fix code once, then passing after the fix. The report must include both runs.
3. **Loop breaker.** After 3 failed edits to the same file, or 3 failed attempts at the same fix, stop. Summarize what was tried and what was learned, and propose a new plan before continuing.

Also: change file text with the edit tool only, never with PowerShell text rewrites (a repo test scans for the resulting encoding damage). Lessons live in `tasks/lessons.md`; mechanical ones are enforced by tests in `app/test/lessons-guards.test.ts`.

## For the human operator (not the agent)

4. **Session hygiene.** One batch = one fresh session. Name sessions for multi-day work. If the agent takes a wrong direction and two corrections do not fix it, rewind to before the bad turn instead of patching a confused session.
5. **Reasoning effort.** Plan a batch at the highest effort setting, implement at high, and run the verification/review pass at the highest setting again. Do not run whole sessions at max effort.

## Session start ritual (before writing any code)

1. Run `node scripts/session-start.mjs` (recent commits, batch scoreboard, smoke checks).
2. Read `tasks/progress.md`.
3. Pick the next `in-progress` or `not-started` item from `tasks/batch-state.json`.
4. Only the `status` field of an entry may be edited (values: not-started, in-progress, passing, blocked); `node scripts/check-batch-state.mjs` enforces it against git HEAD.
5. At session end, append completed / blocked / next to `tasks/progress.md` in a few lines.

## Fresh-eyes reviewer

A read-only reviewer (`reviewerMode` in core; instructions in `tasks/reviewer.md`) grades a finished batch against the original spec text plus the diff, without seeing the implementing chat. Its tools are only read_file, list_directory, glob, grep, enforced in `Agent`'s constructor and tested in `core/test/reviewer.test.ts`.

- **Use it** before reporting complete any batch that touches shared or stateful code: project storage, the job ledger, the node graph, provider backends.
- **Skip it** for trivial batches (copy, styling, docs).
- Run from `core/`: `npm run review -- --spec <spec file> [--base <git ref>]`. Include its graded report in the batch report.

## Verify a UI change

1. From `app/`: `npm run build`, then `npm run ui:verify [-- --views "Chat,Production Assistant"]`.
2. It launches the built app with a throwaway profile (`CASCADE_USER_DATA`, a temp dir) and a local-only debug port (`CASCADE_DEBUG_PORT`), clicks each named view tab, and writes PNGs plus `report.json` and a copy of `main.log` to `tasks/screenshots/<timestamp>/`. Real user data is never touched.
3. A fresh profile has no API key, so Settings opens on its own; `first-run-modal.png` shows that, and the modal is then hidden so the other views can be captured.
4. Exit code 1 means a renderer error, page error or crash was logged; each is listed in the output and `report.json`.
5. Logs: `<userData>/main.log` (main process and renderer warnings/errors, rotated at 2 MB) and `crash.log`. For a normal run, userData is `%APPDATA%\cascade-app`. Search the run's `main.log` copy for `[renderer:error]`.
6. Include the screenshot paths and the verify output in the batch report (evidence rule 1).
7. Self-test of the log pipeline: `npm run ui:verify -- --inject-error` must exit 1 and list `UI-VERIFY-DELIBERATE-ERROR`.
8. Only tab views are scripted; to reach another view, add its name via `--views` if it is a tab, otherwise extend `scripts/ui-verify.mjs`.

## Checks

- Fast check (typecheck + lint), run from `core/`: `npm run check:fast`.
- Full suites: `npm test` in `core/` and in `app/`.
- Prettier formats each edited file automatically; do not hand-format.
