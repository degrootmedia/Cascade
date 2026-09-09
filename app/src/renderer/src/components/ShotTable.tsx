/**
 * Two-column shot table: scenes as sections, shots as editable rows.
 * Numbering is displayed (main owns the shotter); inserts land mid-numbered.
 * Shots are reordered by grabbing the handle on the left and dragging — the
 * drag is pointer-driven (pointer capture + hit-testing the drop lines), so it
 * never depends on the host starting a native HTML5 drag from a control.
 * Dropped shots re-number the whole production and relocate board files.
 * Drop lines sit explicitly BETWEEN rows and under every scene's last shot
 * with a clear accent insertion line, so landing position is predictable.
 * When nothing is being dragged, the same gaps grow a hover "+" that inserts
 * a blank shot; the gaps between scenes grow a hover "+" that adds a new
 * scene. While a shot IS dragged, all of that stands down (`.dragging` on the
 * root): no popups, no push-apart slide, and the scene gaps go inert so the
 * boundary drop lines receive the drag.
 */
import { Fragment, useRef, useState } from "react";
import type { Production, ProductionScene } from "../../../shared/ipc.js";
import { shotHasContent } from "../../../shared/ipc.js";
import { AutoTextarea } from "./AutoTextarea.js";
import { DragHandleIcon, PlusIcon, XIcon } from "./icons.js";
import { usePersistedCollapsed } from "./production/persisted-state.js";

interface Props {
  prod: Production;
  onMutation: (p: Promise<Production>) => void;
}

/** Pointer travel (px) before a handle press becomes a drag. */
const DRAG_SLOP = 4;

export function ShotTable({ prod, onMutation }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [activeZone, setActiveZone] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const prodRef = useRef(prod);
  prodRef.current = prod;
  // A handle press, tracked until it either crosses DRAG_SLOP (becomes a
  // drag) or the pointer comes back up (a plain click — no reorder).
  const dragStart = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);

  function handleReorder(shotId: string, beforeShotId: string | null, endSceneNumber?: number) {
    if (shotId === beforeShotId) return;
    onMutation(window.cascade.reorderShot(prod.meta.id, shotId, beforeShotId, endSceneNumber));
  }

  function onHandleDown(shotId: string, x: number, y: number) {
    dragStart.current = { id: shotId, x, y, moved: false };
  }

  function zoneAt(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint?.(x, y) ?? null;
    if (!el || typeof el.closest !== "function") return null;
    return (el.closest(".shot-drop-zone") as HTMLElement | null) ?? null;
  }

  function zoneTarget(zone: HTMLElement, srcId: string): { beforeShotId: string } | { endSceneNumber: number } | null {
    const before = zone.getAttribute("data-before") ?? undefined;
    const endRaw = zone.getAttribute("data-end");
    const endScene = endRaw != null ? Number(endRaw) : undefined;
    return resolveShotDrop(prodRef.current.scenes, { before, endScene }, srcId);
  }

  function updateActiveZone(x: number, y: number) {
    const src = dragIdRef.current;
    const zone = src ? zoneAt(x, y) : null;
    if (!zone || !src) { setActiveZone(null); return; }
    // Don't highlight a line the dragged shot can't actually land on.
    setActiveZone(zoneTarget(zone, src) ? (zone.getAttribute("data-zone") ?? null) : null);
  }

  function onHandleMove(x: number, y: number) {
    const st = dragStart.current;
    if (!st) return;
    if (!st.moved) {
      if (Math.hypot(x - st.x, y - st.y) < DRAG_SLOP) return;
      st.moved = true;
      dragIdRef.current = st.id;
      setDragId(st.id);
    }
    updateActiveZone(x, y);
  }

  function onHandleUp(x: number, y: number) {
    const st = dragStart.current;
    dragStart.current = null;
    if (st?.moved) {
      const src = dragIdRef.current;
      const zone = zoneAt(x, y);
      if (src && zone) {
        const target = zoneTarget(zone, src);
        if (target) {
          if ("beforeShotId" in target) handleReorder(src, target.beforeShotId);
          else handleReorder(src, null, target.endSceneNumber);
        }
      }
    }
    dragIdRef.current = null;
    setDragId(null);
    setActiveZone(null);
  }

  function onHandleCancel() {
    dragStart.current = null;
    dragIdRef.current = null;
    setDragId(null);
    setActiveZone(null);
  }

  if (!prod.scenes.length) return null;
  return (
    <div className={"shot-table" + (dragId ? " dragging" : "")}>
      {prod.scenes.map((scene, i) => (
        <Fragment key={scene.number}>
          {i > 0 && (
            <SceneInsertZone
              prodId={prod.meta.id}
              afterSceneNumber={prod.scenes[i - 1].number}
              onMutation={onMutation}
            />
          )}
          <SceneBlock
            scene={scene}
            prod={prod}
            onMutation={onMutation}
            dragId={dragId}
            activeZone={activeZone}
            onHandleDown={onHandleDown}
            onHandleMove={onHandleMove}
            onHandleUp={onHandleUp}
            onHandleCancel={onHandleCancel}
          />
        </Fragment>
      ))}
      <SceneInsertZone prodId={prod.meta.id} afterSceneNumber={null} onMutation={onMutation} />
    </div>
  );
}

