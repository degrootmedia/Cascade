/**
 * Suite prompt/controls panel: the mode toggle (generate/edit), the edit
 * source picker, and the shared `ImageGenForm` (model, resolution, aspect,
 * advanced options, prompt). Submits through the suite's vendor-blind IPC and
 * shows a live credit quote for quotable models.
 */
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { CliModelSchema, CustomRef, OpenArtModelChoice, Production } from "../../../../shared/ipc.js";
import { DEFAULT_ASPECT_RATIO, UPSCALE_UNAVAILABLE_HINT, resolveAspectRatio } from "../../../../shared/ipc.js";
import { ImageGenForm } from "../../components/production/ImageGenForm.js";
import type { PromptReference } from "../../components/production/references.js";
import { rememberMediaDefault } from "../../components/production/media-defaults.js";
import { cascadeMedia } from "../../components/production/animatic.js";
import { refThumbUrl } from "../../components/production/thumb-url.js";
import { MagnifyIcon } from "../../components/icons.js";
import { GenerationCostSuffix } from "../../components/production/generation-cost-label.js";
import { costAspect, isQuotableCostModel } from "../../components/production/generation-cost.js";
import { resolveSuiteModel, resolveSuiteSurfacePool } from "./suite-models.js";
import type { SuiteDraft, SuiteEntry, SuiteMode } from "./suite-types.js";

const MODE_LABEL: Record<SuiteMode, string> = { generate: "Generate", edit: "Edit image", upscale: "Upscale" };

