/**
 * Reference-connection ↔ prompt-tag sync (node view reliability): the
 * graph wires into a prompt node's `in-ref-N` sockets and the `@[Name]`
 * tags in its prompt text are two views of one ordered list, and every
 * mutation — connect, swap onto an occupied socket, disconnect,
 * reconnect, hand-typed tag, chip reorder — must keep them identical.
 *
 * These cases drive the shared helpers exactly as NodeGraphModal does
 * (connection → edge via connectionToEdge/applyConnection or the
 * positional wire list, text via the prompt-grammar sync) and assert
 * wires and tags agree after each step.
 */
import { describe, it, expect } from "vitest";
import { addGraphNode, applyConnection, connectionToEdge, promptRefWires, promptWiresAfterConnect, reconcilePromptRefEdges, withPromptRefWires, type FlowConnection } from "../src/shared/graph/connect.js";
import { refTagNames, syncRefTags } from "../src/shared/prompt-grammar.js";
import { materializeGraph } from "../src/shared/graph/materialize.js";
import { normalizeGraph } from "../src/shared/graph/normalize.js";
import { videoPromptNodeId, type Graph, type ProductionShot } from "../src/shared/ipc.js";

const REFS = [
  { id: "ra", name: "Alpha", artwork: "a.png" },
  { id: "rb", name: "Bravo", artwork: "b.png" },
  { id: "rc", name: "Charlie", artwork: "c.png" },
];

const shot = (over: Partial<ProductionShot> = {}): ProductionShot =>
  ({ id: "s1", number: "0100", audio: "", visual: "", ...over }) as ProductionShot;

/** Composer tagged Alpha+Bravo; Charlie placed on canvas (in graph) untagged. */
function baseGraph(): Graph {
  let g = materializeGraph(shot({ prompt: "Ride @[Alpha] with @[Bravo]" }), REFS);
  g = addGraphNode(g, { id: "ref:rc", kind: "ref", pos: { x: 0, y: 0 }, data: { label: "Charlie" } });
  expect(normalizeGraph(g).issues).toEqual([]);
  return g;
}

const conn = (source: string, target: string, targetHandle?: string): FlowConnection => ({ source, target, targetHandle });

function connect(g: Graph, c: FlowConnection): Graph {
  const op = connectionToEdge(c, g);
  expect(op, `${c.source}->${c.target}:${c.targetHandle}`).not.toBeNull();
  const next = applyConnection(g, op!);
  expect(normalizeGraph(next).issues).toEqual([]);
  return next;
}

/** Source node ids wired into a prompt node's reference sockets, in socket order. */
function wiresOf(g: Graph, target = "composer"): string[] {
  return g.edges
    .filter((e) => e.to.node === target && /^in-ref-(\d+)$/.test(e.to.port))
    .sort((a, b) => Number(/^in-ref-(\d+)$/.exec(a.to.port)![1]) - Number(/^in-ref-(\d+)$/.exec(b.to.port)![1]))
    .map((e) => e.from.node);
}

describe("reconnecting an already-wired reference", () => {
  it("open-socket reconnect does not duplicate the wire", () => {
    const g = connect(baseGraph(), conn("ref:ra", "composer", "in-ref-open"));
    expect(wiresOf(g)).toEqual(["ref:ra", "ref:rb"]);
  });

  it("dropping a wired reference onto another socket moves its wire (no duplicate)", () => {
    // Bravo (socket 1) dropped onto socket 0 replaces Alpha there.
    const g = connect(baseGraph(), conn("ref:rb", "composer", "in-ref-0"));
    expect(wiresOf(g)).toEqual(["ref:rb"]);
  });
});

describe("syncRefTags makes the tag sequence match the wire list", () => {
  const KNOWN = ["Alpha", "Bravo", "Charlie"];
  it("swap: replacing the first name rewrites that tag in place", () => {
    expect(syncRefTags("Ride @[Alpha] with @[Bravo]", ["Charlie", "Bravo"], KNOWN)).toBe("Ride @[Charlie] with @[Bravo]");
  });
  it("disconnect: dropping a name removes its tag; reconnect appends it back", () => {
    const off = syncRefTags("Ride @[Alpha] with @[Bravo]", ["Alpha"], KNOWN);
    expect(refTagNames(off)).toEqual(["Alpha"]);
    const back = syncRefTags(off, ["Alpha", "Bravo"], KNOWN);
    expect(refTagNames(back)).toEqual(["Alpha", "Bravo"]);
  });
  it("reorder follows the list while tag positions stay put", () => {
    expect(syncRefTags("@[Alpha] leads, @[Bravo] follows", ["Bravo", "Alpha"], KNOWN)).toBe("@[Bravo] leads, @[Alpha] follows");
  });
  it("leaves dangling tags and prose untouched, and is identity when in sync", () => {
    const t = "Meet @[Ghost] and @[Alpha].";
    expect(syncRefTags(t, ["Alpha"], KNOWN)).toBe(t);
    expect(syncRefTags(t, [], KNOWN)).toBe("Meet @[Ghost] and .");
  });
  it("appends before a trailing Brand paragraph", () => {
    expect(syncRefTags("Action.\n\nBrand identity: #123456", ["Alpha"], KNOWN)).toBe("Action.\n\n@[Alpha]\n\nBrand identity: #123456");
  });
});

