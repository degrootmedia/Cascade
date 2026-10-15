$ErrorActionPreference = "Stop"
$path = "src\renderer\src\components\NodeGraphModal.tsx"
$full = (Resolve-Path $path).Path
$text = [System.IO.File]::ReadAllText($full) -replace "`r`n", "`n"
function Replace-Once([string]$old, [string]$new, [string]$label) {
  $count = ([regex]::Matches($script:text, [regex]::Escape($old))).Count
  if ($count -ne 1) { throw "Expected exactly 1 match for $label, found $count" }
  $script:text = $script:text.Replace($old, $new)
  "OK: $label"
}

# ---- imports ----
$oldImp = @'
import { addGraphNode, applyCameraGridRefs, applyConnection, applyTweenKeys, canonicalNodeId, connectionToEdge, connectTweenKey, ensurePromptPipe, graphEdgesForDetach, nodeKindForId, removeGraphEdge, removeGraphNode, setStyleEdge, tweenKeyForSource, tweenKeyToNode, wireComposerRefs } from "../../../shared/graph/connect.js";
'@
$newImp = @'
import { addGraphNode, applyCameraGridRefs, applyConnection, applyTweenKeys, canonicalNodeId, connectionToEdge, connectTweenKey, ensurePromptPipe, graphEdgesForDetach, nodeKindForId, removeGraphEdge, removeGraphNode, setStyleEdge, tweenKeyForSource, tweenKeyToNode, wireComposerRefs } from "../../../shared/graph/connect.js";
import { pickGraphShotPatch } from "../../../shared/graph/shot-patch.js";
import { createUndoHistory } from "./production/undo-history.js";
'@
Replace-Once $oldImp $newImp "imports"

# ---- history state, capture, restore (right after saveLayoutRef) ----
$oldRef = @'
  const saveLayoutRef = useRef(onSaveLayout);
  saveLayoutRef.current = onSaveLayout;
'@
$newRef = @'
  const saveLayoutRef = useRef(onSaveLayout);
  saveLayoutRef.current = onSaveLayout;

  // ---- Node-view undo/redo -------------------------------------------------
  // Every graph/layout mutation funnels through graphField / saveLayout /
  // saveGraph below, which capture a pre-mutation snapshot (the shot's
  // graph-owned fields via the patch allowlist + the canvas layout). Undo
  // restores the snapshot through the same narrow commands. Generation
  // results (gens, jobs) are main-owned and never enter a snapshot, so undo
  // can never un-record a finished generation.
  type GraphHistorySnapshot = { fields: Partial<ProductionShot>; layout: GraphLayout | undefined };
  const historyRef = useRef(createUndoHistory<GraphHistorySnapshot>({ limit: 50, coalesceMs: 1200 }));
  const restoringRef = useRef(false);
  const shotNowRef = useRef(shot);
  shotNowRef.current = shot;
  const [, setHistoryTick] = useState(0);
  const snapshotNow = useCallback((): GraphHistorySnapshot => ({
    fields: pickGraphShotPatch(shotNowRef.current) as Partial<ProductionShot>,
    layout: cb.current.initialLayout ? (JSON.parse(JSON.stringify(cb.current.initialLayout)) as GraphLayout) : undefined,
  }), []);
  const captureHistory = useCallback((force = false) => {
    if (restoringRef.current || readOnly) return;
    if (historyRef.current.push(snapshotNow(), { force })) setHistoryTick((n) => n + 1);
  }, [readOnly, snapshotNow]);
  const graphField = useCallback((patch: Partial<ProductionShot>): void => {
    captureHistory();
    cb.current.onGraphField(patch);
  }, [captureHistory]);
  const saveLayout = useCallback((patch: GraphLayoutPatch): void => {
    // Pan/zoom alone is not an undoable edit.
    if (!("viewport" in patch && Object.keys(patch).length === 1)) captureHistory();
    saveLayoutRef.current(patch);
  }, [captureHistory]);
  const restoreHistory = useCallback((entry: GraphHistorySnapshot) => {
    restoringRef.current = true;
    try {
      cb.current.onGraphField(entry.fields);
      const cur = cb.current.initialLayout;
      const snap = entry.layout;
      const idsOf = (l: GraphLayout | undefined) => new Set([
        ...Object.keys(l?.positions ?? {}),
        ...Object.keys(l?.sizes ?? {}),
        ...Object.keys(l?.collapsed ?? {}),
      ]);
      const curIds = idsOf(cur);
      const snapIds = idsOf(snap);
      const remove = [...curIds].filter((id) => !snapIds.has(id));
      saveLayoutRef.current({
        positions: snap?.positions ?? {},
        sizes: snap?.sizes ?? {},
        collapsed: snap?.collapsed ?? {},
        waypoints: snap?.waypoints ?? {},
        remove,
      });
    } finally {
      restoringRef.current = false;
    }
  }, []);
  const doUndo = useCallback(() => {
    const target = historyRef.current.undo(snapshotNow());
    if (target) restoreHistory(target);
    setHistoryTick((n) => n + 1);
  }, [restoreHistory, snapshotNow]);
  const doRedo = useCallback(() => {
    const target = historyRef.current.redo(snapshotNow());
    if (target) restoreHistory(target);
    setHistoryTick((n) => n + 1);
  }, [restoreHistory, snapshotNow]);
