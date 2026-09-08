---
kind: sequential
triggers: research the codebase, explore the workspace, understand the patterns
---
Explore the codebase/workspace and produce a spec.md — the research artifact every downstream step depends on.

# spec:research

Purpose: understand the codebase and the request before any plan or code exists.

## Steps
1. Read the relevant files, patterns, and conventions in the workspace.
2. Note module boundaries, existing seams, and anything that constrains the work.
3. Record conventions (style, testing, architecture) so later steps follow them.
4. Write findings to a spec file (`.cascade/specs/<slug>/spec.md` unless the user
   points elsewhere). Keep it concrete: what exists, what changes, and what
   constrains the change.

## Output
- A `spec.md` capturing the research.
- A short summary to the user of what you found and what you propose to build.

Stop here — do not move to planning until the user reviews the spec.
