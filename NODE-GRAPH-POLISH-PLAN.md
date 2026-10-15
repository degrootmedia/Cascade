# Node-graph UX polish — implementation plan

Six node-graph requests from the user. All live in the shot node graph
(`app/src/renderer/src/components/NodeGraphModal.tsx` + `app/src/shared/graph/*`).
No behavior change is intended outside the listed surfaces; each item names the
exact test that must be updated and the invariant it must not violate.

Scope guard: **no `core/` change, no IPC/contract change, no persistence/schema
change.** Every item is renderer-side or a pure shared-graph helper.

---

## Item 1 — video connectors: dashed orange → solid fuchsia

**Findings.** The single edge-appearance table is `EDGE_MEDIA_STYLES` in
`app/src/shared/graph/edge-style.ts:16-20`:

```
image: { stroke: "#3b82c4" },
video: { stroke: "#d97a26", strokeDasharray: "7 5" },   // dashed orange
other: { stroke: "#8a8f98", strokeDasharray: "2 4" },
```

`graphFlow.ts` (`graphEdgesToFlow`, line 94) and the modal's `edges` memo
(`NodeGraphModal.tsx:4422`) both read `edgeMediaStyle(media)`; nothing else maps
edge vectors. The module header comment (line 5) also says "video is a dashed
orange".

**Plan.**
- [ ] `edge-style.ts`: `video: { stroke: "#d946ef" }` (solid fuchsia; drop
      `strokeDasharray`). Keep `other` dotted and `image` solid blue, so the
      three stay distinguishable by color (video/other still differ in line
      style; image/video now differ only by color — an accepted trade-off).
