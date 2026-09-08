/**
 * Two-column shot table: scenes as sections, shots as editable rows.
 * Numbering is displayed (main owns the shotter); inserts land mid-numbered.
 * Shots are draggable via the handle on the left — dropped shots re-number
 * the whole production and relocate board files.
 * Dropzones sit explicitly BETWEEN rows (and at scene ends) with a clear
 * accent insertion line, so landing position is predictable. When nothing is
 * being dragged, the same gaps grow a hover "+" that inserts a blank shot;
 * the gaps between scenes grow a hover "+" that adds a new scene.
 */
import { Fragment, useRef, useState } from "react";
import type { Production, ProductionScene } from "../../../shared/ipc.js";
import { AutoTextarea } from "./AutoTextarea.js";
import { DragHandleIcon, PlusIcon, XIcon } from "./icons.js";
import { usePersistedCollapsed } from "./production/persisted-state.js";

interface Props {
  prod: Production;
  onMutation: (p: Promise<Production>) => void;
}

export function ShotTable({ prod, onMutation }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [activeZone, setActiveZone] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);

  function handleReorder(shotId: string, beforeShotId: string | null) {
    if (shotId === beforeShotId) return;
    onMutation(window.cascade.reorderShot(prod.meta.id, shotId, beforeShotId));
  }

  if (!prod.scenes.length) return null;
  return (
    <div className="shot-table">
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
            dragIdRef={dragIdRef}
            activeZone={activeZone}
            onDragStart={(id) => { dragIdRef.current = id; setDragId(id); }}
            onDragEnd={() => { dragIdRef.current = null; setDragId(null); setActiveZone(null); }}
            onActiveZone={setActiveZone}
            onReorder={handleReorder}
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
  dragIdRef: React.MutableRefObject<string | null>;
  activeZone: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onActiveZone: (id: string | null) => void;
  onReorder: (shotId: string, beforeShotId: string | null) => void;
}

function zoneKey(beforeId: string | null): string {
  return beforeId === null ? "__end__" : `before-${beforeId}`;
}

function SceneBlock({ scene, prod, onMutation, dragId, dragIdRef, activeZone, onDragStart, onDragEnd, onActiveZone, onReorder }: SceneProps) {
  const [collapsed, setCollapsed] = usePersistedCollapsed(`cascade.prod.${prod.meta.id}.scene.${scene.number}`);
  const open = !collapsed;
  const isDragging = dragId !== null;
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
                isDragging={isDragging}
                dragIdRef={dragIdRef}
                activeZone={activeZone}
                onActiveZone={onActiveZone}
                onReorder={onReorder}
                onDragEnd={onDragEnd}
                onMutation={onMutation}
              />
              <ShotRow
                prod={prod}
                scene={scene}
                index={i}
                onMutation={onMutation}
                dragId={dragId}
                dragIdRef={dragIdRef}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
              />
            </Fragment>
          ))}
          {/* Final insertion point at end of production — only on last scene */}
          {prod.scenes[prod.scenes.length - 1]?.number === scene.number && (
            <ShotGap
              scene={scene}
              prod={prod}
              index={scene.shots.length}
              beforeId={null}
              isDragging={isDragging}
              dragIdRef={dragIdRef}
              activeZone={activeZone}
              onActiveZone={onActiveZone}
              onReorder={onReorder}
              onDragEnd={onDragEnd}
              onMutation={onMutation}
            />
          )}

          {scene.shots.length === 0 && !isDragging && (
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
 * The gap between two rows (or at the end of the production). While a shot is
 * dragged it is a reorder dropzone; otherwise it shows a hover "+" that
 * inserts a blank shot at `index` within the scene.
 */
function ShotGap({ scene, prod, index, beforeId, isDragging, dragIdRef, activeZone, onActiveZone, onReorder, onDragEnd, onMutation }: {
  scene: ProductionScene;
  prod: Production;
  index: number;
  beforeId: string | null;
  isDragging: boolean;
  dragIdRef: React.MutableRefObject<string | null>;
  activeZone: string | null;
  onActiveZone: (id: string | null) => void;
  onReorder: (shotId: string, beforeShotId: string | null) => void;
  onDragEnd: () => void;
  onMutation: Props["onMutation"];
}) {
  const resolvedKey = zoneKey(beforeId);

  if (!isDragging) {
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

  const showActive = activeZone === resolvedKey;

  return (
    <div
      className={"shot-drop-zone" + (showActive ? " active" : "")}
      onDragOver={(e) => {
        if (!dragIdRef.current) return;
        if (dragIdRef.current === beforeId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (activeZone !== resolvedKey) onActiveZone(resolvedKey);
      }}
      onDragLeave={(e) => {
        const rt = e.relatedTarget as HTMLElement | null;
        if (rt && e.currentTarget.contains(rt)) return;
        if (activeZone === resolvedKey) onActiveZone(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const src = dragIdRef.current;
        onActiveZone(null);
        if (!src || src === beforeId) { onDragEnd(); return; }
        onReorder(src, beforeId);
        onDragEnd();
      }}
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

function ShotRow({ prod, scene, index, onMutation, dragId, dragIdRef, onDragStart, onDragEnd }: {
  prod: Production; scene: ProductionScene; index: number; onMutation: Props["onMutation"];
  dragId: string | null;
  dragIdRef: React.MutableRefObject<string | null>;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
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

  return (
    <div className={"shot-row" + (dirty ? " dirty" : "") + (isDragging ? " dragging" : "")} onBlur={commit}>
      <button
        className="shot-drag-handle"
        draggable
        title="Drag to reorder — drop between shots"
        onDragStart={(e) => {
          dragIdRef.current = shot.id;
          onDragStart(shot.id);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("application/x-cascade-shot-order", shot.id);
          e.dataTransfer.setData("text/plain", shot.id);
        }}
        onDragEnd={onDragEnd}
        aria-label="Drag to reorder shot"
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
          onClick={() => onMutation(window.cascade.deleteShot(prod.meta.id, shot.id))}
        >
          <XIcon size={13} />
        </button>
      </span>
    </div>
  );
}