describe("withPromptRefWires rebuilds one prompt's wires from a list", () => {
  it("dedupes, adds a missing ref node so the wire cannot dangle, and is identity when unchanged", () => {
    const g0 = baseGraph();
    expect(withPromptRefWires(g0, "composer", ["ref:ra", "ref:rb"])).toBe(g0);
    const g = withPromptRefWires(g0, "composer", ["ref:rb", "ref:rb", "ref:rc"]);
    expect(promptRefWires(g, "composer")).toEqual(["ref:rb", "ref:rc"]);
    expect(normalizeGraph(g).issues).toEqual([]);
  });
});

describe("end-to-end op sequence (the modal's single-list path)", () => {
  const NAME = new Map(REFS.map((r) => [`ref:${r.id}`, r.name]));
  const KNOWN = REFS.map((r) => r.name);
  /** One modal wire mutation: graph + text both rebuilt from the new list. */
  function applyWires(state: { g: Graph; text: string }, next: string[]): { g: Graph; text: string } {
    const g = withPromptRefWires(state.g, "composer", next);
    const names = next.flatMap((s) => (NAME.has(s) ? [NAME.get(s)!] : []));
    return { g, text: syncRefTags(state.text, names, KNOWN) };
  }
  const assertSynced = (s: { g: Graph; text: string }) => {
    expect(refTagNames(s.text)).toEqual(promptRefWires(s.g, "composer").map((w) => NAME.get(w)));
    expect(normalizeGraph(s.g).issues).toEqual([]);
  };

  it("connect, swap on occupied socket, disconnect, reconnect — tags mirror wires at every step", () => {
    let s = { g: baseGraph(), text: "Ride @[Alpha] with @[Bravo]" };
    assertSynced(s);
    // Swap: Charlie dropped onto Alpha's occupied socket 0.
    s = applyWires(s, promptWiresAfterConnect(promptRefWires(s.g, "composer"), "ref:rc", 0));
    expect(promptRefWires(s.g, "composer")).toEqual(["ref:rc", "ref:rb"]);
    expect(s.text).toBe("Ride @[Charlie] with @[Bravo]");
    assertSynced(s);
    // Disconnect Charlie (drag its wire off / Delete its edge).
    s = applyWires(s, promptRefWires(s.g, "composer").filter((w) => w !== "ref:rc"));
    expect(refTagNames(s.text)).toEqual(["Bravo"]);
    assertSynced(s);
    // Reconnect Charlie on the open socket — the tag comes back.
    s = applyWires(s, promptWiresAfterConnect(promptRefWires(s.g, "composer"), "ref:rc", null));
    expect(refTagNames(s.text)).toEqual(["Bravo", "Charlie"]);
    assertSynced(s);
    // Reconnect again — no duplicate, no reorder.
    s = applyWires(s, promptWiresAfterConnect(promptRefWires(s.g, "composer"), "ref:rc", null));
    expect(promptRefWires(s.g, "composer")).toEqual(["ref:rb", "ref:rc"]);
    assertSynced(s);
    // Move Bravo onto Charlie's socket: Bravo takes the slot, cited once.
    s = applyWires(s, promptWiresAfterConnect(promptRefWires(s.g, "composer"), "ref:rb", 1));
    expect(promptRefWires(s.g, "composer")).toEqual(["ref:rb"]);
    expect(refTagNames(s.text)).toEqual(["Bravo"]);
    assertSynced(s);
  });
});

describe("video prompts: generation wires share the socket space", () => {
  const VP = videoPromptNodeId("vid0");
  function videoGraph(): Graph {
    let g = materializeGraph(
      shot({ prompt: "Base", graphVideoNodes: [{ id: "vid0", prompt: "Move @[Alpha] then @[Bravo]" }] }),
      REFS
    );
    g = addGraphNode(g, { id: "ref:rc", kind: "ref", pos: { x: 0, y: 0 }, data: { label: "Charlie" } });
    // Direct generation wire interleaved between the two tag wires.
    g = withPromptRefWires(g, VP, ["ref:ra", "imagegen", "ref:rb"]);
    expect(normalizeGraph(g).issues.join(" | ")).toBe("");
    return g;
  }

  it("swapping a ref onto the generation wire's socket replaces it, tags follow by identity not index", () => {
    const g0 = videoGraph();
    const next = promptWiresAfterConnect(promptRefWires(g0, VP), "ref:rc", 1);
    const g = withPromptRefWires(g0, VP, next);
    expect(promptRefWires(g, VP)).toEqual(["ref:ra", "ref:rc", "ref:rb"]);
    const names = next.flatMap((s) => (s.startsWith("ref:") ? [REFS.find((r) => `ref:${r.id}` === s)!.name] : []));
    expect(refTagNames(syncRefTags("Move @[Alpha] then @[Bravo]", names, REFS.map((r) => r.name)))).toEqual(["Alpha", "Charlie", "Bravo"]);
  });

  it("text reorder pours refs around the generation wire, which keeps its slot", () => {
    const g = reconcilePromptRefEdges(videoGraph(), VP, ["rb", "ra"]);
    expect(promptRefWires(g, VP)).toEqual(["ref:rb", "imagegen", "ref:ra"]);
  });
});

describe("reconcilePromptRefEdges syncs wires to text (ordered)", () => {
  it("adds a wire for a hand-typed tag of a placed reference", () => {
    const g = reconcilePromptRefEdges(baseGraph(), "composer", ["ra", "rb", "rc"]);
    expect(wiresOf(g)).toEqual(["ref:ra", "ref:rb", "ref:rc"]);
  });

  it("reorders wires when the prompt's tags are reordered", () => {
    const g = reconcilePromptRefEdges(baseGraph(), "composer", ["rb", "ra"]);
    expect(wiresOf(g)).toEqual(["ref:rb", "ref:ra"]);
  });
});
