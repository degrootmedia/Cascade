/**
 * Legacy flag/text → Graph materializer (master plan step 03 T3).
 *
 * This module is the ONE place allowed to read prompt text to discover wiring
 * — it is the one-time bridge that converts the old representation (flat
 * `graph*` flags + `@[ref]` tags + `Style:`/`Brand identity:` paragraphs)
 * into stored nodes/edges during migration. After migration nothing decides
 * wiring from prompt text; `grep` for prompt regexes outside this file must
 * come back empty. Reuses the prompt-grammar readers (no new regexes) except
 * the `Style:` line test, which replicates NodeGraphModal's exact
 * `/^Style:/m` check (stricter than STYLE_PARA_RE) so migration sees the same
 * wires the canvas draws today.
 *
 * Edge ids replicate the canvas derivation verbatim (`e-style`,
 * `e-<ref>-composer-<i>`, …) so graph-backed rendering produces the identical
 * picture. References to `graphVideoRefIds` / `graphEditVideoRefIds` are
 * intentionally absent: they never had canvas edges (they bind at submit
 * time), so there is no wire to migrate.
 */
import type { Graph, GraphEdge, GraphNode, GraphVideoNode, ProductionShot } from "../ipc.js";
import { videoGenNodeId, videoPromptNodeId } from "../ipc.js";
import { hasBrandParagraph, refTagNames } from "../prompt-grammar.js";
import { videoEdgeId, tweenKeyToNode } from "./connect.js";

/** Minimal reference view the materializer needs: identity, name (tag match), media, artwork. */
export interface GraphRefView {
  id: string;
  name: string;
  /** Dropped video/audio files carry media; absent = image. */
  media?: "video" | "audio";
  artwork?: string;
}

const ORIGIN = { x: 0, y: 0 };

function hasStyleLine(text: string): boolean {
  return /^Style:/m.test(text ?? "");
}

function editGenId(editId: string): string {
  return `editgen:${editId}`;
}

function editPromptId(editId: string): string {
  return `editprompt:${editId}`;
}

/** Mirror of NodeGraphModal's videoGenActive: when the video pair is on canvas. */
export function videoPairActive(shot: ProductionShot): boolean {
  return !!(
    (shot.graphVideoNodes?.length ?? 0) > 0 ||
    (shot.graphVideoGens?.length ?? 0) > 0 ||
    (shot.graphVideoRefIds?.length ?? 0) > 0 ||
    shot.graphImageToVideo ||
    shot.graphEditToVideo ||
    shot.graphVideoSourceRefId ||
    shot.graphOutputSource === "videogen" ||
    (shot.graphVideoPrompt ?? "").trim()
  );
}

/** The video nodes to draw: the shot's list when it has one, else a single
 *  `vid0` synthesized from the legacy flat fields (pre-migration shots).
 *  Shared with the renderer so its canvas derivation matches the materializer. */
export function videoNodesFor(shot: ProductionShot): GraphVideoNode[] {
  if (Array.isArray(shot.graphVideoNodes)) return shot.graphVideoNodes;
  if (!videoPairActive(shot)) return [];
  const node: GraphVideoNode = { id: "vid0", prompt: shot.graphVideoPrompt ?? "" };
  if (shot.graphVideoGens?.length) node.gens = shot.graphVideoGens;
  if (shot.graphVideoGenIndex !== undefined) node.genIndex = shot.graphVideoGenIndex;
  if (shot.graphVideoModel) node.model = shot.graphVideoModel;
  if (shot.graphVideoResolution) node.resolution = shot.graphVideoResolution;
  if (shot.graphVideoDurationSec !== undefined) node.durationSec = shot.graphVideoDurationSec;
  if (shot.graphVideoParams) node.params = shot.graphVideoParams;
  if (shot.graphImageToVideo) node.source = { kind: "imagegen" };
  else if (shot.graphEditToVideo) node.source = { kind: "editgen", nodeId: shot.graphVideoSourceEditNodeId ?? "edit0" };
  else if (shot.graphVideoSourceRefId) node.source = { kind: "ref", refId: shot.graphVideoSourceRefId };
  if (shot.graphVideoStyleConnected) node.styleConnected = true;
  return [node];
}

