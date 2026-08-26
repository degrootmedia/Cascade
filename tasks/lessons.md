# Lessons

No session-specific lessons yet.

- When simplifying a UI workflow, remove its assignment dependency too; the replacement interaction must own the state transition.
- Prompt display and transport forms must stay separate; UI refreshes should never use MCP transport tokens.
- Generated prompt sections must be removed with paragraph-scoped matching, never an end-of-string wildcard that can consume user content.
- Debounced prompt editors need a serialized latest-value queue before generation; otherwise IPC responses can save or display stale snapshots.
- Per-shot prompt display needs a cache plus retry when generation updates persistence asynchronously; null refresh results must not replace visible content.
