---
kind: utility
triggers: commit, stage, make a commit, what to commit
---
Stage and commit the intended changes with a clear, conventional message.

# code:commit

Purpose: turn the current work into a clean, well-described commit.

## Steps
1. Inspect status and the diff; identify the intended change.
2. Stage only the intended files — never secrets or unrelated changes.
3. Write a concise message that matches the repo's style.
4. If a hook or commit fails, fix the issue and retry.

Note: only commit when the user asks you to. Never force-push or amend without
being told to.
