---
kind: sequential
triggers: finish up, validate the work, review pass, wrap up
---
Validate the whole implementation and run a final review pass before calling the work done.

# spec:finish

Purpose: prove the full change works and review it like a senior engineer.

## Steps
1. Run the full verification the project uses (tests, typecheck, build).
2. Confirm every plan task is done and nothing was left half-finished.
3. Review the diff for correctness, style, and unintended side effects.
4. Fix any issues found, then re-run verification.
5. Summarize what shipped, how it was verified, and anything left as future work.
