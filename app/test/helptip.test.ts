/** HelpTip (UI cleanup Item 2): the "?" marker that carries former standing
 *  instruction paragraphs as a hover tooltip next to a section heading.
 *  Pins the contract every moved text block relies on: the full text is on
 *  the native `title` (hover) and in the accessible name (no mouse needed). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HelpTip } from "../src/renderer/src/components/common/HelpTip.js";

describe("HelpTip", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    vi.unstubAllGlobals();
  });

  it("carries the guidance as tooltip text and an accessible name", async () => {
    const text = "Drag a clip to move it. S splits at the playhead.";
    await act(async () => {
      root.render(createElement(HelpTip, { text, label: "Timeline editor help" }));
    });
    const tip = host.querySelector(".cascade-helptip") as HTMLElement;
    expect(tip).not.toBeNull();
    expect(tip.getAttribute("title")).toBe(text);
    expect(tip.getAttribute("aria-label")).toBe(`Timeline editor help — ${text}`);
    expect(tip.getAttribute("role")).toBe("img");
    expect(tip.tabIndex).toBe(0);
    expect(tip.textContent).toBe("?");
  });

  it("works without a label and swallows clicks (never toggles a parent)", async () => {
    await act(async () => {
      root.render(createElement(HelpTip, { text: "Section guidance." }));
    });
    const tip = host.querySelector(".cascade-helptip") as HTMLElement;
    expect(tip.getAttribute("aria-label")).toBe("Section guidance.");
    // A click on the marker must not bubble past the React root to an
    // ancestor handler (it is inert help chrome, never an action).
    let bubbled = false;
    const onBody = () => { bubbled = true; };
    document.body.addEventListener("click", onBody);
    try {
      await act(async () => { tip.click(); });
    } finally {
      document.body.removeEventListener("click", onBody);
    }
    expect(bubbled).toBe(false);
  });
});