/** Mirror of NodeGraphModal's tweenActive. */
export function tweenActive(shot: ProductionShot): boolean {
  return !!(
    (shot.graphTweenRefIds?.length ?? 0) > 0 ||
    (shot.graphTweenBlocks?.length ?? 0) > 0 ||
    shot.graphTweenOutput ||
    shot.graphOutputSource === "tween"
  );
}

/** Mirror of NodeGraphModal's editVideoActive. */
export function editVideoActive(shot: ProductionShot): boolean {
  return !!(
    (shot.graphEditVideoGens?.length ?? 0) > 0 ||
    (shot.graphEditVideoPrompt ?? "").trim() ||
    shot.graphEditVideoSourceRefId ||
    shot.graphVideoToEditVideo ||
    shot.graphEditVideoParams ||
    shot.graphOutputSource === "editvideo"
  );
}

/**
 * Convert a shot's legacy wiring into a stored Graph. Reads flags, prompt
 * tags/paragraphs, and layout positions (a saved position implies a placed
 * node, mirroring the canvas). Never throws on missing data — unknown refs
 * become `ref:missing-N` nodes exactly as the canvas draws them.
 */
export function materializeGraph(shot: ProductionShot, refs: GraphRefView[]): Graph {
  const byName = new Map(refs.map((r) => [r.name.toLowerCase(), r]));
  const refIds = new Set(refs.map((r) => r.id));
  const prompt = shot.prompt ?? "";
  const videoNodes = videoNodesFor(shot);
  const editVideoPrompt = shot.graphEditVideoPrompt ?? "";
  const editNodes = shot.graphEditNodes ?? [];
  const positions = shot.graphLayout?.positions ?? {};

  const pos = (id: string): { x: number; y: number } => positions[id] ?? { ...ORIGIN };
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const edge = (id: string, fromNode: string, fromPort: string, toNode: string, toPort: string): void => {
    edges.push({ id, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } });
  };

  // Union of tags across every prompt — every cited reference gets a node.
  // (Includes edit-video tags; the canvas union omits them, which strands
  // those edges on a ghost node. The graph cannot hold dangling edges, so the
  // node is emitted and the edge stays valid.)
  const unionNames: string[] = [];
  const seenNames = new Set<string>();
  const addNames = (names: string[]): void => {
    for (const name of names) {
      const lc = name.toLowerCase();
      if (seenNames.has(lc)) continue;
      seenNames.add(lc);
      unionNames.push(name);
    }
  };
  addNames(refTagNames(prompt));
  for (const n of videoNodes) addNames(refTagNames(n.prompt ?? ""));
  for (const n of editNodes) addNames(refTagNames(n.prompt ?? ""));
  addNames(refTagNames(editVideoPrompt));

  const nodeIds = new Set<string>();
  const addNode = (id: string, kind: GraphNode["kind"], label?: string): void => {
    if (nodeIds.has(id)) return;
    nodeIds.add(id);
    nodes.push(label === undefined ? { id, kind, pos: pos(id) } : { id, kind, pos: pos(id), data: { label } });
  };

  // Reference nodes: tagged in any prompt, plus layout-placed (untagged) ones.
  unionNames.forEach((name, i) => {
    const ref = byName.get(name.toLowerCase());
    addNode(`ref:${ref?.id ?? `missing-${i}`}`, "ref", name);
  });
  for (const id of Object.keys(positions)) {
    const m = /^ref:(.+)$/.exec(id);
    if (m && refIds.has(m[1]) && !nodeIds.has(id)) {
      const ref = refs.find((r) => r.id === m[1]);
      addNode(id, "ref", ref?.name ?? m[1]);
    }
  }
  const hasRefNode = (refId: string): boolean => nodeIds.has(`ref:${refId}`);

  // Structural nodes (always on canvas).
  addNode("composer", "composer");
  addNode("style", "style");
  addNode("brand", "brand");
  addNode("output", "output");
  addNode("imagegen", "imagegen");

  // Optional pairs, from activity flags or layout placement.
  const layoutTools = new Set<string>();
  if (positions.videogen || positions.videoprompt) { layoutTools.add("videogen"); layoutTools.add("videoprompt"); }
  if (positions.tween) layoutTools.add("tween");
  if (positions.editvideo || positions.editvideoprompt) { layoutTools.add("editvideo"); layoutTools.add("editvideoprompt"); }
  const hasVideo = videoNodes.length > 0 || layoutTools.has("videogen");
  const drawVideoNodes: GraphVideoNode[] = videoNodes.length > 0 ? videoNodes : (hasVideo ? [{ id: "vid0", prompt: "" }] : []);
  const hasTween = tweenActive(shot) || layoutTools.has("tween");
  const hasEditVideo = editVideoActive(shot) || layoutTools.has("editvideo");
  if (hasVideo) {
    for (const n of drawVideoNodes) { addNode(videoPromptNodeId(n.id), "videoprompt"); addNode(videoGenNodeId(n.id), "videogen"); }
  }
  for (const n of editNodes) { addNode(editPromptId(n.id), "editprompt"); addNode(editGenId(n.id), "editgen"); }
  if (hasTween) addNode("tween", "tween");
  if (hasEditVideo) { addNode("editvideoprompt", "editvideoprompt"); addNode("editvideo", "editvideo"); }
  // The camera-grid tool is self-contained (no legacy flags): it is present
  // when it holds state or has a saved position.
  if (shot.graphCameraGrid || positions.cameraGrid) addNode("cameraGrid", "cameraGrid");
  // The upscale node is likewise self-contained: present when it holds state
  // or has a saved position.
  if (shot.graphUpscale || positions.upscale) addNode("upscale", "upscale");

  // Rebuild the camera-grid node's wiring from `graphCameraGrid` (the domain
  // state — it has no legacy flags/text projection). Without this the
  // first-open ensure pass would rebuild a graph with no camera-grid edges and
  // strip every connection the user made.
  const ensureRefNode = (refId: string): string | null => {
    const nodeId = `ref:${refId}`;
    if (nodeIds.has(nodeId)) return nodeId;
    const r = refs.find((x) => x.id === refId);
    if (!r) return null;
    addNode(nodeId, "ref", r.name);
    return nodeId;
  };
  if (shot.graphCameraGrid) {
    const grid = shot.graphCameraGrid;
    const src = grid.source;
    if (src?.kind === "imagegen") {
      edge("e-img-camgrid", "imagegen", "out", "cameraGrid", "in-image");
    } else if (src?.kind === "editgen" && editNodes.some((n) => n.id === src.nodeId)) {
      edge("e-edit-camgrid", editGenId(src.nodeId), "out", "cameraGrid", "in-image");
    } else if (src?.kind === "ref") {
      const nodeId = ensureRefNode(src.refId);
      if (nodeId) edge("e-ref-camgrid", nodeId, "out", "cameraGrid", "in-image");
    }
    const gridSrc = grid.gridSource;
    if (gridSrc?.kind === "imagegen") {
      edge("e-img-camgrid-grid", "imagegen", "out", "cameraGrid", "in-grid");
    } else if (gridSrc?.kind === "editgen" && editNodes.some((n) => n.id === gridSrc.nodeId)) {
      edge("e-edit-camgrid-grid", editGenId(gridSrc.nodeId), "out", "cameraGrid", "in-grid");
    } else if (gridSrc?.kind === "ref") {
      const nodeId = ensureRefNode(gridSrc.refId);
      if (nodeId) edge("e-ref-camgrid-grid", nodeId, "out", "cameraGrid", "in-grid");
    }
    (grid.refIds ?? []).forEach((refId, i) => {
      const nodeId = ensureRefNode(refId);
      if (nodeId) edge(`e-${nodeId}-cameraGrid-${i}`, nodeId, "out", "cameraGrid", `in-ref-${i}`);
    });
  }

  // Rebuild the upscale node's source wire from `graphUpscale` (domain state,
  // no legacy flags) — otherwise the first-open ensure pass strips it.
  if (shot.graphUpscale) {
    const src = shot.graphUpscale.source;
    if (src?.kind === "imagegen") {
      edge("e-img-upscale", "imagegen", "out", "upscale", "in-image");
    } else if (src?.kind === "editgen" && editNodes.some((n) => n.id === src.nodeId)) {
      edge("e-edit-upscale", editGenId(src.nodeId), "out", "upscale", "in-image");
    } else if (src?.kind === "ref") {
      const nodeId = ensureRefNode(src.refId);
      if (nodeId) edge("e-ref-upscale", nodeId, "out", "upscale", "in-image");
    }
  }

  // Reference → prompt edges, in each prompt's tag order (socket index = order).
  const tagNodeId = (name: string): string => {
    const idx = unionNames.findIndex((n) => n.toLowerCase() === name.toLowerCase());
    const ref = byName.get(name.toLowerCase());
    return `ref:${ref?.id ?? `missing-${idx}`}`;
  };
  const refEdges = (names: string[], target: string): void => {
    names.forEach((name, i) => {
      const refNodeId = tagNodeId(name);
      edge(`e-${refNodeId}-${target === "composer" ? "composer" : target}-${i}`, refNodeId, "out", target, `in-ref-${i}`);
    });
  };
  refEdges(refTagNames(prompt), "composer");
  for (const n of drawVideoNodes) refEdges(refTagNames(n.prompt ?? ""), videoPromptNodeId(n.id));
  for (const n of editNodes) refEdges(refTagNames(n.prompt ?? ""), editPromptId(n.id));
  if (hasEditVideo) refEdges(refTagNames(editVideoPrompt), "editvideoprompt");

  // Style / brand plugs (flag wins, prompt paragraph is the fallback).
  // Mirroring: an explicit style selection is always wired (None never is),
  // so a shot whose sidepanel shows a style materializes with the style edge.
  const composerStyleSelected = !shot.styleNone && !!shot.style;
  if (shot.styleNone ? false : (composerStyleSelected || (shot.graphStyleConnected ?? hasStyleLine(prompt)))) edge("e-style", "style", "out", "composer", "in-style");
  for (const n of drawVideoNodes) {
    const target = videoPromptNodeId(n.id);
    if (n.styleConnected ?? hasStyleLine(n.prompt ?? "")) edge(videoEdgeId("e-style-vp", n.id), "style", "out", target, "in-style");
    if (hasBrandParagraph(n.prompt ?? "")) edge(videoEdgeId("e-brand-vp", n.id), "brand", "out", target, "in-brand");
  }
  if (hasEditVideo && hasStyleLine(editVideoPrompt)) edge("e-style-evp", "style", "out", "editvideoprompt", "in-style");
  if (hasBrandParagraph(prompt)) edge("e-brand", "brand", "out", "composer", "in-brand");
  if (hasEditVideo && hasBrandParagraph(editVideoPrompt)) edge("e-brand-evp", "brand", "out", "editvideoprompt", "in-brand");
  for (const n of editNodes) {
    if (n.styleConnected ?? hasStyleLine(n.prompt ?? "")) edge(`e-style-ep:${n.id}`, "style", "out", editPromptId(n.id), "in-style");
    if (hasBrandParagraph(n.prompt ?? "")) edge(`e-brand-ep:${n.id}`, "brand", "out", editPromptId(n.id), "in-brand");
  }

  // Fixed prompt pipes.
  edge("e-cmp-img", "composer", "out", "imagegen", "in-prompt");
  for (const n of drawVideoNodes) edge(videoEdgeId("e-vp-vid", n.id), videoPromptNodeId(n.id), "out", videoGenNodeId(n.id), "in-prompt");
  if (hasEditVideo) edge("e-evp-ev", "editvideoprompt", "out", "editvideo", "in-prompt");
  for (const n of editNodes) edge(`e-ep-edit:${n.id}`, editPromptId(n.id), "out", editGenId(n.id), "in-prompt");

  // Video / edit-video source wires.
  for (const n of drawVideoNodes) {
    const gen = videoGenNodeId(n.id);
    const src = n.source;
    if (src?.kind === "imagegen") edge(videoEdgeId("e-img-vid", n.id), "imagegen", "out", gen, "in-image");
    else if (src?.kind === "editgen" && editNodes.some((p) => p.id === src.nodeId)) edge(videoEdgeId("e-edit-vid", n.id), editGenId(src.nodeId), "out", gen, "in-image");
    else if (src?.kind === "ref" && hasRefNode(src.refId)) edge(videoEdgeId("e-ref-vid", n.id), `ref:${src.refId}`, "out", gen, "in-image");
  }
  if (hasEditVideo && shot.graphVideoToEditVideo && hasVideo && drawVideoNodes[0]) edge("e-vid-ev", videoGenNodeId(drawVideoNodes[0].id), "out", "editvideo", "in-video");
  if (hasEditVideo && shot.graphEditVideoSourceRefId && hasRefNode(shot.graphEditVideoSourceRefId)) {
    edge("e-ref-ev", `ref:${shot.graphEditVideoSourceRefId}`, "out", "editvideo", "in-video");
  }

  // Edit-node source pipes.
  for (const n of editNodes) {
    const src = n.source;
    if (src?.kind === "imagegen") edge(`e-img-edit:${n.id}`, "imagegen", "out", editGenId(n.id), "in-image");
    else if (src?.kind === "editgen" && editNodes.some((p) => p.id === src.nodeId)) {
      edge(`e-edit-edit:${n.id}`, editGenId(src.nodeId), "out", editGenId(n.id), "in-image");
    } else if (src?.kind === "ref" && hasRefNode(src.refId)) {
      edge(`e-ref-edit:${n.id}`, `ref:${src.refId}`, "out", editGenId(n.id), "in-image");
    }
  }

  // Tween keyframes, in timeline order (socket index = order). Resolution is
  // shared with live keyframe connects (tweenKeyToNode) so both agree.
  // (Emitted before the output feed, mirroring the canvas derivation order.)
  const editIds = new Set(editNodes.map((n) => n.id));
  const refNodeIds = new Set([...nodeIds].filter((id) => id.startsWith("ref:")));
  (shot.graphTweenRefIds ?? []).forEach((srcId, i) => {
    const nodeId = tweenKeyToNode(srcId, editIds, refNodeIds);
    if (nodeId) edge(`e-tween-${i}`, nodeId, "out", "tween", `in-tween-${i}`);
  });

  // Output feed.
  if (shot.graphOutputSource === "imagegen") edge("e-img-out", "imagegen", "out", "output", "in-out");
  if (shot.graphOutputSource === "videogen" && hasVideo) {
    const outId = (shot.graphOutputVideoNodeId && drawVideoNodes.some((n) => n.id === shot.graphOutputVideoNodeId))
      ? shot.graphOutputVideoNodeId
      : drawVideoNodes[0]?.id;
    if (outId) edge(videoEdgeId("e-vid-out", outId), videoGenNodeId(outId), "out", "output", "in-out");
  }
  if (shot.graphOutputSource === "tween" && hasTween) edge("e-tween-out", "tween", "out", "output", "in-out");
  if (shot.graphOutputSource === "upscale" && shot.graphUpscale) edge("e-upscale-out", "upscale", "out", "output", "in-out");
  if (shot.graphOutputSource === "editgen" && shot.graphOutputEditNodeId && editNodes.some((n) => n.id === shot.graphOutputEditNodeId)) {
    edge("e-edit-out", editGenId(shot.graphOutputEditNodeId), "out", "output", "in-out");
  }
  // No canvas equivalent: the edit-video output wire was never drawn (the
  // output node shows the bound clip, but no edge). The graph records it.
  if (shot.graphOutputSource === "editvideo" && hasEditVideo) edge("e-editvideo-out", "editvideo", "out", "output", "in-out");
  if (shot.graphOutputSource === "ref" && shot.graphOutputRefId && hasRefNode(shot.graphOutputRefId)) {
    edge("e-ref-out", `ref:${shot.graphOutputRefId}`, "out", "output", "in-out");
  }

  return { version: 1, nodes, edges };
}
