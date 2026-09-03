import { useEffect, useState } from "react";
import type { Production, ProductionAssembly } from "../../../../shared/ipc.js";
import { cascadeMedia, formatRuntime, ProdLog, type LogLine } from "./animatic.js";

const RESOLUTIONS = [
  { label: "1080p", width: 1920, height: 1080 },
  { label: "1440p", width: 2560, height: 1440 },
  { label: "2160p (4K)", width: 3840, height: 2160 },
];

function pickResolution(width?: number, height?: number): number {
  const i = RESOLUTIONS.findIndex((r) => r.width === width && r.height === height);
  return i >= 0 ? i : 0;
}

export function AssemblyPanel({
  prod,
  onApply,
  log,
}: {
  prod: Production;
  onApply: (p: Promise<Production>) => void;
  log: LogLine[];
}) {
  const [fps, setFps] = useState(prod.assembly?.fps ?? 24);
  const [resIndex, setResIndex] = useState(pickResolution(prod.assembly?.width, prod.assembly?.height));
  const [busy, setBusy] = useState<"build" | "render" | null>(null);

  useEffect(() => {
    setFps(prod.assembly?.fps ?? 24);
    setResIndex(pickResolution(prod.assembly?.width, prod.assembly?.height));
  }, [prod.assembly?.fps, prod.assembly?.width, prod.assembly?.height]);

  const cfg = (): Partial<Pick<ProductionAssembly, "fps" | "width" | "height">> => ({
    fps,
    width: RESOLUTIONS[resIndex].width,
    height: RESOLUTIONS[resIndex].height,
  });

  const build = () => {
    setBusy("build");
    onApply(
      window.cascade
        .assemblyBuild(prod.meta.id, cfg())
        .finally(() => setBusy(null))
    );
  };

  const render = () => {
    setBusy("render");
    onApply(window.cascade.assemblyRender(prod.meta.id).finally(() => setBusy(null)));
  };

  const asm = prod.assembly;
  const renderPath = asm?.renderPath;
  const exportDir = asm?.exportDir ?? `${prod.assets.outDir}/${prod.assets.assemblyDir}`;

  return (
    <section className="prod-panel prod-assembly">
      <h3>5 · Assembly</h3>
      <p className="hint">
        Build the export package — media, CMX3600 EDL, After Effects rebuild script, and manifest — then
        render the final MP4 from the timed animatic.
      </p>

      <div className="prod-assembly-layout">
        {renderPath && (
          <video className="prod-assembly-render" src={cascadeMedia(prod.meta.id, renderPath)} controls />
        )}

        <section className="prod-assembly-card">
          <div className="prod-assembly-config">
            <div className="prod-assembly-config-fields">
              <label className="prod-openart-label">FPS
                <select className="prod-openart-select" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                  {[24, 25, 30].map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
              <label className="prod-openart-label">Resolution
                <select className="prod-openart-select" value={resIndex} onChange={(e) => setResIndex(Number(e.target.value))}>
                  {RESOLUTIONS.map((r, i) => <option key={r.label} value={i}>{r.label}</option>)}
                </select>
              </label>
            </div>
            <div className="prod-assembly-config-actions">
              <button className="prod-btn primary" onClick={build} disabled={busy !== null}>
                {busy === "build" ? "Building…" : "Build package"}
              </button>
              <button
                className="prod-btn primary"
                onClick={render}
                disabled={busy !== null || !asm?.assembledAt}
                title={asm?.assembledAt ? undefined : "Build the package first"}
              >
                {busy === "render" ? "Rendering…" : "Render MP4"}
              </button>
              <button className="prod-btn" onClick={() => void window.cascade.assemblyOpenFolder(prod.meta.id)}>
                Open export folder
              </button>
            </div>
          </div>

          <div className="prod-assembly-status">
            {asm?.assembledAt && (
              <p className="hint">
                Package built {new Date(asm.assembledAt).toLocaleString()} · runtime ≈{" "}
                {formatRuntime(asm.totalSec ?? 0)} · {exportDir}
              </p>
            )}
            {asm?.skippedShots && asm.skippedShots.length > 0 && (
              <p className="hint">Blank slot (no frame/clip): {asm.skippedShots.join(", ")}</p>
            )}
            {asm?.renderedAt && (
              <p className="hint">
                Rendered {new Date(asm.renderedAt).toLocaleString()} —{" "}
                <button className="prod-btn inline" onClick={() => void window.cascade.assemblyOpenFolder(prod.meta.id)}>
                  {renderPath ?? "render.mp4"}
                </button>
              </p>
            )}
          </div>
        </section>
      </div>

      {log.length > 0 && <ProdLog lines={log} />}
    </section>
  );
}