interface SceneProps {
  scene: ProductionScene;
  prod: Production;
  onMutation: Props["onMutation"];
  dragId: string | null;
  activeZone: string | null;
  onHandleDown: (shotId: string, x: number, y: number) => void;
  onHandleMove: (x: number, y: number) => void;
  onHandleUp: (x: number, y: number) => void;
  onHandleCancel: () => void;
}

/**
 * Resolve a drop on a scene's trailing line — the line that sits ON the scene
 * boundary and reads "place the shot immediately below this point". For any
 * shot of the scene that means the end of this scene — except the scene's
 * LAST shot, which is already there and can only move across the boundary:
 * it re-scopes to the top of the next scene (same reading position, next
 * scene's header above it). At the production end there is no later position,
 * so the drop is a no-op (null).
 */
function trailingDropTarget(
  scenes: ProductionScene[],
  scene: ProductionScene,
  shotId: string
): { beforeShotId: string } | { endSceneNumber: number } | null {
  if (scene.shots[scene.shots.length - 1]?.id !== shotId) return { endSceneNumber: scene.number };
  const at = scenes.findIndex((s) => s.number === scene.number);
  const next = at >= 0 ? scenes[at + 1] : undefined;
  if (!next) return null;
  return next.shots.length ? { beforeShotId: next.shots[0].id } : { endSceneNumber: next.number };
}

/** One rendered drop line: between rows (`before`) or under a scene (`endScene`). */
interface DropZoneDesc {
  before?: string;
  endScene?: number;
}

/** Where `srcId` lands on the described drop line, or null when the drop is a
 *  no-op (its own inter-row line, or the production's final shot over its own
 *  trailing line). */
export function resolveShotDrop(
  scenes: ProductionScene[],
  zone: DropZoneDesc,
  srcId: string
): { beforeShotId: string } | { endSceneNumber: number } | null {
  if (zone.endScene !== undefined) {
    const scene = scenes.find((s) => s.number === zone.endScene);
    if (!scene) return null;
    return trailingDropTarget(scenes, scene, srcId);
  }
  if (!zone.before || zone.before === srcId) return null;
  return { beforeShotId: zone.before };
}

