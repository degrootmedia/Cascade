/**
 * The shared image-generation form: model picker, resolution, aspect ratio,
 * the schema-driven advanced options, and the prompt editor with `@[name]`
 * autocomplete. Extracted from `RefGenModal` so the reference popup and the
 * Image Generation & Editing Suite render the exact same controls (one source
 * of truth for the generation surface, no copy drift).
 *
 * Fully controlled: the caller owns model/resolution/aspect/params/prompt and
 * the schema fetch (each surface seeds its options differently). The form only
 * renders + reports changes; `onRemember` lets a caller persist a dropdown
 * choice to its remembered media default.
 */
import type { KeyboardEvent, ReactNode } from "react";
import type {
  CliModelSchema,
  GenParams,
  ImageGenAspectRatio,
  MediaDefaultChoice,
  OpenArtModelChoice,
} from "../../../../shared/ipc.js";
import { isImageModel } from "../../../../shared/ipc.js";
import { ModelOptionsForm, type ModelOptionValues } from "../ModelOptionsForm.js";
import { ReferencePromptEditor } from "./prompt-panel.js";
import type { PromptReference } from "./references.js";

export interface ImageGenFormProps {
  /** Image models available for this surface (pre-filtered by the caller). */
  models: OpenArtModelChoice[];
  model: string;
  onModelChange: (id: string) => void;
  /** Tooltip for the model select. */
  modelTitle?: string;
  resolution: string;
  onResolutionChange: (r: string) => void;
  aspectRatio: ImageGenAspectRatio;
  onAspectRatioChange: (a: ImageGenAspectRatio) => void;
  /** Live schema for the picked model (caller-owned fetch). */
  schema: CliModelSchema | null;
  params: GenParams;
  onParamsChange: (p: GenParams) => void;
  /** localStorage key persisting the Advanced panel's collapsed state. */
  persistKey: string;
  prompt: string;
  onPromptChange: (p: string) => void;
  /** Artwork-bearing references for @ autocomplete + tag previews. */
  promptRefs: PromptReference[];
  promptLabel?: string;
  promptPlaceholder?: string;
  onPromptKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  /** Persist a dropdown choice to the caller's remembered default. */
  onRemember?: (patch: MediaDefaultChoice) => void;
  /** Resolution buckets offered (default 1k/2k/4k). */
  resolutions?: string[];
  /** Render everything (default), or only one half — the suite splits the
   *  controls and the prompt into different panes. */
  render?: "all" | "controls" | "prompt";
  /** Extra fields injected between the options and the prompt (name/category,
   *  source-reference picker, …). */
  children?: ReactNode;
}

/** One `@` autocomplete prompt editor over the caller's reference list. */
export function ImageGenForm({
  models,
  model,
  onModelChange,
  modelTitle,
  resolution,
  onResolutionChange,
  aspectRatio,
  onAspectRatioChange,
  schema,
  params,
  onParamsChange,
  persistKey,
  prompt,
  onPromptChange,
  promptRefs,
  promptLabel,
  promptPlaceholder,
  onPromptKeyDown,
  onRemember,
  resolutions = ["1k", "2k", "4k"],
  render = "all",
  children,
}: ImageGenFormProps) {
  const imageModels = models.filter(isImageModel);
  const effModel = imageModels.some((m) => m.id === model) ? model : (imageModels[0]?.id ?? "");
  const showControls = render !== "prompt";
  const showPrompt = render !== "controls";

  return (
    <>
      {showControls && (
        <>
          <label className="prod-label">Model</label>
          <select
            className="prod-openart-select"
            value={effModel}
            onChange={(e) => {
              onModelChange(e.target.value);
              onRemember?.({ model: e.target.value });
            }}
            title={modelTitle ?? "Image model"}
            disabled={imageModels.length === 0}
          >
            {imageModels.map((m) => (
              <option key={m.id} value={m.id} title={m.description}>{m.displayName}</option>
            ))}
          </select>
          {imageModels.length === 0 && (
            <p className="hint">No image models reported — connect the media provider.</p>
          )}

          <div className="prod-video-row">
            <label className="prod-label">Resolution
              <select
                className="prod-openart-select"
                value={resolution}
                onChange={(e) => {
                  onResolutionChange(e.target.value);
                  onRemember?.({ resolution: e.target.value });
                }}
              >
                {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label className="prod-label">Aspect ratio
              <select
                className="prod-openart-select"
                value={aspectRatio}
                onChange={(e) => {
                  const a = e.target.value as ImageGenAspectRatio;
                  onAspectRatioChange(a);
                  onRemember?.({ aspectRatio: a });
                }}
              >
                <option value="1:1">1:1</option>
                <option value="4:3">4:3</option>
                <option value="16:9">16:9</option>
              </select>
            </label>
          </div>

          <ModelOptionsForm
            schema={schema}
            value={params as ModelOptionValues}
            onChange={(next) => onParamsChange(next as GenParams)}
            exclude={["resolution", "aspect_ratio"]}
            compact
            persistKey={persistKey}
          />
        </>
      )}

      {children}

      {showPrompt && (
        <>
          <label className="prod-label">{promptLabel ?? "Generation prompt"}</label>
          <ReferencePromptEditor
            className="prod-refgen-prompt"
            rows={7}
            resizable
            value={prompt}
            includeBrand={false}
            references={promptRefs}
            placeholder={promptPlaceholder ?? ""}
            onChange={onPromptChange}
            onKeyDown={onPromptKeyDown}
          />
        </>
      )}
    </>
  );
}
