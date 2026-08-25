/**
 * Two-column shot table: scenes as sections, shots as editable rows.
 * Numbering is displayed (main owns the shotter); inserts land mid-numbered.
 */
import { useState } from "react";
import type { Production, ProductionScene } from "../../../shared/ipc.js";
import { AutoTextarea } from "./AutoTextarea.js";

interface Props {
  prod: Production;
  onMutation: (p: Promise<Production>) => void;
}

export function ShotTable({ prod, onMutation }: Props) {
  if (!prod.scenes.length) return null;
  return (
    <div className="shot-table">
      {prod.scenes.map((scene) => (
        <SceneBlock key={scene.number} scene={scene} prod={prod} onMutation={onMutation} />
      ))}
    </div>
  );
}

function SceneBlock({ scene, prod, onMutation }: { scene: ProductionScene; prod: Production; onMutation: Props["onMutation"] }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="shot-scene">
      <header className="shot-scene-head">
        <button className="shot-scene-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={"shot-caret" + (open ? " open" : "")}>▸</span>
          Scene {scene.number} — {scene.title}
          <span className="shot-scene-count">{scene.shots.length} shot{scene.shots.length === 1 ? "" : "s"}</span>
        </button>
        <button
          className="shot-insert scene"
          title="Insert a shot at the start of this scene"
          onClick={() => onMutation(window.cascade.insertShot(prod.meta.id, scene.number, 0))}
        >
          + Shot
        </button>
      </header>
      {open && (
        <div className="shot-rows">
          <div className="shot-row head">
            <span>#</span>
            <span>Audio</span>
            <span>Visual</span>
            <span />
          </div>
          {scene.shots.map((shot, i) => (
            <ShotRow key={shot.id} prod={prod} scene={scene} index={i} onMutation={onMutation} />
          ))}
        </div>
      )}
    </section>
  );
}

function ShotRow({ prod, scene, index, onMutation }: { prod: Production; scene: ProductionScene; index: number; onMutation: Props["onMutation"] }) {
  const shot = scene.shots[index];
  const [audio, setAudio] = useState(shot.audio);
  const [visual, setVisual] = useState(shot.visual);
  const dirty = audio !== shot.audio || visual !== shot.visual;

  function commit() {
    if (!dirty) return;
    onMutation(window.cascade.updateShot(prod.meta.id, shot.id, { audio, visual }));
  }

  return (
    <div className={"shot-row" + (dirty ? " dirty" : "")} onBlur={commit}>
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
          className="shot-insert"
          title={`Insert a shot between ${shot.number} and the next (mid-numbered)`}
          onClick={() => onMutation(window.cascade.insertShot(prod.meta.id, scene.number, index + 1))}
        >
          ↳
        </button>
        <button
          className="shot-delete"
          title="Delete this shot (numbers keep their gaps)"
          onClick={() => onMutation(window.cascade.deleteShot(prod.meta.id, shot.id))}
        >
          ×
        </button>
      </span>
    </div>
  );
}
