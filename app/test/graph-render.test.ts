/**
 * renderPrompt tests (master plan step 04 T3/T4): the fixed component order,
 * identical sections across consumers, update propagation from one library
 * edit, byte-identity with legacy composition, and explicit detached
 * overrides rendering verbatim.
 */
import { describe, it, expect } from "vitest";
import {
  brandEdgePresent,
  isBrandAttached,
  isStyleAttached,
  promptRefsFor,
  renderPromptText,
  renderShotPrompt,
  resolveNodeStyleText,
  stripSharedSections,
  styleEdgePresent,
} from "../src/shared/graph/render.js";
import { materializeGraph } from "../src/shared/graph/materialize.js";
import { applyConnection, connectionToEdge, setBrandEdge } from "../src/shared/graph/connect.js";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

const STYLES = [
  { id: "s1", index: 1, name: "Heroic", prompt: "Heroic 3D render" },
  { id: "s2", index: 2, name: "Noir", prompt: "Noir photo" },
];

const prod = (over: Partial<Production> = {}): Production =>
  ({
    meta: { id: "p1", name: "P", folder: "C:/x", createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    currentStep: 3,
    styles: STYLES,
    brand: { colors: ["#aabbcc"], font: "Baskerville" },
    characters: [],
    products: [],
    references: [],
    ...over,
  }) as unknown as Production;

const shot = (over: Partial<ProductionShot> = {}): ProductionShot =>
  ({ id: "s1", number: "0100", audio: "", visual: "", ...over }) as ProductionShot;

/** Attach style+brand edges the way the canvas does (materialize from flags). */
function graphed(s: ProductionShot): ProductionShot {
  const g = materializeGraph(s, []);
  return { ...s, graph: g };
}

describe("component order (Style, Brand, Content, References)", () => {
  it("renders Style → Brand → Content with tags inline", () => {
    const out = renderPromptText("Hold @[Gondola]", {
      styleAttached: true,
      styleText: "Heroic 3D render",
      brandAttached: true,
      brand: "Color palette: #aabbcc. Font: Baskerville.",
    });
    expect(out).toBe(
      "Style: Heroic 3D render\n\nBrand identity: Color palette: #aabbcc. Font: Baskerville.\n\nHold @[Gondola]"
    );
  });

  it("omits empty sections without blank gaps", () => {
    expect(renderPromptText("Action.", { styleAttached: false, styleText: "", brandAttached: false, brand: "" })).toBe("Action.");
    expect(renderPromptText("Action.", { styleAttached: true, styleText: "", brandAttached: false, brand: "" })).toBe("Action.");
  });
});

describe("renderShotPrompt over edges", () => {
  it("two consumers of one style node render identical style sections", () => {
    const p = prod();
    const a = graphed(shot({ prompt: "Style: Heroic 3D render\n\nAlpha", graphStyleConnected: true }));
    const b = graphed(shot({ prompt: "Style: Heroic 3D render\n\nBeta", graphStyleConnected: true }));
    const ra = renderShotPrompt(p, a, "composer");
    const rb = renderShotPrompt(p, b, "composer");
    expect(ra).toBe("Style: Heroic 3D render\n\nAlpha");
    expect(rb).toBe("Style: Heroic 3D render\n\nBeta");
    expect(ra.split("\n\n")[0]).toBe(rb.split("\n\n")[0]);
  });

  it("editing the library entry re-renders every consumer, touching none", () => {
    const p = prod();
    const before = graphed(shot({ prompt: "Style: Heroic 3D render\n\nAlpha", graphStyleConnected: true }));
    expect(renderShotPrompt(p, before, "composer")).toContain("Style: Heroic 3D render");
    const edited = prod({ styles: [{ id: "s1", index: 1, name: "Heroic", prompt: "Epic claymation" }] });
    // Consumer storage untouched — same object identity for items.
    expect(renderShotPrompt(edited, before, "composer")).toBe("Style: Epic claymation\n\nAlpha");
    expect(before.prompt).toBe("Style: Heroic 3D render\n\nAlpha");
  });

  it("every consumer (composer, video, edit) renders the same style section", () => {
    const p = prod();
    const s = graphed(shot({
      prompt: "Alpha",
      graphStyleConnected: true,
      graphVideoPrompt: "Beta",
      graphVideoStyleConnected: true,
      graphEditNodes: [{ id: "edit0", prompt: "Gamma", styleConnected: true }],
    }));
    const styleOf = (txt: string) => txt.split("\n\n")[0];
    const a = renderShotPrompt(p, s, "composer");
    const b = renderShotPrompt(p, s, "videoprompt");
    const c = renderShotPrompt(p, s, { editprompt: "edit0" });
    expect(a).toBe("Style: Heroic 3D render\n\nAlpha");
    expect(b).toBe("Style: Heroic 3D render\n\nBeta");
    expect(c).toBe("Style: Heroic 3D render\n\nGamma");
    expect(styleOf(b)).toBe(styleOf(a));
    expect(styleOf(c)).toBe(styleOf(a));
    // One library edit reaches all three.
    const p2 = prod({ styles: [{ id: "s1", index: 1, name: "Heroic", prompt: "Shared v2" }] });
    for (const t of [a, b, c]) expect(renderShotPrompt(p2, s, t === a ? "composer" : t === b ? "videoprompt" : { editprompt: "edit0" })).toContain("Style: Shared v2");
  });

  it("byte-identical to legacy composition for a style fixture", () => {
    // Legacy stored text as the connect path wrote it (addStyleParagraph):
    // style first, content after — the required order agrees, so the
    // reference model round-trips byte-for-byte. (Brand normalizes from
    // legacy-last to required-middle; covered by the order test above.)
    const legacy = "Style: Heroic 3D render\n\nHold @[Gondola]";
    const s = graphed(shot({ prompt: legacy, graphStyleConnected: true }));
    expect(renderShotPrompt(prod(), s, "composer")).toBe(legacy);
  });

  it("rendering is idempotent (fixed point)", () => {
    const s = graphed(shot({ prompt: "Style: Heroic 3D render\n\nAlpha @[G]\n\nBrand identity: auto", graphStyleConnected: true, includeBrandIdentity: true }));
    const once = renderShotPrompt(prod(), s, "composer");
    const twice = renderPromptText(once, promptRefsFor(prod(), { ...s, prompt: once }, "composer"));
    expect(twice).toBe(once);
  });
});

describe("detached overrides render verbatim", () => {
  it("unplugged custom prose (even Style:-looking) survives", () => {
    const custom = "Style: my own weird words\n\nDo the thing";
    const s = graphed(shot({ prompt: custom, graphStyleConnected: false }));
    expect(styleEdgePresent(s.graph!, "composer")).toBe(false);
    expect(renderShotPrompt(prod(), s, "composer")).toBe(custom);
  });

  it("brand paragraph presence is the plug (legacy rule preserved)", () => {
    // No brand flag exists: a Brand identity: paragraph IS the attachment.
    const s = graphed(shot({ prompt: "Action.\n\nBrand identity: something custom" }));
    expect(brandEdgePresent(s.graph!, "composer")).toBe(true);
    expect(renderShotPrompt(prod(), s, "composer")).toBe(
      "Brand identity: Color palette: #aabbcc. Font: Baskerville.\n\nAction."
    );
  });
});

describe("legacy fallback without a graph", () => {
  it("flag-then-paragraph rule preserved pre-migration", () => {
    expect(isStyleAttached(shot({ graphStyleConnected: true }), "composer", "")).toBe(true);
    expect(isStyleAttached(shot({ graphStyleConnected: false }), "composer", "Style: x")).toBe(false);
    expect(isStyleAttached(shot({}), "composer", "Style: x")).toBe(true);
    expect(isBrandAttached(shot({ includeBrandIdentity: true }), "composer", "")).toBe(true);
    expect(isBrandAttached(shot({}), "composer", "")).toBe(false);
    expect(resolveNodeStyleText(prod(), shot({}))).toBe("Heroic 3D render");
    expect(resolveNodeStyleText(prod(), shot({ styleNone: true }))).toBe("");
  });
});

describe("stripSharedSections", () => {
  it("drops shared sections, keeps content and tags", () => {
    expect(stripSharedSections("Style: X\n\nHold @[G]\n\nBrand identity: auto")).toBe("Hold @[G]");
    expect(stripSharedSections("Just content")).toBe("Just content");
  });
});

describe("with a graph, attachment is the edge — never the prompt text (step 05)", () => {
  it("a Style paragraph does NOT attach when the edge is absent", () => {
    const s = graphed(shot({ prompt: "Style: legacy prose\n\nAction", graphStyleConnected: false }));
    expect(isStyleAttached(s, "composer", s.prompt ?? "")).toBe(false);
    expect(renderShotPrompt(prod(), s, "composer")).toBe("Style: legacy prose\n\nAction");
  });

  it("the edge attaches even with no paragraph in the text", () => {
    const base = shot({ prompt: "Action", graphStyleConnected: true });
    const g = materializeGraph(base, []);
    const s = { ...base, graph: setBrandEdge(g, "composer", true) };
    expect(styleEdgePresent(s.graph!, "composer")).toBe(true);
    expect(brandEdgePresent(s.graph!, "composer")).toBe(true);
    expect(renderShotPrompt(prod(), s, "composer")).toBe(
      "Style: Heroic 3D render\n\nBrand identity: Color palette: #aabbcc. Font: Baskerville.\n\nAction"
    );
  });
});

describe("reference tags are emitted from the graph edges (step 05 T2)", () => {
  const withRef = prod({ characters: [{ id: "c1", name: "Gondola", key: "g" }] });

  it("adding a reference edge adds its tag and nothing else", () => {
    const base = shot({ prompt: "Alpha", graphStyleConnected: true });
    const g0 = materializeGraph(base, [{ id: "c1", name: "Gondola" }]);
    const op = connectionToEdge({ source: "ref:c1", target: "composer", targetHandle: "in-ref-open" }, g0);
    expect(op).not.toBeNull();
    const s = { ...base, graph: applyConnection(g0, op!) };
    expect(renderShotPrompt(withRef, s, "composer")).toBe("Style: Heroic 3D render\n\nAlpha\n\n@[Gondola]");
  });

  it("removing a reference edge removes its tag and nothing else", () => {
    const base = shot({ prompt: "Alpha", graphStyleConnected: true });
    const g0 = materializeGraph(base, [{ id: "c1", name: "Gondola" }]);
    const connected = applyConnection(g0, connectionToEdge({ source: "ref:c1", target: "composer", targetHandle: "in-ref-open" }, g0)!);
    const detached = { ...connected, edges: connected.edges.filter((e) => !e.from.node.startsWith("ref:")) };
    const s = { ...base, graph: detached };
    // The stored content still cites the tag; the edge is now the authority.
    expect(renderShotPrompt(withRef, s, "composer")).toBe("Style: Heroic 3D render\n\nAlpha");
  });

  it("a dangling tag with no matching reference is prose and stays", () => {
    const base = shot({ prompt: "Alpha @[Unmatched]", graphStyleConnected: false });
    const s = { ...base, graph: materializeGraph(base, []) };
    expect(renderShotPrompt(withRef, s, "composer")).toBe("Alpha @[Unmatched]");
  });
});
