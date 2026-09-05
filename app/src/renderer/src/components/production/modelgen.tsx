/**
 * Design-page 3D model generator (Step 2): a Tencent Hunyuan Pro
 * text/image/multi-view-to-3D form, a gallery of generated models, and an
 * in-place <model-viewer> canvas with Save-As… / Delete actions. Generated
 * GLBs are always stored in the production's models folder; the viewer
 * streams them via cascade-media://.
 *
 * Image input is drop-zone based: each view slot accepts a reference image
 * dragged from the app (the `application/x-cascade-reference` payload), an
 * external image file dropped from the OS, or a native file browser via
 * "Click to open a file browser".
 */
import { useEffect, useState, type CSSProperties, type DetailedHTMLProps, type HTMLAttributes, type DragEvent } from "react";
import type { Model3dGenOptions, Model3dViewImage, Model3dViewType, Production, ProductionModel } from "../../../../shared/ipc.js";
import { cascadeMedia } from "./animatic.js";

/** model-viewer is a custom element; declare it for JSX. */
declare global {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string;
          alt?: string;
          "auto-rotate"?: boolean;
          "camera-controls"?: boolean;
          "shadow-intensity"?: string | number;
          "environment-image"?: string;
          exposure?: string | number;
          style?: CSSProperties;
        },
        HTMLElement
      >;
    }
  }
}

const GENERATE_TYPES: { id: Model3dGenOptions["generateType"]; label: string; hint: string }[] = [
  { id: "Normal", label: "Normal", hint: "Textured model with full geometry" },
  { id: "Geometry", label: "Geometry", hint: "White model, no texture" },
  { id: "LowPoly", label: "Low Poly", hint: "Reduced polygon count (3.0 only)" },
  { id: "Sketch", label: "Sketch", hint: "From a sketch or line drawing (3.0 only)" },
];

/** The multi-view angle slots offered per model version. The API requires a
 *  "front" view; the rest are optional. 3.0: front/left/right/back, 3.1 adds
 *  top/bottom/left_front/right_front. */
const VIEWS_3_0: { type: Model3dViewType; label: string }[] = [
  { type: "front", label: "Front" },
  { type: "left", label: "Left" },
  { type: "right", label: "Right" },
  { type: "back", label: "Back" },
];
const VIEWS_3_1: { type: Model3dViewType; label: string }[] = [
  ...VIEWS_3_0,
  { type: "top", label: "Top" },
  { type: "bottom", label: "Bottom" },
  { type: "left_front", label: "Front-left" },
  { type: "right_front", label: "Front-right" },
];

/** The mode of the image input. Multi-view sends several angles; single image
 *  sends one. Text is prompt-only. */
type InputMode = "text" | "single" | "multiview";

const MAX_VIEW_IMAGE_BYTES = 15 * 1024 * 1024;

/** Read an image File as a data URL. */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/** All artwork-bearing references on the production (characters, products,
 *  custom references). */
function allRefs(prod: Production): { id: string; name: string; imagePath?: string; artwork?: string }[] {
  return [
    ...prod.characters.map((c) => ({ id: c.id, name: c.name, imagePath: c.imagePath, artwork: c.artwork })),
    ...prod.products.map((p) => ({ id: p.id, name: p.name, imagePath: p.imagePath, artwork: p.artwork })),
    ...(prod.references ?? []).map((r) => ({ id: r.id, name: r.name, imagePath: r.imagePath, artwork: r.artwork })),
  ];
}

