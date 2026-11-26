---
kind: sequential
triggers: make a plan, break a feature into tasks, plan an implementation
---
Take the research and break it into a concrete, ordered task list (plan.json) the agent can execute without constant course-correction.

# spec:plan

Purpose: commit to a specific approach and a sequence of small, verifiable tasks.

## Input
- The `spec.md` from spec:research (or an equivalent understanding).

## Steps
1. Break the work into small, independently verifiable tasks.
2. For each task record: what to change, which files, and how to verify it
   (a test, a build, a manual check).
3. Order tasks so each builds on the previous and the workspace stays green.
4. Write the plan to `.cascade/specs/<slug>/plan.json` as an array of tasks:
   `[{ "id", "summary", "files", "verify", "done": false }]`.
5. Present the plan to the user and wait for approval.

## Rules
- Do NOT start implementing until the plan is approved.
- A good plan means few mid-implementation corrections. Get it right up front.

Stop here — implementation begins only after the user approves the plan.
