/**
 * Port table + canConnect + normalizeGraph tests (master plan step 03 T2).
 * Every media pair the table governs has a case: image→image yes, video→image
 * no, text→prompt yes, audio excluded from outputs, style/brand kind-gated.
 */
import { describe, it, expect } from "vitest";
import {
  canConnect,
  nodeDecl,
  portDecl,
  refOutputMedia,
  type ConnectEndpoint,
} from "../src/shared/graph/ports.js";
import { normalizeGraph } from "../src/shared/graph/normalize.js";
import type { Graph, GraphMedia, GraphNodeKind } from "../src/shared/ipc.js";

const ep = (kind: GraphNodeKind, port: string, media: GraphMedia): ConnectEndpoint => ({ kind, port, media });
const to = (kind: GraphNodeKind, port: string) => ({ kind, port });

describe("port table", () => {
  it("declares every node kind with typed ports", () => {
    const kinds: GraphNodeKind[] = ["composer", "style", "brand", "imagegen", "videogen", "editgen", "editvideo", "tween", "ref", "output", "videoprompt", "editprompt", "editvideoprompt"];
    for (const k of kinds) {
      const d = nodeDecl(k);
      expect(d, k).toBeDefined();
      expect(d!.inputs.length + d!.outputs.length).toBeGreaterThan(0);
    }
  });

  it("expands positional sockets (in-ref-N, in-tween-N)", () => {
    expect(portDecl("composer", "in", "in-ref-3")?.id).toBe("in-ref-open");
    expect(portDecl("composer", "in", "in-ref-open")?.id).toBe("in-ref-open");
    expect(portDecl("tween", "in", "in-tween-4")?.id).toBe("in-tween-4");
    expect(portDecl("composer", "in", "in-tween-0")).toBeUndefined();
    expect(portDecl("composer", "in", "nope")).toBeUndefined();
  });
});

describe("refOutputMedia", () => {
  it("defaults to image; honors dropped video/audio", () => {
    expect(refOutputMedia(undefined)).toBe("image");
    expect(refOutputMedia({ id: "r", artwork: "a.png" })).toBe("image");
    expect(refOutputMedia({ id: "r", media: "video" })).toBe("video");
    expect(refOutputMedia({ id: "r", media: "audio" })).toBe("audio");
  });
});

