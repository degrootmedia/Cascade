/**
 * Cast & Sets review modal: explains each need in plain language (what,
 * which shots, what's mapped and why), groups pending vs ready, and wires
 * map / text-only / create-in-suite / write actions to the host.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import type { Production } from "../src/shared/ipc.js";
import { MagicCastReview } from "../src/renderer/src/components/production/magic-cast-review.js";

function prod(): Production {
  return {
    meta: { id: "p1", name: "Junk Drawer" },
    magicEnabled: true,
    scenes: [{ number: 1, title: "S", shots: [{ id: "s1", number: "0100", audio: "", visual: "x" }] }],
    characters: [{ id: "c1", name: "Hero", key: "red cloak", imagePath: "references/hero.png" }],
    products: [],
    references: [
      { id: "r-env", name: "Drawer Alley", purpose: "environment", imagePath: "references/env.png", shotIds: [] },
      { id: "r-blk", name: "Ref-001", purpose: "layout", imagePath: "references/blk.png", shotIds: [] },
    ],
    referenceCategories: [],
    styles: [],
    magicBible: {
      version: 1, synopsis: "Ada crosses the drawer.", worldPremise: "A miniature city inside a junk drawer.",
      assumptions: [], scenes: [],
      entities: [
        { name: "Ada", kind: "character", descriptor: "young woman in a red cloak" },
        { name: "Drawer Alley Set", kind: "location", descriptor: "narrow alley", refName: "Drawer Alley", refNames: ["Drawer Alley"], boundBy: "auto", confidence: "medium", bindReason: "Matched an environment reference by name/category" },
        { name: "Heroine", kind: "character", descriptor: "lead", refName: "Hero", refNames: ["Hero"], boundBy: "user", confidence: "high", bindReason: "You mapped this in Cast & Sets" },
      ],
      shotPlans: [{ number: "0100", purpose: "x", present: ["Ada", "Drawer Alley Set", "Heroine"], mustCite: [] }],
      inputHash: "h", generatedAt: "2026-01-01",
    },
  } as unknown as Production;
}

describe("MagicCastReview", () => {
  it("explains needs, hides ready behind a toggle, and wires the actions", async () => {
    const onMap = vi.fn();
    const onTextOnly = vi.fn();
    const onCreateInSuite = vi.fn();
    const onWrite = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(MagicCastReview, {
        prod: prod(), busy: null, onMap, onTextOnly, onCreateInSuite, onClose: () => {}, onWrite,
      }));
    });
    const body = document.body.textContent ?? "";
    expect(body).toContain("Cast & sets for Junk Drawer");
    expect(body).toContain("A miniature city inside a junk drawer.");
    expect(body).toContain("No reference matched");
    expect(body).toContain("Matched an environment reference by name/category");
    expect(body).toContain("Ready (1)");

    const buttons = [...document.body.querySelectorAll("button")];
    // Map Ada -> Hero via the picker.
    await act(async () => { buttons.find((b) => b.textContent === "Use my reference")!.click(); });
    const candidate = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes("@[Hero]"));
    expect(candidate).toBeTruthy();
    // The layout blockout is listed as not castable, never as a candidate.
    expect(document.body.textContent).toContain("Not castable");
    expect([...document.body.querySelectorAll(".prod-cast-candidate")].some((b) => b.textContent?.includes("Ref-001"))).toBe(false);
    await act(async () => { candidate!.click(); });
    expect(onMap).toHaveBeenCalledWith("Ada", ["c1"]);

    const buttons2 = [...document.body.querySelectorAll("button")];
    await act(async () => { buttons2.find((b) => b.textContent === "Create in Image Suite")!.click(); });
    expect(onCreateInSuite).toHaveBeenCalledWith(expect.objectContaining({ entityName: "Ada" }));
    await act(async () => { buttons2.filter((b) => b.textContent === "Text only")[0].click(); });
    expect(onTextOnly).toHaveBeenCalled();
    await act(async () => { [...document.body.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Write prompts"))!.click(); });
    expect(onWrite).toHaveBeenCalled();
    act(() => root.unmount());
    host.remove();
  });
});