export function ModelGenSection({ prod, onGenerated }: {
  prod: Production;
  /** Called when a generation finished — main returns the updated production. */
  onGenerated: (p: Production) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [version, setVersion] = useState<"3.0" | "3.1">("3.0");
  const [enablePbr, setEnablePbr] = useState(true);
  const [generateType, setGenerateType] = useState<Model3dGenOptions["generateType"]>("Normal");
  const [faceCount, setFaceCount] = useState("500000");
  const [mode, setMode] = useState<InputMode>("text");
  /** Single image (image-to-3D) as a data URL. */
  const [singleImage, setSingleImage] = useState<string | null>(null);
  /** Multi-view images keyed by view type. */
  const [views, setViews] = useState<Partial<Record<Model3dViewType, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credits, setCredits] = useState<number | null | undefined>(undefined);
  const [viewing, setViewing] = useState<ProductionModel | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const refs = allRefs(prod);
  const models = prod.models3d ?? [];
  const viewsList = version === "3.1" ? VIEWS_3_1 : VIEWS_3_0;
  const multiViewImages: Model3dViewImage[] = viewsList
    .filter((v) => views[v.type])
    .map((v) => ({ viewType: v.type, dataUrl: views[v.type]! }));

  const canSubmit = !busy && (
    mode === "text" ? prompt.trim().length > 0
    : mode === "single" ? !!singleImage
    : !!views.front
  );

  useEffect(() => {
    const maybe = (window.cascade as unknown as { get3daiCredits?: () => Promise<number | null> }).get3daiCredits;
    if (!maybe) { setCredits(null); return; }
    maybe().then((c) => setCredits(c)).catch(() => setCredits(null));
  }, [prod.meta.id, models.length]);

  /** Resolve an in-app reference (drag payload) to its data URL. */
  const resolveRefDataUrl = async (refId: string): Promise<string | null> => {
    const ref = refs.find((r) => r.id === refId);
    if (!ref) return null;
    if (ref.artwork) return ref.artwork;
    if (ref.imagePath) {
      try {
        const res = await fetch(cascadeMedia(prod.meta.id, ref.imagePath));
        if (!res.ok) return null;
        const blob = await res.blob();
        return await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result as string);
          fr.onerror = reject;
          fr.readAsDataURL(blob);
        });
      } catch {
        return null;
      }
    }
    return null;
  };

  /** Read a dropped/selected image File into a data URL, enforcing a size cap. */
  const readImageFile = async (file: File): Promise<string | null> => {
    if (!file.type.startsWith("image/")) {
      setError(`${file.name}: not an image file.`);
      return null;
    }
    if (file.size > MAX_VIEW_IMAGE_BYTES) {
      setError("That image is larger than 15 MB — use a smaller one.");
      return null;
    }
    return fileToDataUrl(file);
  };

  /** Handle a drop onto one view slot: in-app reference or external file. */
  const onDropSlot = (viewType: Model3dViewType | "single") => async (e: DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.remove("dragover");
    const refId = e.dataTransfer.getData("application/x-cascade-reference");
    if (refId) {
      const dataUrl = await resolveRefDataUrl(refId);
      if (!dataUrl) { setError("Couldn't load that reference image."); return; }
      if (viewType === "single") setSingleImage(dataUrl);
      else setViews((v) => ({ ...v, [viewType]: dataUrl! }));
      return;
    }
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      const dataUrl = await readImageFile(files[0]);
      if (!dataUrl) return;
      if (viewType === "single") setSingleImage(dataUrl);
      else setViews((v) => ({ ...v, [viewType]: dataUrl! }));
    }
  };

  /** Open the native file browser for a view slot. */
  const onPickSlot = (viewType: Model3dViewType | "single") => async () => {
    const dataUrl = await window.cascade.pickReferenceImage();
    if (!dataUrl) return;
    if (viewType === "single") setSingleImage(dataUrl);
    else setViews((v) => ({ ...v, [viewType]: dataUrl! }));
  };

  const clearSingle = () => setSingleImage(null);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const opts: Model3dGenOptions = {
        prompt: prompt.trim(),
        version,
        enablePbr,
        generateType,
        faceCount: Math.max(40000, Math.min(1500000, Number(faceCount) || 500000)),
        ...(mode === "single" && singleImage ? { imageDataUrl: singleImage } : {}),
        ...(mode === "multiview" && views.front ? { multiViewImages } : {}),
      };
      const next = await window.cascade.generate3dModel(prod.meta.id, opts);
      onGenerated(next);
      setPrompt("");
      setSingleImage(null);
      setViews({});
      setViewing(next.models3d?.[0] ?? null);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const saveAs = async (m: ProductionModel) => {
    setSavingId(m.id);
    try {
      await window.cascade.save3dModel(prod.meta.id, m.id);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setSavingId(null);
    }
  };

  const remove = async (m: ProductionModel) => {
    if (!confirm(`Delete ${m.glbPath}? This removes the .glb from the production folder.`)) return;
    try {
      const next = await window.cascade.delete3dModel(prod.meta.id, m.id);
      onGenerated(next);
      if (viewing?.id === m.id) setViewing(next.models3d?.[0] ?? null);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const active = viewing ?? models[0] ?? null;

  // model-viewer registers its <model-viewer> custom element at module load and
  // touches browser globals (`self`) — import it lazily, only when a model is
  // actually being previewed, so the static import never breaks the node test
  // environment (renderer components are unit-tested under jsdom).
  const [viewerLoaded, setViewerLoaded] = useState(false);
  useEffect(() => {
    if (!active || viewerLoaded) return;
    let live = true;
    import("@google/model-viewer/lib/model-viewer.js")
      .then(() => { if (live) setViewerLoaded(true); })
      .catch(() => { if (live) setError("3D viewer failed to load."); });
    return () => { live = false; };
  }, [active, viewerLoaded]);

  /** A single drop-zone slot: thumbnail when filled, else the drop/click hint. */
  const viewSlot = (viewType: Model3dViewType | "single") => {
    const dataUrl = viewType === "single" ? singleImage : views[viewType];
    const label = viewType === "single" ? "Single reference" : (viewsList.find((v) => v.type === viewType)?.label ?? viewType);
    return (
      <div
        key={viewType}
        className={"prod-3d-drop" + (dataUrl ? " filled" : "") + (viewType === "front" ? " required" : "")}
        onClick={() => void onPickSlot(viewType)}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; e.currentTarget.classList.add("dragover"); }}
        onDragLeave={(e) => e.currentTarget.classList.remove("dragover")}
        onDrop={(e) => void onDropSlot(viewType)(e)}
        title={`${label} — drop a reference or click to browse`}
        role="button"
      >
        {dataUrl ? (
          <>
            <img src={dataUrl} alt={label} />
            <button
              className="prod-3d-drop-clear"
              title="Remove this image"
              onClick={(e) => { e.stopPropagation(); if (viewType === "single") clearSingle(); else setViews((v) => { const n = { ...v }; delete n[viewType]; return n; }); }}
            >×</button>
          </>
        ) : (
          <>
            <span className="prod-3d-drop-hint">{label}</span>
            <span className="prod-3d-drop-sub">Drop image or click to browse</span>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="prod-refs">
      <p className="hint">
        Generate a <strong>3D model</strong> from a text prompt or one/multiple reference images via{" "}
        <strong>Tencent Hunyuan Pro</strong> (3D AI Studio). Finished GLBs are saved to{" "}
        <code>{prod.assets.modelsDir}/</code> in the production folder and can be previewed here,
        exported elsewhere, or used in any 3D tool.
        {credits === undefined
          ? null
          : credits === null
            ? " No API key set — add one in Settings."
            : ` ${credits} credits remaining.`}
      </p>

      <div className="prod-char-form">
        <label className="prod-label">Input
          <select
            className="prod-openart-select"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as InputMode);
              setError(null);
            }}
          >
            <option value="text">Text prompt</option>
            <option value="single">Single reference image</option>
            <option value="multiview">Multi-view reference images</option>
          </select>
        </label>

        {mode === "text" && (
          <label className="prod-label">Prompt
            <input
              className="prod-refgen-name"
              placeholder="e.g. a medieval sword with ornate handle"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
        )}

        {mode === "single" && (
          <div className="prod-3d-drop-zone">
            {viewSlot("single")}
          </div>
        )}

        {mode === "multiview" && (
          <div className="prod-3d-drop-zone prod-3d-drop-grid">
            {viewsList.map((v) => viewSlot(v.type))}
          </div>
        )}

        <div className="prod-video-row">
          <label className="prod-label">Version
            <select className="prod-openart-select" value={version} onChange={(e) => setVersion(e.target.value as "3.0" | "3.1")}>
              <option value="3.0">3.0</option>
              <option value="3.1">3.1</option>
            </select>
          </label>
          <label className="prod-label">Polygons
            <input
              className="prod-3d-num"
              type="number"
              min={40000}
              max={1500000}
              step={50000}
              value={faceCount}
              onChange={(e) => setFaceCount(e.target.value)}
              title="Target polygon count (40,000 to 1,500,000)"
            />
          </label>
        </div>

        <div className="prod-video-row">
          <label className="prod-label">Generation type
            <select
              className="prod-openart-select"
              value={generateType}
              onChange={(e) => setGenerateType(e.target.value as Model3dGenOptions["generateType"])}
              title={GENERATE_TYPES.find((g) => g.id === generateType)?.hint}
            >
              {GENERATE_TYPES.map((g) => (
                <option key={g.id} value={g.id} disabled={g.id !== "Normal" && version === "3.1"}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
          <label className="prod-label prod-3d-pbr">
            <input type="checkbox" checked={enablePbr} onChange={(e) => setEnablePbr(e.target.checked)} />
            PBR textures
          </label>
        </div>

        {mode === "multiview" && !views.front && (
          <p className="hint">A <strong>front</strong> view is required for multi-view generation.</p>
        )}

        {error && <p className="error-text">{error}</p>}
        <button className="prod-btn" disabled={!canSubmit} onClick={() => void submit()}>
          {busy ? "Generating… (3–6 min)" : "＋ Generate 3D model"}
        </button>
      </div>

      {models.length > 0 && (
        <div className="prod-3d">
          <div className="prod-3d-viewer">
            {active && viewerLoaded ? (
              <model-viewer
                key={active.id}
                src={cascadeMedia(prod.meta.id, active.glbPath)}
                alt={active.prompt}
                auto-rotate
                camera-controls
                shadow-intensity="1"
                environment-image="neutral"
                style={{ width: "100%", height: "360px" }}
              />
            ) : active ? (
              <div style={{ width: "100%", height: "360px", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}>
                {viewerLoaded ? "Loading 3D preview…" : "3D preview unavailable here."}
              </div>
            ) : null}
            {active && (
              <div className="prod-3d-meta">
                <span title={active.prompt}>{active.prompt || "3D model"}</span>
                <span className="hint">
                  {active.edition.toUpperCase()} · {active.pbr ? "PBR" : "no PBR"} ·{" "}
                  {active.fromImage ? "image-to-3D" : "text-to-3D"}
                </span>
                <div className="prod-3d-actions">
                  <button className="prod-btn" onClick={() => void saveAs(active)} disabled={savingId === active.id}>
                    {savingId === active.id ? "Saving…" : "💾 Save As…"}
                  </button>
                  <button className="prod-btn prod-3d-delete" onClick={() => void remove(active)}>× Delete</button>
                </div>
              </div>
            )}
          </div>
          <div className="prod-ref-grid">
            {models.map((m) => (
              <button
                key={m.id}
                className={"prod-ref prod-3d-tile" + (m.id === active?.id ? " selected" : "")}
                onClick={() => setViewing(m)}
                title={`${m.prompt || "3D model"} — click to preview`}
              >
                <span className="prod-3d-tile-icon">🧊</span>
                <span className="prod-3d-tile-label">{m.prompt || "3D model"}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}