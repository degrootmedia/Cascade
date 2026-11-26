---
kind: sequential
triggers: implement the plan, start building, execute the tasks
---
Execute the approved plan task by task, test-first, stopping and reporting whenever reality contradicts the plan.

# spec:implement

Purpose: build each planned task, verified, without drifting from the plan.

## Steps
1. Load the approved plan from `.cascade/specs/<slug>/plan.json`.
2. Work through tasks in order. For each task:
   a. Write/update the test (test-first when the codebase uses TDD).
   b. Implement the change.
   c. Verify it passes (run the relevant test/build command).
   d. Mark the task `done: true` in plan.json.
3. Keep changes minimal and follow the codebase's conventions.

## Gaps found?
If implementation reveals the plan was wrong, STOP. Do not improvise a large
detour. Report the gap to the user, propose an updated plan, and only proceed
once the plan is updated and re-approved.

## Output
- All tasks marked done, tests green.
- A concise summary of what was built.
