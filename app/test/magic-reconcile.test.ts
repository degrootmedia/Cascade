/**
 * Magic Prompt reconciliation queue (Step 3): unmatched cited names render
 * one row each with the user's references to slot in; Assign/Create/Dismiss
 * call the host handlers; resolved or dismissed names render nothing.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import type { Production } from "../src/shared/ipc.js";
import { MagicReconcileQueue } from "../src/renderer/src/components/production/magic-reconcile.js";

function prod(overrides: Partial<Production> = {}): Production {
  return {
    meta: { id: "p1", name: "T" },
    magicEnabled: true,
    scenes: [{ number: 1, title: "S", shots: [{ id: "s1", number: "0100", audio: "", visual: "Ada walks." }] }],
    magicPrompts: { s1: "@[MainCharacter] walks with @[WeatherVane] spinning." },
    characters: [{ id: "c1", name: "Hero", key: "young woman, main character of the story", imagePath: "references/hero.png" }],
    products: [],
    references: [],
    styles: [],
    ...overrides,
  } as unknown as Production;
}

function mount(p: Production, handlers: { onAssign?: (c: string, r: string) => void; onCreate?: (c: string) => void; onDismiss?: (c: string) => void } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(MagicReconcileQueue, {
      prod: p,
      busy: null,
      onAssign: handlers.onAssign ?? (() => {}),
      onCreate: handlers.onCreate ?? (() => {}),
      onDismiss: handlers.onDismiss ?? (() => {}),
    }));
  });
  return { host, root };
}

describe("MagicReconcileQueue", () => {
  it("renders a row per unmatched name with its shots and wires the actions", async () => {
    const onAssign = vi.fn();
    const onCreate = vi.fn();
    const onDismiss = vi.fn();
    const { host, root } = mount(prod(), { onAssign, onCreate, onDismiss });
    const rows = host.querySelectorAll(".prod-magic-reconcile-row");
    expect(rows.length).toBe(2);
    expect(host.textContent).toContain("@[MainCharacter]");
    expect(host.textContent).toContain("0100");

    const buttons = [...host.querySelectorAll("button")];
    await act(async () => { buttons.find((b) => b.textContent === "Use my reference")!.click(); });
    expect(onAssign).toHaveBeenCalledWith("MainCharacter", "c1");
    await act(async () => { buttons.filter((b) => b.textContent === "Create reference")[1].click(); });
    expect(onCreate).toHaveBeenCalledWith("WeatherVane");
    await act(async () => { buttons.filter((b) => b.textContent === "Dismiss")[0].click(); });
    expect(onDismiss).toHaveBeenCalledWith("MainCharacter");
    act(() => root.unmount());
    host.remove();
  });

  it("renders nothing when every citation resolves (alias counts)", () => {
    const p = prod({
      magicPrompts: { s1: "@[MainCharacter] walks." },
      characters: [{ id: "c1", name: "Hero", key: "x", aliases: ["MainCharacter"], imagePath: "references/hero.png" } as Production["characters"][number]],
    });
    const { host, root } = mount(p);
    expect(host.querySelector(".prod-magic-reconcile")).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});
