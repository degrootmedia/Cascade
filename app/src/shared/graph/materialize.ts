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
import type { Graph, GraphEdge, GraphNode, ProductionShot } from "../ipc.js";
import { hasBrandParagraph, refTagNames } from "../prompt-grammar.js";
import { tweenKeyToNode } from "./connect.js";

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
    (shot.graphVideoGens?.length ?? 0) > 0 ||
    (shot.graphVideoRefIds?.length ?? 0) > 0 ||
    shot.graphImageToVideo ||
    shot.graphEditToVideo ||
    shot.graphVideoSourceRefId ||
    shot.graphOutputSource === "videogen" ||
    (shot.graphVideoPrompt ?? "").trim()
  );
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
  const videoPrompt = shot.graphVideoPrompt ?? "";
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
  addNames(refTagNames(videoPrompt));
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
  const hasVideo = videoPairActive(shot) || layoutTools.has("videogen");
  const hasTween = tweenActive(shot) || layoutTools.has("tween");
  const hasEditVideo = editVideoActive(shot) || layoutTools.has("editvideo");
  if (hasVideo) { addNode("videoprompt", "videoprompt"); addNode("videogen", "videogen"); }
  for (const n of editNodes) { addNode(editPromptId(n.id), "editprompt"); addNode(editGenId(n.id), "editgen"); }
  if (hasTween) addNode("tween", "tween");
  if (hasEditVideo) { addNode("editvideoprompt", "editvideoprompt"); addNode("editvideo", "editvideo"); }

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
  if (hasVideo) refEdges(refTagNames(videoPrompt), "videoprompt");
  for (const n of editNodes) refEdges(refTagNames(n.prompt ?? ""), editPromptId(n.id));
  if (hasEditVideo) refEdges(refTagNames(editVideoPrompt), "editvideoprompt");

  // Style / brand plugs (flag wins, prompt paragraph is the fallback).
  if (shot.graphStyleConnected ?? hasStyleLine(prompt)) edge("e-style", "style", "out", "composer", "in-style");
  if (hasVideo && (shot.graphVideoStyleConnected ?? hasStyleLine(videoPrompt))) {
    edge("e-style-vp", "style", "out", "videoprompt", "in-style");
  }
  if (hasEditVideo && hasStyleLine(editVideoPrompt)) edge("e-style-evp", "style", "out", "editvideoprompt", "in-style");
  if (hasBrandParagraph(prompt)) edge("e-brand", "brand", "out", "composer", "in-brand");
  if (hasVideo && hasBrandParagraph(videoPrompt)) edge("e-brand-vp", "brand", "out", "videoprompt", "in-brand");
  if (hasEditVideo && hasBrandParagraph(editVideoPrompt)) edge("e-brand-evp", "brand", "out", "editvideoprompt", "in-brand");
  for (const n of editNodes) {
    if (n.styleConnected ?? hasStyleLine(n.prompt ?? "")) edge(`e-style-ep:${n.id}`, "style", "out", editPromptId(n.id), "in-style");
    if (hasBrandParagraph(n.prompt ?? "")) edge(`e-brand-ep:${n.id}`, "brand", "out", editPromptId(n.id), "in-brand");
  }

  // Fixed prompt pipes.
  edge("e-cmp-img", "composer", "out", "imagegen", "in-prompt");
  if (hasVideo) edge("e-vp-vid", "videoprompt", "out", "videogen", "in-prompt");
  if (hasEditVideo) edge("e-evp-ev", "editvideoprompt", "out", "editvideo", "in-prompt");
  for (const n of editNodes) edge(`e-ep-edit:${n.id}`, editPromptId(n.id), "out", editGenId(n.id), "in-prompt");

  // Video / edit-video source wires.
  if (hasVideo && shot.graphImageToVideo) edge("e-img-vid", "imagegen", "out", "videogen", "in-image");
  if (hasVideo && shot.graphEditToVideo && shot.graphVideoSourceEditNodeId && editNodes.some((n) => n.id === shot.graphVideoSourceEditNodeId)) {
    edge("e-edit-vid", editGenId(shot.graphVideoSourceEditNodeId), "out", "videogen", "in-image");
  }
  if (hasVideo && shot.graphVideoSourceRefId && hasRefNode(shot.graphVideoSourceRefId)) {
    edge("e-ref-vid", `ref:${shot.graphVideoSourceRefId}`, "out", "videogen", "in-image");
  }
  if (hasEditVideo && shot.graphVideoToEditVideo && hasVideo) edge("e-vid-ev", "videogen", "out", "editvideo", "in-video");
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
  if (shot.graphOutputSource === "videogen" && hasVideo) edge("e-vid-out", "videogen", "out", "output", "in-out");
  if (shot.graphOutputSource === "tween" && hasTween) edge("e-tween-out", "tween", "out", "output", "in-out");
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
