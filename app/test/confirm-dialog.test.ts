// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ConfirmHost, confirmDestructive } from "../src/renderer/src/components/ConfirmDialog.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(React.createElement(ConfirmHost)));
}

const btn = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("confirmDestructive", () => {
  it("shows title, body, and action labels; confirm resolves true", async () => {
    mount();
    let p!: Promise<boolean>;
    await act(async () => {
      p = confirmDestructive({ title: "Delete Shot 0100?", body: "This can't be undone.", confirmLabel: "Delete" });
    });
    expect(document.body.textContent).toContain("Delete Shot 0100?");
    expect(document.body.textContent).toContain("This can't be undone.");
    expect(document.activeElement).toBe(btn("Cancel"));
    await act(async () => btn("Delete")!.click());
    await expect(p).resolves.toBe(true);
  });

  it("cancel and Escape resolve false", async () => {
    mount();
    let p1!: Promise<boolean>;
    await act(async () => {
      p1 = confirmDestructive({ title: "Delete model?", confirmLabel: "Delete" });
    });
    await act(async () => btn("Cancel")!.click());
    await expect(p1).resolves.toBe(false);

    let p2!: Promise<boolean>;
    await act(async () => {
      p2 = confirmDestructive({ title: "Remove server?", confirmLabel: "Remove" });
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await expect(p2).resolves.toBe(false);
  });
});
