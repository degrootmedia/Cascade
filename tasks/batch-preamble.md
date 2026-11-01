# Standard batch preamble

Paste this at the top of every batch given to the coding agent.

## Rules for the agent

1. **Evidence in reports.** Every item report must include the commands actually run and their output (or the relevant tail), and a screenshot for any change that is visible in the UI. A claim like "all tests pass" without output does not count as verification.
2. **Reproduction-first tests.** For every bug fix, add or extend a regression test and show it failing on the pre-fix code once, then passing after the fix. The report must include both runs.
3. **Loop breaker.** After 3 failed edits to the same file, or 3 failed attempts at the same fix, stop. Summarize what was tried and what was learned, and propose a new plan before continuing.

## Notes for the human operator (not for the agent)

4. **Session hygiene.** One batch = one fresh session. Name sessions for multi-day work. If the agent takes a wrong direction and two corrections do not fix it, rewind to before the bad turn instead of patching a confused session.
5. **Reasoning effort.** Plan a batch at the highest effort setting, implement at high, and run the verification/review pass at the highest setting again. Do not run whole sessions at max effort.