export function SuitePromptPanel({
  prod,
  draft,
  onDraftChange,
  models,
  upscaleModelIds,
  promptRefs,
  schema,
  submitting,
  error,
  providerName,
  providerAvailable,
  upscaleUnavailable = false,
  branchParent,
  onRunAsRoot,
  quotedCredits,
  productionQuality,
  onSubmit,
}: {
  prod: Production;
  draft: SuiteDraft;
  onDraftChange: (patch: Partial<SuiteDraft>) => void;
  models: OpenArtModelChoice[];
  /** Ids offered in Upscale mode (the provider's live upscale probe ∪ the
   *  user's `image:upscale` surface assignments). */
  upscaleModelIds: string[];
  promptRefs: PromptReference[];
  schema: CliModelSchema | null;
  submitting: boolean;
  error: string | null;
  providerName: string;
  providerAvailable: boolean;
  /** The active provider has no upscale path (OpenArt MCP) — Upscale mode is
   *  disabled with an explanatory hint. */
  upscaleUnavailable?: boolean;
  branchParent: SuiteEntry | null;
  onRunAsRoot: () => void;
  quotedCredits: number | null;
  productionQuality?: string;
  onSubmit: () => void;
}) {
  const editable: CustomRef[] = useMemo(
    () => (prod.references ?? []).filter((r) => r.imagePath || r.artwork),
    [prod.references]
  );
  /** Full-res viewer for an edit-source thumbnail's magnifier. */
  const [zoom, setZoom] = useState<{ url: string; name: string } | null>(null);
  const artworkUrl = (r: { imagePath?: string; artwork?: string }) =>
    r.imagePath ? cascadeMedia(prod.meta.id, r.imagePath) : (r.artwork ?? "");
  const frameUrl = draft.sourcePath ? cascadeMedia(prod.meta.id, draft.sourcePath) : "";
  const frameName = draft.sourcePath ? `Frame: ${draft.sourcePath}` : "";
  // Generate and Edit draw from their own surface pools (see ModelSurface);
  // Upscale draws from the capability list (live probe ∪ `image:upscale`
  // assignments) — the suite consumes them, it never invents a pool.
  const surfacePool = useMemo(
    () => resolveSuiteSurfacePool(models, draft.mode, upscaleModelIds),
    [models, draft.mode, upscaleModelIds]
  );
  const activeCtx = draft.mode === "edit" ? "edit" : draft.mode === "upscale" ? "upscale" : "reference";
  const effectiveModel = resolveSuiteModel(draft.model, surfacePool);
  const aspect = (resolveAspectRatio(draft.aspectRatio) as SuiteDraft["aspectRatio"]) ?? DEFAULT_ASPECT_RATIO;
  const needsSource = draft.mode !== "generate";
  const canSubmit =
    (draft.mode === "upscale" || draft.prompt.trim().length > 0) &&
    providerAvailable &&
    (needsSource ? !!(draft.sourceRefId || draft.sourcePath) : true) &&
    surfacePool.length > 0;

  const costReq = isQuotableCostModel(effectiveModel)
    ? {
        model: effectiveModel,
        kind: "image" as const,
        resolution: draft.resolution,
        aspectRatio: costAspect(draft.params),
        ...(productionQuality ? { quality: productionQuality } : {}),
        ...(draft.params && Object.keys(draft.params).length ? { params: { ...draft.params } } : {}),
      }
    : null;

  return (
    <section className="suite-prompt" aria-label="Suite controls">
      <div className="suite-prompt-tabs">
        {(["generate", "edit", "upscale"] as const).map((m) => {
          const disabled = m === "upscale" && upscaleUnavailable;
          return (
            <button
              key={m}
              className={"suite-prompt-tab" + (draft.mode === m ? " active" : "") + (disabled ? " disabled" : "")}
              aria-pressed={draft.mode === m}
              disabled={disabled}
              title={disabled ? UPSCALE_UNAVAILABLE_HINT : undefined}
              onClick={() => {
                onDraftChange({ mode: m });
                if (m !== "generate" && !draft.sourceRefId && !draft.sourcePath && editable[0]) {
                  onDraftChange({ mode: m, sourceRefId: editable[0].id });
                }
              }}
            >
              {MODE_LABEL[m]}
            </button>
          );
        })}
      </div>

      {branchParent && (
        <div className="suite-branch-banner">
          <span>Branching from “{branchParent.prompt.slice(0, 48) || branchParent.kind}”</span>
          <button className="prod-btn ghost" onClick={onRunAsRoot}>Run as new root</button>
        </div>
      )}

      {needsSource && (
        <>
          <div className="prod-label">{draft.mode === "upscale" ? "Image to upscale" : "Image to edit"}</div>
          <div className="suite-edit-sources" role="radiogroup" aria-label={draft.mode === "upscale" ? "Image to upscale" : "Image to edit"}>
            {draft.sourcePath && !draft.sourceRefId && (
              <div className="suite-edit-source selected">
                <span className="suite-edit-source-pick" aria-current="true">
                  <img className="suite-edit-source-thumb" src={refThumbUrl(frameUrl)} alt="" loading="lazy" decoding="async" />
                  <span className="suite-edit-source-name">{frameName}</span>
                </span>
                <button className="suite-edit-source-zoom" title="View full size" onClick={() => setZoom({ url: frameUrl, name: frameName })}>
                  <MagnifyIcon size={12} />
                </button>
              </div>
            )}
            {editable.map((r) => {
              const url = artworkUrl(r);
              const selected = draft.sourceRefId === r.id;
              return (
                <div key={r.id} className={"suite-edit-source" + (selected ? " selected" : "")}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className="suite-edit-source-pick"
                    onClick={() => onDraftChange({ sourceRefId: r.id, sourcePath: undefined })}
                  >
                    <img className="suite-edit-source-thumb" src={refThumbUrl(url)} alt="" loading="lazy" decoding="async" />
                    <span className="suite-edit-source-name">{r.name}</span>
                  </button>
                  <button className="suite-edit-source-zoom" title="View full size" onClick={() => setZoom({ url, name: r.name })}>
                    <MagnifyIcon size={12} />
                  </button>
                </div>
              );
            })}
            {!editable.length && !draft.sourcePath && <p className="hint">No references with images.</p>}
          </div>
        </>
      )}

      <ImageGenForm
        models={surfacePool}
        model={draft.model}
        onModelChange={(m) => onDraftChange({ model: m })}
        resolution={draft.resolution}
        onResolutionChange={(r) => onDraftChange({ resolution: r })}
        aspectRatio={aspect}
        onAspectRatioChange={(a) => onDraftChange({ aspectRatio: a })}
        schema={schema}
        params={draft.params ?? {}}
        onParamsChange={(p) => onDraftChange({ params: p })}
        persistKey="cascade.modelOptions.advanced.suite"
        prompt={draft.prompt}
        onPromptChange={(p) => onDraftChange({ prompt: p })}
        promptRefs={promptRefs}
        render={draft.mode === "upscale" ? "controls" : "all"}
        promptLabel={draft.mode === "edit" ? "Edit prompt" : "Generation prompt"}
        promptPlaceholder={
          draft.mode === "edit"
            ? 'Describe the edit, e.g. "make it darker, add warm candlelight" — type @ to cite a reference'
            : 'Describe the image, e.g. "a red velvet gondola interior, cinematic light" — type @ to cite a reference'
        }
        onPromptKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canSubmit) void onSubmit();
        }}
        onRemember={(patch) => rememberMediaDefault(activeCtx, patch)}
      />

      {!providerAvailable && (
        <p className="error-text">The active media provider ({providerName}) isn't available — connect it in Settings, or switch providers.</p>
      )}
      {error && <p className="error-text">{error}</p>}

      <button className="prod-btn prod-edit-go" disabled={!canSubmit || submitting} onClick={() => void onSubmit()}>
        {submitting ? "Generating…" : <>{draft.mode === "edit" ? "Edit" : draft.mode === "upscale" ? "Upscale" : "Generate"}<GenerationCostSuffix req={costReq} /></>}
      </button>
      {quotedCredits != null && <p className="hint">Last quote: {quotedCredits} credits</p>}
      <p className="hint">
        {draft.mode === "edit"
          ? "The source reference's current image is uploaded; the result is saved to the suite (the reference is untouched). Ctrl+Enter to submit."
          : draft.mode === "upscale"
            ? "The source image is uploaded and enhanced by an upscale model; the result is saved to the suite (the source is untouched). Ctrl+Enter to submit."
            : "The result is saved to the suite's own folder — no reference is created. Ctrl+Enter to submit."}
      </p>
      {zoom && createPortal(
        <div className="prod-ref-lightbox" onClick={() => setZoom(null)}>
          <figure className="prod-ref-lightbox-card">
            <img src={zoom.url} alt={zoom.name} />
            <figcaption>{zoom.name} — click anywhere to close</figcaption>
          </figure>
        </div>,
        document.body
      )}
    </section>
  );
}
