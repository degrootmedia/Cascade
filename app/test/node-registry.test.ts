/**
 * Node-registration completeness guardrail (architecture hardening
 * workstream 1, recommendation 2 of the brief).
 *
 * A node type must be either fully registered or impossible to build. This
 * test iterates every `GraphNodeKind` (derived from the registry's
 * compile-time-exhaustive Record, not a hand-maintained list — the existing
 * 15-kind vs 13-kind drift between graph-ports.test.ts and graph-model.test.ts
 * is the bug class this kills) and fails when any registered piece is
 * missing:
 *
 *   - a ports-table row (`nodeDecl`),
 *   - a canvas node view (`graphNodeTypes`),
 *   - a reconciliation equality rule (`CANVAS_TYPE_EQUAL`),
 *   - a `nodeKindForId` resolution for every canonical canvas id,
 *   - a materializer emission (a fully-loaded fixture shot emits the kind),
 *   - a field-ownership classification for the kind's state field, and
 *   - a declared submit channel that exists in the live `ipcContract`.
 *
 * The 2026-09-24 lesson is the bug class this pins: a node added to
 * `nodeTypes` but missing its equality case fails silently (the edge is
 * written, the wire never draws).
 */
import { describe, it, expect } from "vitest";
import { NODE_KIND_REGISTRY, EXTRA_CANVAS_TYPES } from "../src/shared/graph/kinds.js";
import { CANVAS_TYPE_EQUAL } from "../src/shared/graph/reconcile.js";
import { nodeDecl } from "../src/shared/graph/ports.js";
import { nodeKindForId } from "../src/shared/graph/connect.js";
import { materializeGraph } from "../src/shared/graph/materialize.js";
import { ipcContract } from "../src/shared/ipc.js";
import { SHOT_FIELD_OWNERSHIP } from "../src/main/shot-ownership.js";
import { graphNodeTypes } from "../src/renderer/src/components/NodeGraphModal.js";
import type { GraphNodeKind, ProductionShot } from "../src/shared/ipc.js";

const ALL_KINDS = Object.keys(NODE_KIND_REGISTRY) as GraphNodeKind[];

const REFS = [
  { id: "r1", name: "Gondola", artwork: "g.png" },
  { id: "r2", name: "Marco", media: "video" as const, artwork: "m.png" },
];

/** A shot with every generator kind's domain state set, so `materializeGraph`
 *  must emit all 15 kinds. */
const FULL_SHOT = {
  id: "s1",
  number: "0100",
  audio: "",
  visual: "",
  prompt: "Hero @[Gondola]",
  graphVideoNodes: [
    { id: "vid0", prompt: "Drift @[Marco]", source: { kind: "imagegen" } },
    { id: "ev0", mode: "edit" as const, prompt: "Cut", source: { kind: "video" as const, nodeId: "vid0" } },
  ],
  graphEditNodes: [{ id: "edit0", prompt: "Fix @[Gondola]", source: { kind: "imagegen" } }],
  graphTweenRefIds: ["imagegen", "r1"],
  graphTweenBlocks: [
    { id: "tw0", startRefId: "imagegen", endRefId: "r1", prompt: "walk", startSec: 0, durationSec: 2 },
  ],
  graphCameraGrid: { cols: 4, rows: 4, source: { kind: "imagegen" }, refIds: ["r1"] },
  graphUpscale: { source: { kind: "imagegen" } },
  graphOutputSource: "videogen" as const,
  graphOutputVideoNodeId: "vid0",
} as unknown as ProductionShot;

describe("node-registration completeness", () => {
  it("every GraphNodeKind has a ports-table row", () => {
    for (const kind of ALL_KINDS) {
      const decl = nodeDecl(kind);
      expect(decl, kind).toBeDefined();
      expect(decl!.inputs.length + decl!.outputs.length, kind).toBeGreaterThan(0);
    }
  });

  it("every registered canvas type has a node view", () => {
    const types = graphNodeTypes as Record<string, unknown>;
    for (const kind of ALL_KINDS) {
      const { canvasType } = NODE_KIND_REGISTRY[kind];
      expect(types[canvasType], `${kind} → ${canvasType}`).toBeDefined();
    }
    for (const extra of EXTRA_CANVAS_TYPES) {
      expect(types[extra], extra).toBeDefined();
    }
  });

  it("every registered canvas type has a reconciliation equality rule", () => {
    for (const kind of ALL_KINDS) {
      const { canvasType } = NODE_KIND_REGISTRY[kind];
      expect(CANVAS_TYPE_EQUAL[canvasType], `${kind} → ${canvasType}`).toBeTypeOf("function");
    }
    for (const extra of EXTRA_CANVAS_TYPES) {
      expect(CANVAS_TYPE_EQUAL[extra], extra).toBeTypeOf("function");
    }
  });

  it("nodeKindForId resolves every canonical id back to its kind", () => {
    for (const kind of ALL_KINDS) {
      for (const id of NODE_KIND_REGISTRY[kind].canonicalIds) {
        expect(nodeKindForId(id), `${kind} ← ${id}`).toBe(kind);
      }
    }
  });

  it("a fully-loaded shot materializes every kind", () => {
    const g = materializeGraph(FULL_SHOT, REFS);
    const kinds = new Set(g.nodes.map((n) => n.kind));
    for (const kind of ALL_KINDS) {
      expect(kinds.has(kind), kind).toBe(true);
    }
  });

  it("every generator kind's state field is classified main- or special-owned", () => {
    for (const kind of ALL_KINDS) {
      const { stateField } = NODE_KIND_REGISTRY[kind];
      if (!stateField) continue;
      const policy = SHOT_FIELD_OWNERSHIP[stateField];
      expect(policy, `${kind} → ${stateField}`).toBeDefined();
      // Generation histories live behind a dedicated merge rule; a bare
      // "copy" would let a stale renderer save overwrite finished takes.
      expect(policy.merge, `${kind} → ${stateField}`).not.toBe("copy");
    }
  });

  it("every declared submit channel exists in the IPC contract", () => {
    const channels = Object.values(NODE_KIND_REGISTRY).flatMap((r) => r.submitChannels);
    expect(channels.length).toBeGreaterThan(0);
    for (const channel of channels) {
      expect(channel in ipcContract, channel).toBe(true);
    }
  });
});
