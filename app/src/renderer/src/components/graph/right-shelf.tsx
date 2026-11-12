/**
 * The node canvas's right-hand shelf, tabbed (Feature #18):
 *  - "Nodes": the categorized node palette (`NodeShelf`, Feature #15),
 *    untouched — same sections, collapse memory, search, and drag.
 *  - "Snippets": the prompt-snippet library (`SnippetsPanel`,
 *    Feature #14), embedded — the node canvas's only snippets entry
 *    point now that the header button is gone.
 *
 * Both panes stay mounted (the inactive one is display:none) so each
 * keeps its own search/scroll state across a tab round-trip. The
 * last-used tab persists per user (localStorage, like the palette's
 * collapse flags) and the shelf reopens on it; the default is Nodes.
 *
 * While the shelf is shown it claims shelf-open requests, so "Save
 * selection as snippet" from a node prompt lands here (tab switch +
 * pre-filled form) instead of opening the overlay shelf. Hosts that
 * hide the palette (the sequence canvas) don't claim — the overlay
 * keeps ownership there.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { NodeShelf, type NodeShelfTile } from "./node-shelf.js";
import { SnippetsPanel, type SnippetPrefillRequest } from "../snippets/SnippetsShelf.js";
import { claimSnippetsShelfRequests } from "../snippets/snippets-ui.js";

export type GraphShelfTab = "nodes" | "snippets";

/** localStorage key for the last-used shelf tab. Global per user, like
 *  the node-shelf collapse flags (`cascade.graph.nodeShelf.*`). */
export const GRAPH_SHELF_TAB_KEY = "cascade.graph.rightShelfTab";

function readShelfTab(): GraphShelfTab {
  try {
    return window.localStorage.getItem(GRAPH_SHELF_TAB_KEY) === "snippets" ? "snippets" : "nodes";
  } catch {
    return "nodes";
  }
}

export function GraphRightShelf({ tiles, hidden = false }: {
  tiles: NodeShelfTile[];
  /** Hosts without a palette (sequence canvas) hide the whole shelf. */
  hidden?: boolean;
}) {
  const [tab, setTab] = useState<GraphShelfTab>(readShelfTab);
  const [prefillRequest, setPrefillRequest] = useState<SnippetPrefillRequest | null>(null);
  const nonceRef = useRef(0);

  const chooseTab = useCallback((next: GraphShelfTab) => {
    setTab(next);
    try {
      window.localStorage.setItem(GRAPH_SHELF_TAB_KEY, next);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (hidden) return;
    return claimSnippetsShelfRequests((req) => {
      chooseTab("snippets");
      if (req.prefillBody !== undefined) {
        nonceRef.current += 1;
        setPrefillRequest({ body: req.prefillBody, nonce: nonceRef.current });
      }
    });
  }, [hidden, chooseTab]);

  return (
    <div className={"prod-graph-tools" + (hidden ? " hidden" : "") + (tab === "snippets" ? " snippets-tab" : "")}>
      <div className="prod-graph-tools-tabs" role="tablist" aria-label="Node canvas shelf">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "nodes"}
          className={"prod-graph-tools-tab" + (tab === "nodes" ? " active" : "")}
          onClick={() => chooseTab("nodes")}
        >
          Nodes
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "snippets"}
          className={"prod-graph-tools-tab" + (tab === "snippets" ? " active" : "")}
          onClick={() => chooseTab("snippets")}
        >
          Snippets
        </button>
      </div>
      <div className={"prod-graph-tools-pane" + (tab !== "nodes" ? " hidden" : "")} role="tabpanel" aria-label="Nodes">
        <NodeShelf tiles={tiles} />
      </div>
      <div className={"prod-graph-tools-pane snippets-pane" + (tab !== "snippets" ? " hidden" : "")} role="tabpanel" aria-label="Snippets">
        <SnippetsPanel embedded visible={tab === "snippets" && !hidden} prefillRequest={prefillRequest} />
      </div>
    </div>
  );
}
