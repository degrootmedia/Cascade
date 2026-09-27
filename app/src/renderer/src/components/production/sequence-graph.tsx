/**
 * The shot sequence canvas — literally the node graph (`NodeGraphModal`),
 * hosted on the sequence's shot-shaped `graph` state. There is no special
 * canvas: every node, shelf, and control is the same one every shot uses.
 * The only differences are its pre-population (a video-generation node citing
 * the member frames as image nodes) and that its output node's binding is what
 * replaces the encompassed frames in the animatic and the export.
 *
 * This module is the host adapter: it builds the facade shot, supplies the
 * member frames as locked references, and implements the graph's host-computed
 * callbacks (output pipes, take selection, prompt/style/brand) as local
 * patches onto `seq.graph`. Generators a sequence has no home for yet are
 * disabled with a hint.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GenParams, GraphLayout, GraphVideoNode, OpenArtModelChoice, Production, ProductionShot, SequenceSegment, ShotSequence } from "../../../../shared/ipc.js";
import { normalizeSequenceSegments, sequenceSelectedTake, sequenceSegmentLine, sequenceTotalDuration } from "../../../../shared/ipc.js";
import {
  removeRefTag,
  refTagNames,
} from "../../../../shared/prompt-grammar.js";
import { promptRefsFor, renderPromptText, stripSharedSections } from "../../../../shared/graph/render.js";
import { styleFrameForShot } from "../../../../shared/look.js";
import { setBrandEdge, setStyleEdge } from "../../../../shared/graph/connect.js";
import { applySequenceFrames } from "../../../../shared/graph/connect.js";
import { NodeGraphModal, type GraphRef } from "../NodeGraphModal.js";
import { promptRefsForShot } from "./references.js";
import { cascadeMedia } from "./animatic.js";
import { getPromptTemplate } from "./prompt-templates.js";

/** The generators a sequence canvas hides entirely: image generation (with
 *  its composer prompt node) and the shot-only generator nodes. Only video
 *  generation and video editing remain, plus the frames/refs and the output. */
export const SEQUENCE_HIDDEN_TOOLS = ["imagegen", "edit", "tween", "cameraGrid", "upscale", "brand"] as const;

/** The sequence's member frames as locked reference inputs: image nodes exactly
 *  like reference nodes, live-linked to each shot's current output frame. */
export function sequenceFrameRefs(prod: Production, seq: ShotSequence): GraphRef[] {
  const shots = [...prod.scenes.flatMap((s) => s.shots), ...(prod.outdatedShots ?? [])];
  return seq.shotIds.flatMap((id) => {
    const shot = shots.find((s) => s.id === id);
    if (!shot) return [];
    return [{
      id: `seqframe:${id}`,
      name: `Shot ${shot.number}`,
      artwork: shot.artwork ? cascadeMedia(prod.meta.id, shot.artwork) : "",
      locked: true,
    }];
  });
}

/** The ordered wired inputs (member shot ids and/or reference ids) a video
 *  node cites: explicit legacy `refIds` first, then any `@[name]` prompt
 *  citations resolved against member frames and real references. */
export function sequenceVideoInputIds(prod: Production, seq: ShotSequence, nodeId: string): { ids: string[]; frameNames: string[] } {
  const shots = [...prod.scenes.flatMap((s) => s.shots), ...(prod.outdatedShots ?? [])];
  const members = seq.shotIds.map((id) => shots.find((s) => s.id === id)).filter((s): s is ProductionShot => !!s);
  const node = (seq.graph?.graphVideoNodes ?? []).find((n) => n.id === nodeId);
  const ids: string[] = [];
  const frameNames: string[] = [];
  const add = (id: string) => { if (id && !ids.includes(id)) ids.push(id); };
  for (const id of node?.refIds ?? []) add(id);
  for (const name of refTagNames(node?.prompt ?? "")) {
    const frame = members.find((s) => `Shot ${s.number}` === name);
    if (frame) {
      add(frame.id);
      if (!frameNames.includes(name)) frameNames.push(name);
      continue;
    }
    const ref = [
      ...(prod.characters ?? []).map((c) => ({ id: c.id, name: c.name })),
      ...(prod.products ?? []).map((p) => ({ id: p.id, name: p.name })),
      ...(prod.references ?? []).map((r) => ({ id: r.id, name: r.name })),
    ].find((r) => r.name === name);
    if (ref) add(ref.id);
  }
  return { ids, frameNames };
}