- [ ] Update the module header comment ("image solid blue, video solid fuchsia,
      other dotted gray").
- [ ] The exact hex is a taste call — `#d946ef` offered; any fuchsia works as
      long as it stays distinct from `--graph-socket-ref` (accent blue),
      `--graph-socket-style` (#34d399) and `--graph-socket-brand` (#f59e0b).

**Tests that break and must be updated.**
- `app/test/edge-style.test.ts:15` asserts the three media styles have three
  distinct `strokeDasharray ?? "solid"` values. With video solid, image and
  video both become `"solid"` → the set size drops to 2. Relax the assertion:
  colors still 3-distinct (line 14, keep), and assert `other` is the only
  dashed style (`EDGE_MEDIA_STYLES.other.strokeDasharray` truthy;
  image/video undefined).
- `graph-flow.test.ts` does not assert the video style (it uses `IMG`/`OTHER`),
  so it is unaffected.

---

## Item 2 — straight connection drag preview (not a bezier)

**Findings.** The preview line is
`connectionLineType={ConnectionLineType.Bezier}` (`NodeGraphModal.tsx:5785`). A
*connected* edge is drawn by `WaypointEdge` as a straight polyline through its
waypoints (no waypoints ⇒ a straight `M source L target`), so today the preview
curves and then snaps straight on release.

**Plan.**
- [ ] `NodeGraphModal.tsx:5785`: `ConnectionLineType.Straight`. `WaypointEdge`
      already renders no-waypoint edges straight, so the preview and the
      committed wire match. `ConnectionLineType` stays imported (still used).
- [ ] No test change required (jsdom does not exercise the SVG preview); a
      one-line assertion on the `ReactFlow` `connectionLineType` prop could be
      added to `graph-shelf.test.ts` if desired, but is optional.

---

## Item 3 — dropped/pasted image/video: always on top + selected

**Findings.** Drops and pastes both funnel through `addPlacedRef`
(`NodeGraphModal.tsx:3616-3652`): it appends the node to `nodesRef.current`
(line 3643) and persists the layout, but never sets `selected`. The reconcile
effect (line 4367) rebuilds nodes in `buildDerived` order (tagged refs → placed
refs → structural → generators) while preserving each surviving node's
`position`, `selected`, and `measured` (lines 4395-4404), so array order is
*not* a reliable z-order — but React Flow v12 (`@xyflow/react ^12.11.5`)
defaults `elevateNodesOnSelect: true`, which raises a selected node's z-index
automatically. So "selected" is also "on top".

**Plan.**
- [ ] `addPlacedRef`: build the new node with `selected: true`, and set every
      other node in `next` to `selected: false` (the controlled flow's single
      selection — React Flow reconciles selection from node objects). Keep the
      append + `setPlacedRefIds` + `saveLayout` + `saveGraph` as-is.
- [ ] Confirm the reconcile path preserves it: a node present in `byId` with
      equal `data` returns the OLD object (line 4387-4388), so the
      `selected: true` set here survives the next rebuild. The
      `nodeDataEqual("ref", …)` rule already exists, so no registry change.
- [ ] `placeExportedRefs` (line 3656) and the drop/paste callers already route
      through `addPlacedRef`, so the camera-grid exports inherit it too (fine —
      a fresh export is the thing the user just made).

**Tests to add.** A `graph-shelf` case: drop/paste a reference and assert its
`.react-flow__node.selected` wrapper is present (and, if feasible, that the
previously selected node is not). No existing test asserts the old
not-selected behavior.

**Risk / non-goal.** Do not set a manual `zIndex`; `elevateNodesOnSelect` covers
it and a manual zIndex would need a reconcile change. "Center on the node" is
NOT in scope.

---

## Item 4 — omit the Brand node when the brand identity is blank

**Findings.** The Brand node is a structural node added unconditionally in
`buildDerived` (`NodeGraphModal.tsx:4249-4255`), gated only by
`nodeKindHidden("brand")` (the sequence canvas's `hiddenTools`). Its data
authority is `prod.brand`, rendered by `brandClauseText(prod.brand)`
(`shared/look.ts:64`), which returns `""` when there are no valid colors and no
font. The modal carries `prod` already.

**Plan (render-only; never mutate the stored graph).**
- [ ] Compute `const brandEmpty = brandClauseText(prod.brand).trim() === ""`
      (import `brandClauseText` from `shared/look.js`).
- [ ] `buildDerived` (line 4249): also gate the Brand node on `!brandEmpty`.
- [ ] The `edges` memo (line 4422): when `brandEmpty`, filter `wiringGraph.edges`
      to drop edges whose `from.node === "brand"` before `graphEdgesToFlow`, so
      no edge is left pointing at a hidden node.
- [ ] Do NOT route `brandEmpty` through `nodeKindHidden`: the ensure effect
      (line 4449-4455) uses `nodeKindHidden` to *strip* hidden nodes from the
      stored graph, which would permanently delete the `brand` node/edges and
      they could never come back. Keeping it a render filter means: add a brand
      color/font in Design → the node and its wires reappear on the next
      render, with the stored graph untouched.
- [ ] Optional polish (scope call): hide the prompt nodes' Brand toggle when
      `brandEmpty` (it currently renders a no-op toggle). Not required by the
      request; leave for a follow-up if the user asks.

**Tests.** `materializeGraph` still emits `brand` (pure, unchanged), so
`graph-materialize.test.ts`, `graph-stored-read.test.ts`, and
`node-registry.test.ts` (materializer emission) stay green. Modal tests with
`brand: { colors: [], font: "" }` fixtures (`graph-modal-caret`, `graph-shelf`,
`graph-focus`, `graph-edit-loss`, `graph-style-live`, …) will now render no
`.prod-graph-brand`; grep them to confirm none asserts the Brand node exists
(none found in this pass). Add one assertion: a brand-empty fixture has no
`.prod-graph-brand`, and a fixture with colors/font does.

---

## Item 5 — delete an elbow by selecting it + Delete (not double-click)

**Findings.** Waypoints ("elbows") are `WaypointEdge` dots
(`components/graph/WaypointEdge.tsx:105-120`). They are layout-only (no graph
node/edge), so React Flow's `deleteKeyCode` cannot see them. Today the only
removal gesture is the dot's `onDoubleClick` → `handlers.remove` (line 113-116),
which the user finds finicky. Handlers come from `waypointHandlers`
(`NodeGraphModal.tsx:2974-2993`), all of which call `captureHistory(true)` +
`saveLayout`.

**Plan.**
- [ ] Add waypoint selection state in `NodeGraphModal`:
      `const [selectedWaypoint, setSelectedWaypoint] = useState<{ edgeId: string; index: number } | null>(null)`.
- [ ] Extend `WaypointHandlers` (and its context value) with a `select` setter;
      pass the current `selectedWaypoint` through the context so `WaypointEdge`
      can render the selected dot with a distinct class
      (e.g. `.prod-waypoint-dot.selected`). Keep `add`/`move`/`remove`.
- [ ] `WaypointEdge`: on dot `pointerdown` call `handlers.select(id, i)` then
      start the drag as today; keep the double-click delete as a harmless
      secondary gesture (or drop it — keeping it is lower risk). Add the
      selected class/style.
- [ ] A document-level `keydown` effect in `NodeGraphModal` (mirror the
      Escape/Undo listeners at lines 3111-3137): when `Delete`/`Backspace` is
      pressed, the target is not an editing target (`isEditingTarget`, line
      696), not `readOnly`, and `selectedWaypoint` is set, call
      `e.preventDefault()` and `waypointHandlers.remove(edgeId, index)`, then
      clear the selection.
- [ ] Clear `selectedWaypoint` when: the ReactFlow pane is clicked
      (`onPaneClick`), another waypoint is selected (handled by the setter),
      the selection's edge is removed, or `tidyLayout` clears waypoints.
- [ ] Avoid a double-delete: when selecting a waypoint, clear React Flow's
      node/edge selection first (`setSelectedEdges(new Set())` and deselect any
      `selected` nodes via the node-change engine), so the same Delete keypress
      can't also remove a node. With React Flow's selection empty, its own
      `deleteKeyCode` handler is a no-op and ordering is irrelevant;
      `preventDefault()` also stops Backspace navigation.
- [ ] CSS (`styles.css:4636`): `.prod-waypoint-dot.selected { fill: var(--accent); ... }`
      (and update the dot `<title>` to "Drag to move · select + Delete, or
      double-click, to delete").

**Tests to add.** `waypoint-edge.test.ts` is pure and stays as-is; add a
modal-level case (graph-shelf style) that clicks a waypoint dot and asserts a
`.selected` class, then dispatches `Delete` and asserts the waypoint is gone
(the saved layout's `waypoints[edgeId]` shrinks). Keep the existing
`waypointInsertIndex` unit test.

**Risk.** The document listener must ignore keypresses inside prompt editables
(`isEditingTarget`) or deleting text in a composer near a selected waypoint
would delete the waypoint instead.

---

## Item 6 — deleting a ref tag disconnects the ref; disconnecting the ref removes the tag

**Findings (direction B already works; direction A is missing).**
- *Disconnect → remove tag* is implemented on all three detach paths: drag-off
  (`onConnectEnd` → `detachPrompt`, `NodeGraphModal.tsx:5418-5508`), keyboard
  edge delete (`onEdgesChange` remove branch, lines 4828-4891), and ref-node
  delete (lines 4634-4698). All call `removeRefTag` with the detached wire's
  SOURCE identity (name-based, idempotent).
- *Delete tag → disconnect* is NOT implemented. Prompt edits only persist the
  text; nothing reconciles `shot.graph`'s ref edges to the new tag set.
  `wireComposerRefs` (`connect.ts:614`) does this for the Magic-Prompt case only;
  a normal edit leaves a stale `ref:<id> → prompt/in-ref-N` edge whose tag is
  gone (the reported bug).

**Plan.**
- [ ] `shared/graph/connect.ts`: add a pure, tested
      `reconcilePromptRefEdges(graph, target, tagRefIds): Graph`:
      - canonicalize `target` (`canonicalNodeId`);
      - keep every edge except ref-sourced positional sockets
        (`from.node.startsWith("ref:")` AND `REF_SOCKET_RE.test(to.port)` AND
        `to.node === target`) whose ref id is not in `tagRefIds`;
      - **preserve** gen-sourced wires (bare `imagegen` / `editgen:<id>`, which
        carry no tag) and `in-frame-N` sequence sockets;
      - `compactPromptRefEdges` the result; return the same graph when nothing
        changed (so no redundant save).
- [ ] `NodeGraphModal`: a small `reconcileTagsToEdges(target, text)` helper that
      maps `refTagNames(text)` → ref ids via `cb.current.references`
      (case-insensitive name match) and saves the reconciled graph through the
      existing `saveGraph` path (so waypoints of dropped edges are cleared and
      undo history is captured). Wire it into the four prompt commit points:
      - composer: wrap `stable.onPromptChange` (line 3422), target `"composer"`;
        **skip when `magicActive`** (the magic effect already runs
        `wireComposerRefs`, line 4473-4480).
      - video prompt: wrap `stable.onVideoPromptChange` (line 3584), target
        `videoPromptNodeId(nodeId)`.
      - edit-video prompt: wrap `stable.onEditVideoPromptChange` (line 3586),
        target `editVideoPromptNodeId(nodeId)`.
      - edit prompt: wrap `stable.onEditPromptChange` (line 3596), target
        `editPromptNodeId(nodeId)`.
      In each wrapper apply the text change first, then reconcile.
- [ ] Only remove — do NOT auto-add edges for tags that lack a wire (keeps the
      change minimal and avoids creating wires for missing refs; note as an
      optional future symmetry).
- [ ] Keep the existing detach handlers untouched (direction B stays).

**Tests.**
- [ ] `graph-connect.test.ts`: unit tests for `reconcilePromptRefEdges` —
      removes a ref edge whose tag is gone, preserves gen-sourced wires and
      `in-frame-N` sockets, compacts indices after a middle removal, no-op when
      unchanged, ignores other prompt nodes.
- [ ] A modal integration case (graph-shelf style): render with a tagged ref,
      delete the tag chip from the composer (`prompt-tag-chip` backspace/delete
      per `prompt-content-editor.test.ts`), assert the stored graph no longer
      has that ref edge. Add the mirror assertion that dragging the wire off
      strips the tag (likely already covered by an existing detach test —
      verify and extend if not).

**Risks.**
- Run the full renderer suite: any test that commits a tag-less prompt while an
  edge is expected now fails (by design). Search prompt-committing modal tests
  (`graph-modal-caret`, `graph-focus`, `graph-edit-loss`, `graph-style`,
  `graph-style-live`, `tripleprompt-caret`) and reconcile.
- The reconcile must read the committed text, not a stale `cb.current` prompt;
  the wrappers receive the value.
- Defer `saveGraph` TDZ: `stable` is initialized at line 3421 before
  `saveGraph`/`graphField` are defined (line 4754/2917). Route through a ref
  (`const saveGraphRef = useRef<(g: Graph) => void>()`, assigned after
  `saveGraph` is defined) or through `cb.current.onGraphField` + an explicit
  `captureHistory(true)`, matching how the other `stable` handlers reach
  later-declared helpers through `cb.current`.

---

## Verify (all items)

- [ ] `app`: `npm run typecheck`, `npm test` (full suite), `npm run build`.
- [ ] Update every test listed above in the same change.
- [ ] No `core/` change; no IPC/contract change; no persistence/schema change.
- [ ] Confirm the stored-graph invariant for Item 4: brand-empty shows no Brand
      node but `shot.graph` still holds the `brand` node/edges (add a color in
      Design → they reappear) — the "don't break existing features" guard.
- [ ] Confirm Item 6 direction B still works after adding direction A (detach
      strips the tag; delete-tag drops the edge — no oscillation).
