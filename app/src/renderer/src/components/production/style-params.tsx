/**
 * Per-style schema-driven model options for the Design step's style cards.
 * A sub-component (not a hook) because style cards render inside a `.map` —
 * each instance fetches its own model's schema and reconciles the parent's
 * persisted params on model switches, mirroring the storyboard toolbar's
 * boardSchema reconcile. Surface `image:generate`: styles share the master
 * image pool (see ModelSurface). Resolution is excluded — the card owns a
 * dedicated Resolution select. Quality renders inline: a per-style pick
 * submits (nearest pick wins over the production default).
 */
import { useEffect, useState } from "react";
import type { CliModelSchema } from "../../../../shared/ipc.js";
import { ModelOptionsForm, pruneModelOptionValues, type ModelOptionValues } from "../ModelOptionsForm.js";
import { seedModelOptionValues } from "./model-param-defaults.js";

export function StyleParamsForm({ modelId, value, onChange }: {
  /** Effective (already resolved) model id for this style. */
  modelId: string;
  /** Persisted params for this style. */
  value: ModelOptionValues;
  onChange: (next: ModelOptionValues) => void;
}) {
  const [schema, setSchema] = useState<CliModelSchema | null>(null);
  useEffect(() => {
    let live = true;
    setSchema(null);
    if (!modelId || modelId === "auto") return () => { live = false; };
    window.cascade.modelOptions(modelId)
      .then((s) => {
        if (!live) return;
        setSchema(s);
      })
      .catch(() => { if (live) setSchema(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);
  // Reconcile the persisted params with the model's schema: prune keys the
  // model doesn't declare AND seed configured per-surface defaults. Writes
  // back only on real change, so no save loop.
  useEffect(() => {
    if (!schema) return;
    const next = seedModelOptionValues(schema, modelId, "image:generate", pruneModelOptionValues(schema, value));
    const changed = Object.keys(next).length !== Object.keys(value).length ||
      Object.keys(next).some((k) => next[k] !== value[k]);
    if (changed) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);
  if (!schema) return null;
  return (
    <ModelOptionsForm
      schema={schema}
      value={value}
      onChange={onChange}
      exclude={["resolution"]}
      compact
      persistKey="cascade.modelOptions.advanced.style"
    />
  );
}