'@
Replace-Once $oldRef $newRef "history capture/restore"

# saveGraph routes through graphField + cleans up deleted edges' waypoints.
$oldSaveGraph = @'
  const saveGraph = (g: Graph): void => { graphField({ graph: g }); };
'@
$newSaveGraph = @'
  const saveGraph = (g: Graph): void => {
    const prev = cb.current.graph;
    graphField({ graph: g });
    // Deleting an edge (or a node, which deletes its edges) deletes its
    // waypoints with it — they are layout data keyed by edge id.
    if (prev) {
      const nextIds = new Set(g.edges.map((e) => e.id));
      const gone = prev.edges.filter((e) => !nextIds.has(e.id) && (cb.current.initialLayout?.waypoints?.[e.id]?.length ?? 0) > 0);
      if (gone.length) {
        saveLayoutRef.current({ waypoints: Object.fromEntries(gone.map((e) => [e.id, [] as { x: number; y: number }[]])) });
      }
    }
  };
'@
Replace-Once $oldSaveGraph $newSaveGraph "saveGraph funnel"

# Undo/redo keyboard (never while typing — text fields keep their own undo).
$oldKey = @'
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, lightbox]);
'@
$newKey = @'
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, lightbox]);

  useEffect(() => {
    const onUndoKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.isComposing || isEditingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if ((key === "z" && e.shiftKey) || key === "y") { e.preventDefault(); doRedo(); }
    };
    document.addEventListener("keydown", onUndoKey);
    return () => document.removeEventListener("keydown", onUndoKey);
  }, [doUndo, doRedo]);
'@
Replace-Once $oldKey $newKey "undo keyboard"

# Toolbar buttons (Undo / Redo / Tidy lives here too, wired later).
$oldClose = @'
          {onDetach && !readOnly && (
            <button className="prod-btn" onClick={onDetach} title="Open the node graph in a separate window you can move to another monitor">
              Pop out
            </button>
          )}
          <button className="prod-btn" onClick={onClose}>Close</button>
'@
$newClose = @'
          {onDetach && !readOnly && (
            <button className="prod-btn" onClick={onDetach} title="Open the node graph in a separate window you can move to another monitor">
              Pop out
            </button>
          )}
          {!readOnly && (
            <>
              <button className="prod-btn" onClick={doUndo} disabled={!historyRef.current.canUndo()} title="Undo (Ctrl+Z)">Undo</button>
              <button className="prod-btn" onClick={doRedo} disabled={!historyRef.current.canRedo()} title="Redo (Ctrl+Shift+Z)">Redo</button>
              <button className="prod-btn" onClick={tidyLayout} title="Arrange all nodes into a clean left-to-right flow (clears edge waypoints)">Tidy</button>
            </>
          )}
          <button className="prod-btn" onClick={onClose}>Close</button>
'@
Replace-Once $oldClose $newClose "toolbar undo/redo/tidy buttons"

[System.IO.File]::WriteAllText($full, ($text -replace "`n", "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
"ALL OK"