describe("canConnect", () => {
  // Fixed prompt pipes: text flows prompt→generator, kind-gated.
  it("composer→imagegen:in-prompt yes; cross prompt pipes no", () => {
    expect(canConnect(ep("composer", "out", "text"), to("imagegen", "in-prompt"))).toBe(true);
    expect(canConnect(ep("videoprompt", "out", "text"), to("videogen", "in-prompt"))).toBe(true);
    expect(canConnect(ep("composer", "out", "text"), to("videogen", "in-prompt"))).toBe(false);
    expect(canConnect(ep("videoprompt", "out", "text"), to("imagegen", "in-prompt"))).toBe(false);
  });

  it("style→in-style yes; brand→in-style and text→in-style no", () => {
    expect(canConnect(ep("style", "out", "text"), to("composer", "in-style"))).toBe(true);
    expect(canConnect(ep("brand", "out", "text"), to("composer", "in-style"))).toBe(false);
    expect(canConnect(ep("composer", "out", "text"), to("composer", "in-style"))).toBe(false);
    expect(canConnect(ep("brand", "out", "text"), to("videoprompt", "in-brand"))).toBe(true);
    expect(canConnect(ep("style", "out", "text"), to("videoprompt", "in-brand"))).toBe(false);
  });

  // Image outputs feed all image inputs.
  it("image→image yes (video source, edit source, output, tween)", () => {
    expect(canConnect(ep("imagegen", "out", "image"), to("videogen", "in-image"))).toBe(true);
    expect(canConnect(ep("editgen", "out", "image"), to("videogen", "in-image"))).toBe(true);
    expect(canConnect(ep("imagegen", "out", "image"), to("editgen", "in-image"))).toBe(true);
    expect(canConnect(ep("editgen", "out", "image"), to("output", "in-out"))).toBe(true);
    expect(canConnect(ep("imagegen", "out", "image"), to("tween", "in-tween-2"))).toBe(true);
    expect(canConnect(ep("ref", "out", "image"), to("tween", "in-tween-0"))).toBe(true);
  });

  it("video→video yes (output, edit-video source)", () => {
    expect(canConnect(ep("videogen", "out", "video"), to("output", "in-out"))).toBe(true);
    expect(canConnect(ep("tween", "out", "video"), to("output", "in-out"))).toBe(true);
    expect(canConnect(ep("editvideo", "out", "video"), to("output", "in-out"))).toBe(true);
    expect(canConnect(ep("videogen", "out", "video"), to("editvideo", "in-video"))).toBe(true);
    expect(canConnect(ep("ref", "out", "video"), to("editvideo", "in-video"))).toBe(true);
  });

  it("video→image inputs no; image→video-only sinks no", () => {
    expect(canConnect(ep("videogen", "out", "video"), to("videogen", "in-image"))).toBe(false);
    expect(canConnect(ep("videogen", "out", "video"), to("editgen", "in-image"))).toBe(false);
    expect(canConnect(ep("videogen", "out", "video"), to("tween", "in-tween-0"))).toBe(false);
    expect(canConnect(ep("imagegen", "out", "image"), to("editvideo", "in-video"))).toBe(false);
    expect(canConnect(ep("ref", "out", "image"), to("editvideo", "in-video"))).toBe(false);
  });

  it("audio is excluded from outputs and image sinks, allowed on prompt refs", () => {
    expect(canConnect(ep("ref", "out", "audio"), to("output", "in-out"))).toBe(false);
    expect(canConnect(ep("ref", "out", "audio"), to("videogen", "in-image"))).toBe(false);
    expect(canConnect(ep("ref", "out", "audio"), to("tween", "in-tween-0"))).toBe(false);
    expect(canConnect(ep("ref", "out", "audio"), to("composer", "in-ref-open"))).toBe(true);
    expect(canConnect(ep("ref", "out", "video"), to("composer", "in-ref-1"))).toBe(true);
  });

  it("rejects unknown kinds/ports without throwing", () => {
    expect(canConnect(ep("composer", "out", "text"), to("imagegen", "nope"))).toBe(false);
    expect(canConnect(ep("composer", "out", "text"), to("output", "in-out"))).toBe(false);
    expect(canConnect(ep("composer", "out", "text"), to("composer", "out"))).toBe(false);
    expect(canConnect(ep("style", "out", "text"), to("output", "in-out"))).toBe(false);
  });
});

describe("normalizeGraph", () => {
  const node = (id: string, kind: Graph["nodes"][number]["kind"]) => ({ id, kind, pos: { x: 0, y: 0 } });

  it("drops dangling edges, duplicates, self-loops, and undeclared ports", () => {
    const g: Graph = {
      version: 1,
      nodes: [node("composer", "composer"), node("imagegen", "imagegen"), node("composer", "composer")],
      edges: [
        { id: "ok", from: { node: "composer", port: "out" }, to: { node: "imagegen", port: "in-prompt" } },
        { id: "dup", from: { node: "composer", port: "out" }, to: { node: "imagegen", port: "in-prompt" } },
        { id: "dangle", from: { node: "composer", port: "out" }, to: { node: "ghost", port: "in-prompt" } },
        { id: "self", from: { node: "composer", port: "out" }, to: { node: "composer", port: "in-ref-open" } },
        { id: "badport", from: { node: "composer", port: "out" }, to: { node: "imagegen", port: "nope" } },
      ],
    };
    const { graph, issues } = normalizeGraph(g);
    expect(graph.nodes.map((n) => n.id)).toEqual(["composer", "imagegen"]);
    expect(graph.edges.map((e) => e.id)).toEqual(["ok"]);
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps a valid graph stable (idempotent)", () => {
    const g: Graph = {
      version: 1,
      migrated: true,
      nodes: [node("composer", "composer"), node("imagegen", "imagegen")],
      edges: [{ id: "e", from: { node: "composer", port: "out" }, to: { node: "imagegen", port: "in-prompt" } }],
    };
    const once = normalizeGraph(g);
    expect(once.issues).toEqual([]);
    expect(normalizeGraph(once.graph).graph).toEqual(once.graph);
  });
});
