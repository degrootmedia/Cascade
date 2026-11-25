import { useEffect, useState } from "react";
import { LLM_VISIBILITY_EVENT } from "../../../shared/llm-visibility.js";

/** The LLM model ids hidden in the Model Customizer (Feature #9), kept live:
 *  reloads whenever the customizer fires LLM_VISIBILITY_EVENT. Guarded so a
 *  preload without the channel (mixed-version bundle, test stub) reads as
 *  "nothing hidden". */
export function useHiddenLlmModels(): ReadonlySet<string> {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let live = true;
    const load = () => {
      const api = (window as { cascade?: { getHiddenLlmModels?: () => Promise<string[]> } }).cascade;
      if (typeof api?.getHiddenLlmModels !== "function") return;
      void api.getHiddenLlmModels().then((ids) => { if (live) setHidden(new Set(ids ?? [])); }).catch(() => {});
    };
    load();
    window.addEventListener(LLM_VISIBILITY_EVENT, load);
    return () => { live = false; window.removeEventListener(LLM_VISIBILITY_EVENT, load); };
  }, []);
  return hidden;
}
