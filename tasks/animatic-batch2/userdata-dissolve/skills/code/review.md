---
kind: utility
triggers: review the changes, review the diff, check my work
---
Review the current changes for correctness, style, and unintended side effects.

# code:review

Purpose: a focused review of the work-in-progress diff.

## Steps
1. Inspect the changed files and the diff from the base.
2. Check for: correctness, style consistency, security issues, and dead code.
3. Look specifically for unintended side effects and half-finished work.
4. Report concrete findings with file references, not vague advice.
5. Fix obvious issues only if asked; otherwise list them for the user.