function SceneBlock({ scene, prod, onMutation, dragId, activeZone, onHandleDown, onHandleMove, onHandleUp, onHandleCancel }: SceneProps) {
  const [collapsed, setCollapsed] = usePersistedCollapsed(`cascade.prod.${prod.meta.id}.scene.${scene.number}`);
  const open = !collapsed;
  const dragging = dragId !== null;
  return (
    <section className="shot-scene">
      <header className="shot-scene-head">
        <button className="shot-scene-toggle" onClick={() => setCollapsed(!collapsed)} aria-expanded={open}>
          <span className={"shot-caret" + (open ? " open" : "")}>▸</span>
          Scene {scene.number} — {scene.title}
          <span className="shot-scene-count">{scene.shots.length} shot{scene.shots.length === 1 ? "" : "s"}</span>
        </button>
        <button
          className="shot-insert scene"
          title="Insert a shot at the start of this scene"
          onClick={() => onMutation(window.cascade.insertShot(prod.meta.id, scene.number, 0))}
        >
          <PlusIcon size={13} />
          Shot
        </button>
      </header>
      {open && (
        <div className="shot-rows">
          <div className="shot-row head">
            <span />
            <span>#</span>
            <span>Audio</span>
            <span>Visual</span>
            <span />
          </div>

          {scene.shots.map((shot, i) => (
            <Fragment key={shot.id}>
              <ShotGap
                scene={scene}
                prod={prod}
                index={i}
                beforeId={shot.id}
                dragging={dragging}
                activeZone={activeZone}
                onMutation={onMutation}
              />
              <ShotRow
                prod={prod}
                scene={scene}
                index={i}
                onMutation={onMutation}
                dragId={dragId}
                onHandleDown={onHandleDown}
                onHandleMove={onHandleMove}
                onHandleUp={onHandleUp}
                onHandleCancel={onHandleCancel}
              />
            </Fragment>
          ))}
          {/* Trailing line under the last shot of EVERY scene: hover "+" appends
              to this scene; a drop places the shot just below the scene-boundary
              line (see trailingDropTarget). */}
          <ShotGap
            scene={scene}
            prod={prod}
            index={scene.shots.length}
            beforeId={null}
            endSceneNumber={scene.number}
            dragging={dragging}
            activeZone={activeZone}
            onMutation={onMutation}
          />

          {scene.shots.length === 0 && !dragging && (
            <div className="shot-row empty-drop" title="Drop a shot here to move it into this scene">
              <button
                className="shot-insert-gap"
                title="Add a blank shot to this scene"
                onClick={() => onMutation(window.cascade.insertShot(prod.meta.id, scene.number, 0))}
              >
                <PlusIcon size={12} />
              </button>
              <span>Drop shots here</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The gap between two rows (or under a scene's last shot). While a shot is
 * dragged it renders as a drop line (`data-zone`/`data-before`/`data-end`
 * describe where a drop there would land — see `resolveShotDrop`); otherwise
 * it shows a hover "+" that inserts a blank shot at `index` within the scene.
 */
function ShotGap({ scene, prod, index, beforeId, endSceneNumber, dragging, activeZone, onMutation }: {
  scene: ProductionScene;
  prod: Production;
  index: number;
  beforeId: string | null;
  endSceneNumber?: number;
  dragging: boolean;
  activeZone: string | null;
  onMutation: Props["onMutation"];
}) {
  // Trailing gaps key off the scene so every scene's end highlights on its own.
  const resolvedKey = endSceneNumber != null ? `end-${endSceneNumber}` : beforeId != null ? `before-${beforeId}` : "__end__";

  if (!dragging) {
    return (
      <div className="shot-insert-zone">
        <button
          className="shot-insert-gap"
          title="Insert a blank shot here"
          onClick={() => onMutation(window.cascade.insertShot(prod.meta.id, scene.number, index))}
        >
          <PlusIcon size={12} />
        </button>
      </div>
    );
  }

  return (
    <div
      className={"shot-drop-zone" + (activeZone === resolvedKey ? " active" : "")}
      data-zone={resolvedKey}
      data-before={beforeId ?? undefined}
      data-end={endSceneNumber}
    >
      <div className="shot-drop-line">
        <span className="shot-drop-dot" />
      </div>
    </div>
  );
}

/** Hover "+" between two scenes (or after the last) that adds a new scene. */
function SceneInsertZone({ prodId, afterSceneNumber, onMutation }: {
  prodId: string;
  afterSceneNumber: number | null;
  onMutation: Props["onMutation"];
}) {
  return (
    <div className="scene-insert-zone">
      <button
        className="shot-insert-gap"
        title={afterSceneNumber === null ? "Add a scene at the end" : "Add a scene after this one (later scenes renumber)"}
        onClick={() => onMutation(window.cascade.addScene(prodId, afterSceneNumber))}
      >
        <PlusIcon size={12} />
      </button>
    </div>
  );
}

function ShotRow({ prod, scene, index, onMutation, dragId, onHandleDown, onHandleMove, onHandleUp, onHandleCancel }: {
  prod: Production; scene: ProductionScene; index: number; onMutation: Props["onMutation"];
  dragId: string | null;
  onHandleDown: (shotId: string, x: number, y: number) => void;
  onHandleMove: (x: number, y: number) => void;
  onHandleUp: (x: number, y: number) => void;
  onHandleCancel: () => void;
}) {
  const shot = scene.shots[index];
  const [audio, setAudio] = useState(shot.audio);
  const [visual, setVisual] = useState(shot.visual);
  const dirty = audio !== shot.audio || visual !== shot.visual;

  function commit() {
    if (!dirty) return;
    onMutation(window.cascade.updateShot(prod.meta.id, shot.id, { audio, visual }));
  }

  const isDragging = dragId === shot.id;

  function handleDelete() {
    // Include uncommitted drafts: typed-but-unblurred text still counts as content.
    const effective = { ...shot, audio, visual };
    if (shotHasContent(effective)) {
      if (!window.confirm(`Delete Shot ${shot.number}? This shot has content and deleting it can't be undone.`)) return;
    }
    onMutation(window.cascade.deleteShot(prod.meta.id, shot.id));
  }

  return (
    <div className={"shot-row" + (dirty ? " dirty" : "") + (isDragging ? " dragging" : "")} onBlur={commit}>
      <button
        className="shot-drag-handle"
        title="Drag to reorder — drop between shots"
        aria-label="Drag to reorder shot"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const el = e.currentTarget;
          try { el.setPointerCapture(e.pointerId); } catch { /* unsupported — moves still track while over the button */ }
          onHandleDown(shot.id, e.clientX, e.clientY);
        }}
        onPointerMove={(e) => onHandleMove(e.clientX, e.clientY)}
        onPointerUp={(e) => {
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
          onHandleUp(e.clientX, e.clientY);
        }}
        onPointerCancel={onHandleCancel}
      >
        <DragHandleIcon size={14} />
      </button>
      <span className="shot-number" title={shot.id}>{shot.number}</span>
      <AutoTextarea
        className="shot-cell audio"
        value={audio}
        placeholder="Dialogue / VO / SFX"
        onChange={(e) => setAudio(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); } }}
      />
      <AutoTextarea
        className="shot-cell visual"
        value={visual}
        placeholder="What we see"
        onChange={(e) => setVisual(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); } }}
      />
      <span className="shot-actions">
        <button
          className="shot-delete"
          title="Delete this shot (numbers keep their gaps)"
          onClick={handleDelete}
        >
          <XIcon size={13} />
        </button>
      </span>
    </div>
  );
}
