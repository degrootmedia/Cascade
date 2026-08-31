/**
 * Reproduction of the node-graph composer caret jump: the composer is a custom
 * React Flow node whose `data.value` is the parent's prompt, reconciled into
 * node state in an effect (one render late). This test renders the REAL
 * composer node inside React Flow and types a character into the Style box to
 * verify the caret does not jump to the end.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ReactFlow, type Node, type NodeTypes } from "@xyflow/react";
import { graphNodeTypes } from "../src/renderer/src/components/NodeGraphModal.js";

// React Flow measures nodes with ResizeObserver + DOM geometry that jsdom
// lacks — stub the observer so nodes get a size and render.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;

const INITIAL = "Style: Heroic 3D render style\n\nA hero walks through the valley.\n\nBrand identity: Color palette: #123456. Font: Helvetica.";

function FlowHarness(): ReactElement {
  const [focused, setFocused] = useState(INITIAL);
  const [nodes, setNodes] = useState<Node[]>(() => [{
    id: "composer",
    type: "composer",
    position: { x: 0, y: 0 },
    data: {
      value: INITIAL,
      refHandles: [],
      openHandleId: "in-ref-open",
      includeBrand: true,
      onChange: (v: string) => setFocused(v),
    },
  }]);
  // The real NodeGraphModal reconciles derived node data in an effect — the
  // value reaching the composer lags the parent's prompt by one render.
  useEffect(() => {
    setNodes((prev) => prev.map((n) => n.id === "composer" ? { ...n, data: { ...(n.data as object), value: focused } } : n));
  }, [focused]);
  return createElement(ReactFlow, {
    nodes,
    edges: [],
    nodeTypes: graphNodeTypes as unknown as NodeTypes,
    fitView: false,
    panOnDrag: false,
    nodesConnectable: false,
    proOptions: { hideAttribution: true },
  });
}

function renderFlow(): { root: Root; host: HTMLDivElement; textarea: HTMLTextAreaElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(FlowHarness)); });
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  return { root, host, textarea };
}

describe("node-graph composer caret (React Flow)", () => {
  it("keeps the caret after a character typed into the Style box", () => {
    const { root, host, textarea } = renderFlow();
    const caret = 6;
    // Focus first in its own act (a real click is a separate event from the
    // keystroke — React's controlled-input restore settles before typing).
    act(() => { textarea.focus(); });
    act(() => {
      const before = textarea.value;
      // Set the value through the prototype setter (bypassing React's tracked
      // override) to simulate the browser's internal value write.
      const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")?.set;
      proto?.call(textarea, before.slice(0, caret) + "x" + before.slice(caret));
      textarea.setSelectionRange(caret + 1, caret + 1);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(textarea.value).toBe("Heroicx 3D render style");
    expect(textarea.selectionStart).toBe(caret + 1);
    act(() => { root.unmount(); });
    document.body.removeChild(host);
  });
});