/** What the host submits for one of the sequence's video nodes. */
export interface SequenceVideoGenOpts {
  nodeId: string;
  prompt: string;
  model: string;
  resolution: string;
  durationSec: number;
  refIds: string[];
  params?: Record<string, string>;
}

/** What the host submits to edit one of the sequence's edit-video nodes. */
export interface SequenceEditVideoGenOpts {
  nodeId: string;
  prompt: string;
  model: string;
  sourcePath?: string;
  sourceRefId?: string;
  refIds: string[];
  params?: Record<string, string>;
}

/** Statement of what the sequence's graph can host. */
export function SequenceGraphModal({ prod, seq, imageModels, videoModels, endFrameModelIds, videoEditUnavailable, busyNodeIds, readOnly, framePromptFor, onClose, onGraphField, onGenerate, onGenerateEditVideo, onDropFile, onPasteFiles, onRenameRef, onSaveGenerationAsReference, onDeleteGeneration, onDetach }: {
  prod: Production;
  seq: ShotSequence;
  imageModels: OpenArtModelChoice[];
  videoModels: OpenArtModelChoice[];
  endFrameModelIds?: string[] | null;
  /** The active provider has no video-edit path — its tile is disabled. */
  videoEditUnavailable?: boolean;
  /** Video node ids with a clip generation in flight. */
  busyNodeIds: string[];
  readOnly?: boolean;
  /** The effective storyboard prompt for a member shot (Magic when on, else
   *  the frame prompt), used to seed each timeline row's prompt. */
  framePromptFor?: (shotId: string) => Promise<string>;
  onClose: () => void;
  /** Patch the sequence's canvas state (`seq.graph`, the shot-shaped document
   *  the graph reads). Accepts a value or an updater — the host evaluates an
   *  updater against the FRESHEST state, so a burst of writes (add a node,
   *  then save its layout) can't clobber each other. */
  onGraphField: (patch: Partial<ProductionShot> | ((graph: ProductionShot) => Partial<ProductionShot>)) => void;
  onGenerate: (opts: SequenceVideoGenOpts) => void;
  /** Submit an edit for one of the sequence's edit-video nodes. */
  onGenerateEditVideo?: (opts: SequenceEditVideoGenOpts) => void;
  onDropFile: (file: File) => Promise<GraphRef | null> | void;
  onPasteFiles?: (files: File[]) => Promise<GraphRef[]>;
  onRenameRef?: (refId: string, name: string) => void;
  onSaveGenerationAsReference?: (rel: string) => Promise<GraphRef | null>;
  onDeleteGeneration?: (rel: string) => void;
  onDetach?: () => void;
}) {
  const gshot = useMemo(() => {
    const base: ProductionShot = { id: seq.id, number: seq.name, audio: "", visual: "" };
    return { ...(seq.graph ?? {}), ...base };
  }, [seq]);

  // Per-member effective prompts (fetched by the workspace), seeded into each
  // timeline row and restored by Revert.
  const [framePrompts, setFramePrompts] = useState<Record<string, string>>({});
  const loadFramePrompt = useCallback(async (shotId: string) => {
    if (!framePromptFor) return;
    try {
      // The frame's effective prompt carries the shared Style/Brand sections;
      // a timeline row is the shot's own description, so omit them.
      const text = stripSharedSections(await framePromptFor(shotId)).trim();
      setFramePrompts((p) => (p[shotId] === text ? p : { ...p, [shotId]: text }));
    } catch { /* leave unseeded */ }
  }, [framePromptFor]);
  const shotIdsKey = seq.shotIds.join(",");
  useEffect(() => {
    for (const id of seq.shotIds) void loadFramePrompt(id);
  }, [seq.id, shotIdsKey, loadFramePrompt]);

  /** Replace the sequence's timeline segments (and keep the canvas's frame
   *  edges in step). */
  const setSegments = useCallback((segments: SequenceSegment[]) => {
    onGraphField((g) => ({
      graphSequence: { segments },
      ...(g.graph ? { graph: applySequenceFrames(g.graph, segments) } : {}),
    }));
  }, [onGraphField]);

  /** Clear a segment's override so it follows the frame prompt again. */
  const revertFramePrompt = useCallback((shotId: string) => {
    setSegments(normalizeSequenceSegments(gshot.graphSequence?.segments).map((s) => (s.shotId === shotId ? { ...s, prompt: "" } : s)));
    void loadFramePrompt(shotId);
  }, [setSegments, loadFramePrompt, gshot.graphSequence]);

  /** Patch one video node's fields in the freshest graph. */
  const patchVideoNode = useCallback((nodeId: string, p: Partial<GraphVideoNode>) => {
    onGraphField((g) => {
      const nodes = g.graphVideoNodes ?? [];
      return {
        graphVideoNodes: nodes.some((n) => n.id === nodeId)
          ? nodes.map((n) => (n.id === nodeId ? { ...n, ...p } : n))
          : [...nodes, { id: nodeId, prompt: "", ...p }],
      };
    });
  }, [onGraphField]);

  /** Render the video prompt and resolve what to upload. The pre-populated
   *  node cites member frames as `@[Shot NNNN]`; those are host inputs, not
   *  references, so they are removed from the vendor prompt and uploaded as
   *  visual references alongside any real reference cited. (Reads happen at
   *  click time, after every earlier write has re-rendered.) */
  const runVideoGen = useCallback(async (nodeId: string, model: string, resolution: string, durationSec: number, params?: Record<string, string>) => {
    const node = (seq.graph?.graphVideoNodes ?? []).find((n) => n.id === nodeId);
    // A shot sequence submits its timed multi-shot timeline: the rendered
    // Visuals body (Style/Brand + reference tags) followed by one numbered
    // seconds line per member shot, with every member frame uploaded in order.
    if (gshot.graphSequence) {
      const segments = normalizeSequenceSegments(gshot.graphSequence.segments);
      // The sequence prompt has no brand section: render Style + Visuals only.
      const renderRefs = promptRefsFor(prod, gshot, { videoprompt: nodeId });
      const visuals = renderPromptText(node?.prompt ?? "", { ...renderRefs, brandAttached: false, brand: "" });
      const { ids } = sequenceVideoInputIds(prod, seq, nodeId);
      // The frame token's number is its position in the submitted reference
      // list: the style frame (when the shot resolves to one) and the Visuals
      // references occupy the low numbers, then the member frames.
      const shotIdSet = new Set(seq.shotIds);
      const visualCount = ids.filter((id) => !shotIdSet.has(id)).length;
      const imageOffset = (styleFrameForShot(prod, gshot) ? 1 : 0) + visualCount;
      const lines = segments.map((s, i) => sequenceSegmentLine(
        { ...s, prompt: s.prompt.trim() || (framePrompts[s.shotId] ?? "") },
        i + 1,
        imageOffset + i + 1,
      ));
      const body = [visuals, ...lines].filter((t) => t && t.trim()).join("\n\n");
      onGenerate({
        nodeId,
        prompt: body,
        model,
        resolution,
        // The selector (seeded to the timeline total) wins; fall back to the
        // total when it is somehow unset.
        durationSec: durationSec || sequenceTotalDuration(segments),
        refIds: [...new Set([...segments.map((s) => s.shotId), ...ids])],
        ...(params && Object.keys(params).length ? { params } : {}),
      });
      return;
    }
    const { ids, frameNames } = sequenceVideoInputIds(prod, seq, nodeId);
    let promptText = (node?.prompt ?? "").trim() ? node!.prompt : getPromptTemplate("videoMotion");
    for (const name of frameNames) promptText = removeRefTag(promptText, name);
    const prompt = renderPromptText(promptText, promptRefsFor(prod, gshot, { videoprompt: nodeId }));
    onGenerate({ nodeId, prompt, model, resolution, durationSec, refIds: ids, ...(params && Object.keys(params).length ? { params } : {}) });
  }, [prod, seq, gshot, onGenerate, framePrompts]);

  /** Render one edit-video node's prompt and resolve the source clip it edits
   *  (a wired sequence take, a video reference, or the sequence's own take). */
  const runEditVideo = useCallback(async (nodeId: string, model: string, prompt: string, params?: GenParams) => {
    const node = (seq.graph?.graphVideoNodes ?? []).find((n) => n.id === nodeId);
    const src = node?.source;
    let sourcePath: string | undefined;
    let sourceRefId: string | undefined;
    if (src?.kind === "ref") {
      sourceRefId = src.refId;
      sourcePath = (prod.references ?? []).find((r) => r.id === src.refId)?.mediaPath;
    } else if (src?.kind === "video") {
      sourcePath = sequenceSelectedTake(seq, src.nodeId);
    }
    if (!sourcePath) sourcePath = sequenceSelectedTake(seq);
    const rendered = renderPromptText(
      (node?.prompt ?? "").trim() ? node!.prompt : prompt,
      promptRefsFor(prod, gshot, { editvideoprompt: nodeId })
    );
    onGenerateEditVideo?.({
      nodeId,
      prompt: rendered,
      model,
      ...(sourcePath ? { sourcePath } : {}),
      ...(sourceRefId ? { sourceRefId } : {}),
      refIds: node?.refIds ?? [],
      ...(params && Object.keys(params).length ? { params } : {}),
    });
  }, [prod, seq, gshot, onGenerateEditVideo]);

  const selectGen = useCallback((kind: "image" | "video" | "edit" | "editvideo" | "upscale", index: number, nodeId?: string) => {
    onGraphField((g) => {
      if (kind === "upscale") {
        return g.graphUpscale?.gens?.[index] ? { graphUpscale: { ...g.graphUpscale, genIndex: index } } : {};
      }
      if (kind === "video") {
        const node = (g.graphVideoNodes ?? []).find((n) => n.id === nodeId) ?? g.graphVideoNodes?.[0];
        if (!node?.gens?.[index]) return {};
        return { graphVideoNodes: (g.graphVideoNodes ?? []).map((n) => (n.id === node.id ? { ...n, genIndex: index } : n)) };
      }
      if (kind === "edit") {
        const node = (g.graphEditNodes ?? []).find((n) => n.id === nodeId);
        if (!node?.gens?.[index]) return {};
        return { graphEditNodes: (g.graphEditNodes ?? []).map((n) => (n.id === node.id ? { ...n, genIndex: index } : n)) };
      }
      return g.graphImageGens?.[index] ? { graphImageGenIndex: index } : {};
    });
  }, [onGraphField]);

  const cycleGen = useCallback((kind: "image" | "video" | "edit" | "editvideo" | "upscale", dir: 1 | -1, nodeId?: string) => {
    onGraphField((g) => {
      let items: unknown[] | undefined;
      let cur = 0;
      if (kind === "upscale") { items = g.graphUpscale?.gens; cur = g.graphUpscale?.genIndex ?? 0; }
      else if (kind === "video") {
        const node = (g.graphVideoNodes ?? []).find((n) => n.id === nodeId) ?? g.graphVideoNodes?.[0];
        items = node?.gens; cur = node?.genIndex ?? 0;
      } else if (kind === "edit") {
        const node = (g.graphEditNodes ?? []).find((n) => n.id === nodeId);
        items = node?.gens; cur = node?.genIndex ?? 0;
      } else { items = g.graphImageGens; cur = g.graphImageGenIndex ?? 0; }
      if (!items || !items.length) return {};
      const next = (cur + dir + items.length) % items.length;
      if (kind === "upscale") return { graphUpscale: { ...g.graphUpscale!, genIndex: next } };
      if (kind === "video") {
        const node = (g.graphVideoNodes ?? []).find((n) => n.id === nodeId) ?? g.graphVideoNodes?.[0];
        return { graphVideoNodes: (g.graphVideoNodes ?? []).map((n) => (n.id === node!.id ? { ...n, genIndex: next } : n)) };
      }
      if (kind === "edit") {
        const node = (g.graphEditNodes ?? []).find((n) => n.id === nodeId);
        return { graphEditNodes: (g.graphEditNodes ?? []).map((n) => (n.id === node!.id ? { ...n, genIndex: next } : n)) };
      }
      return { graphImageGenIndex: next };
    });
  }, [onGraphField]);

  const frameRefs = useMemo(() => sequenceFrameRefs(prod, seq), [prod, seq]);
  const references = useMemo(
    () => [...(promptRefsForShot(prod, seq.shotIds[0] ?? "") as unknown as GraphRef[]), ...frameRefs],
    [prod, seq.shotIds, frameRefs],
  );

  return (
    <NodeGraphModal
      prod={prod}
      shot={gshot}
      bust={0}
      prompt={gshot.prompt ?? ""}
      references={references}
      styles={prod.styles ?? []}
      styleValue={gshot.style ?? ""}
      includeBrand={gshot.includeBrandIdentity === true}
      hiddenTools={SEQUENCE_HIDDEN_TOOLS}
      hidePalette
      videoEditUnavailable={videoEditUnavailable}
      subjectLabel={seq.name}
      initialLayout={gshot.graphLayout}
      imageModels={imageModels}
      videoModels={videoModels}
      endFrameModelIds={endFrameModelIds}
      defaultImageModel={prod.openArt?.model ?? "auto"}
      defaultImageResolution={prod.openArt?.resolution ?? "1k"}
      videoBusyNodeIds={busyNodeIds}
      editVideoBusyNodeIds={busyNodeIds}
      readOnly={readOnly}
      onClose={onClose}
      onPromptChange={(value) => onGraphField({ prompt: value })}
      onStyleChange={(style) => onGraphField((g) => ({
        style: style || undefined,
        styleNone: !style,
        ...(g.graph ? { graph: setStyleEdge(g.graph, "composer", !!style) } : {}),
      }))}
      onToggleBrand={(include) => onGraphField((g) => ({
        includeBrandIdentity: include,
        ...(g.graph ? { graph: setBrandEdge(g.graph, "composer", include) } : {}),
      }))}
      onStyleDetached={() => onGraphField((g) => ({
        styleNone: true,
        ...(g.graph ? { graph: setStyleEdge(g.graph, "composer", false) } : {}),
      }))}
      onDropFile={onDropFile}
      onPasteFiles={onPasteFiles}
      onRenameRef={onRenameRef}
      onGraphField={onGraphField}
      sequenceFramePrompts={framePrompts}
      onSequenceSegments={setSegments}
      onRevertFramePrompt={revertFramePrompt}
      onSaveLayout={(layout: GraphLayout) => onGraphField((g) => ({ graphLayout: { ...(g.graphLayout ?? {}), ...layout } }))}
      onRunImageGen={async () => {}}
      onRunVideoGen={runVideoGen}
      onRunEditVideo={runEditVideo}
      onRunEditGen={async () => {}}
      onSelectGraphGen={(kind, index, nodeId) => selectGen(kind, index, nodeId)}
      onCycleGraphGen={(kind, dir, nodeId) => cycleGen(kind, dir, nodeId)}
      onDeleteGeneration={onDeleteGeneration ?? (() => {})}
      onSaveGenerationAsReference={onSaveGenerationAsReference ?? (async () => null)}
      onSaveAsReference={(rel) => { void onSaveGenerationAsReference?.(rel); }}
      // ---- Pipes: the output binding is what replaces the span in the
      // animatic/export, so it is persisted on the sequence's graph state.
      onPipeImageToVideo={(nodeId) => patchVideoNode(nodeId, { source: { kind: "imagegen" } })}
      onPipeRefToVideo={(nodeId, refId) => patchVideoNode(nodeId, { source: { kind: "ref", refId } })}
      onUnpipeImageToVideo={(nodeId) => patchVideoNode(nodeId, { source: undefined })}
      onPipeImageToOutput={() => onGraphField({ graphOutputSource: "imagegen", graphOutputRefId: undefined, graphOutputVideoNodeId: undefined, graphOutputEditNodeId: undefined })}
      onPipeVideoToOutput={(nodeId) => onGraphField({ graphOutputSource: "videogen", graphOutputVideoNodeId: nodeId, graphOutputRefId: undefined, graphOutputEditNodeId: undefined })}
      onPipeEditToOutput={(nodeId) => onGraphField({ graphOutputSource: "editgen", graphOutputEditNodeId: nodeId, graphOutputRefId: undefined, graphOutputVideoNodeId: undefined })}
      onPipeRefToOutput={(refId) => onGraphField({ graphOutputSource: "ref", graphOutputRefId: refId, graphOutputVideoNodeId: undefined, graphOutputEditNodeId: undefined })}
      onUnpipeOutput={() => onGraphField({ graphOutputSource: undefined, graphOutputRefId: undefined, graphOutputVideoNodeId: undefined, graphOutputEditNodeId: undefined })}
      onUnpipeImageGen={() => onGraphField((g) => ({
        // The image node's output may feed video nodes; the output feed clears.
        graphVideoNodes: (g.graphVideoNodes ?? []).map((n) => (n.source?.kind === "imagegen" ? { ...n, source: undefined } : n)),
        ...(g.graphOutputSource === "imagegen" ? { graphOutputSource: undefined } : {}),
      }))}
      onUnpipeVideoGen={() => onGraphField((g) => (
        g.graphOutputSource === "videogen" ? { graphOutputSource: undefined, graphOutputVideoNodeId: undefined } : {}
      ))}
      onUnpipeEditGen={(nodeId: string) => onGraphField((g) => ({
        graphVideoNodes: (g.graphVideoNodes ?? []).map((n) => (n.source?.kind === "editgen" && n.source.nodeId === nodeId ? { ...n, source: undefined } : n)),
        ...(g.graphOutputSource === "editgen" && g.graphOutputEditNodeId === nodeId ? { graphOutputSource: undefined, graphOutputEditNodeId: undefined } : {}),
      }))}
      onDetach={onDetach}
    />
  );
}
