import { describe, it, expect } from "vitest";
import { EDGE_MEDIA_STYLES, edgeMediaKind, edgeMediaStyle } from "../src/shared/graph/edge-style.js";
import { graphEdgesToFlow } from "../src/renderer/src/components/graphFlow.js";
import { materializeGraph } from "../src/shared/graph/materialize.js";

describe("edge media styles", () => {
  it("image, video, and other are pairwise distinct in color and line style", () => {
    expect(edgeMediaKind("image")).toBe("image");
    expect(edgeMediaKind("video")).toBe("video");
    expect(edgeMediaKind("text")).toBe("other");
    expect(edgeMediaKind("audio")).toBe("other");
    expect(edgeMediaKind(undefined)).toBe("other");
    const styles = [EDGE_MEDIA_STYLES.image, EDGE_MEDIA_STYLES.video, EDGE_MEDIA_STYLES.other];
    expect(new Set(styles.map((s) => s.stroke)).size).toBe(3);
    expect(new Set(styles.map((s) => s.strokeDasharray ?? "solid")).size).toBe(3);
    expect(edgeMediaStyle(undefined)).toEqual(EDGE_MEDIA_STYLES.other);
  });

  it("flow edges carry the media style of their source (refs resolve by ref media)", () => {
    const g = materializeGraph(
      {
        id: "s1", number: "0100", audio: "", visual: "",
        prompt: "Scene @[Clip]",
        graphOutputSource: "imagegen",
      } as never,
      [{ id: "r1", name: "Clip", artwork: "c.png", media: "video" }]
    );
    const flow = graphEdgesToFlow(g, {
      selected: new Set(),
      colors: { ref: "#111", style: "#a51", brand: "#b52" },
      refMediaByNode: { "ref:r1": "video" },
    });
    const refEdge = flow.find((e) => e.source === "ref:r1")!;
    expect(refEdge.style).toMatchObject(EDGE_MEDIA_STYLES.video);
    const outEdge = flow.find((e) => e.target === "output")!;
    expect(outEdge.style).toMatchObject(EDGE_MEDIA_STYLES.image);
  });

  it("style and brand control plugs keep their socket colors", () => {
    const g = materializeGraph(
      { id: "s1", number: "0100", audio: "", visual: "", prompt: "Scene", styles: undefined } as never,
      []
    );
    const flow = graphEdgesToFlow(g, {
      selected: new Set(),
      colors: { ref: "#111", style: "#a51", brand: "#b52" },
    });
    const styleEdge = flow.find((e) => e.source === "style");
    if (styleEdge) expect(styleEdge.style).toEqual({ stroke: "#a51" });
  });
});
