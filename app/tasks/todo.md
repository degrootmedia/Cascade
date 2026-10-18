# Reliable reference-connection ↔ prompt-tag sync in node view

## Contract (from user)
- Connections always sync to tags in the prompt: remove connection ⇒ tag removed; add/reconnect ⇒ tag added back.
- Dropping a new connection on an occupied socket replaces the connection AND the tag (swap).
- Connections must not reorder spuriously.

## Root causes found
1. Dual-write by convention: every handler hand-mirrors a graph-edge write with a text-tag write, computed from different sources (edges vs text). Sockets render from text tag counts, wires from graph edges — any drift renders wires on wrong/missing handles.
2. `connectionToEdge`/`applyConnection` never drop an existing wire from the same source to the same prompt, so reconnecting/moving a ref creates duplicate wires while `addRefTag` dedupes the tag side — counts diverge.
3. Swap used `replaceRefTagAt(socketIndex)`, assuming tag occurrence order == socket order. False once gen-direct wires share video-prompt sockets, chips are dragged in the text, or any drift exists — wrong tag replaced or append instead of replace.
4. Text→wire reconcile (`reconcilePromptRefEdges`) is remove-only: hand-typed/@-inserted tags and chip reorders never add/reorder wires, and render (`reconcileRefTags`) then drops unwired known tags — "tag doesn't appear".
5. Stale read-modify-write: handlers read `cb.current.graph`/`graphVideoNodes` (prop snapshot) while saves are optimistic-async; multiple writes in one handler (or place-then-connect quickly) overwrite each other, losing nodes/edges/sentinels. Dangling edges (e.g. generation-saved-as-reference never adds its graph node) are dropped by `normalizeGraph` on reopen.

## Fix
- [x] `prompt-grammar.ts`: `syncRefTags(text, orderedNames, knownNames)` — known-tag sequence becomes exactly the ordered list, preserving existing tag positions slot-wise; dangling tags untouched.
- [x] `graph/connect.ts`: `promptRefWires`, `withPromptRefWires` (positional rebuild, dedupe, adds missing ref nodes, identity when unchanged), `promptWiresAfterConnect` (append/replace/move semantics), dedupe in `applyConnection`, full-sync `reconcilePromptRefEdges` (ordered, preserves gen-wire slots).
- [x] `NodeGraphModal.tsx`: one `applyPromptWireChange(target, nextSources)` used by connect / swap / detach / edge-delete / generation-attach paths (graph + text + video `refIds` sentinels derived from the same ordered list); synchronous write-through of `cb.current` mirrors in `graphField`; sockets (`refHandles`) derived from graph wires; edit-prompt tagged lists from rendered values; heal wires from stored prompt text on graph open; tag add/remove/reorder edits publish live from the prompt draft (not only reorders).
- [x] Tests: unit coverage for new helpers + `test/graph-ref-sync.test.ts` end-to-end op-sequence simulation (connect, swap-on-occupied, disconnect, reconnect, typed-tag commit, chip reorder) asserting tags == wires at each step.
- [x] Verify: `npm test` (typecheck + full vitest).

## Review
Done. New regression tests failed 4/4 against the old helpers (duplicate
wire on reconnect, remove-only reconcile) and pass now; full gate green:
typecheck clean, 165 test files / 1750 tests passed (1 file / 2 tests
skipped, pre-existing). Modal multi-line edits were applied with a
temporary exact-match script because the file is uniformly CRLF (script
asserted exactly-one match per edit and was removed after use); the
pre-existing uncommitted DurationField work in the same file was left
untouched. Not verified in a live Electron session — canvas gestures
(drag connect/swap/detach) are covered by shared-helper simulations of
the modal's exact call sequence plus the existing jsdom graph tests.
