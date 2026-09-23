/**
 * The shared generated-take right-click menu (`generation-menu.tsx`).
 *
 * Regression: when the custom menu replaced the native image context menu on
 * generated takes it only carried "Save as reference" / "Delete generation…",
 * so generated images lost Save / Copy / Edit. The menu now leads with the
 * same native media actions every other image in the app gets whenever the
 * target carries a `src`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { GenerationMenu } from "../src/renderer/src/components/generation-menu.js";

interface Calls {
  saveImage: string[];
  copyImage: Array<[number, number]>;
  editImageExternally: Array<Record<string, unknown>>;
  showInFolder: Array<Record<string, unknown>>;
}

let calls: Calls;
let root: Root | null = null;

beforeEach(() => {
  calls = { saveImage: [], copyImage: [], editImageExternally: [], showInFolder: [] };
  (globalThis.window as unknown as Record<string, unknown>).cascade = {
    saveImage: async (src: string) => { calls.saveImage.push(src); },
    copyImage: async (x: number, y: number) => { calls.copyImage.push([x, y]); },
    editImageExternally: async (opts: Record<string, unknown>) => { calls.editImageExternally.push(opts); },
    showInFolder: async (opts: Record<string, unknown>) => { calls.showInFolder.push(opts); },
  };
  // jsdom's setup stub never runs the callback; run it synchronously so the
  // deferred Copy path is observable.
  (globalThis as Record<string, unknown>).requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as never;
});

afterEach(async () => {
  if (root) { await act(async () => { root!.unmount(); }); root = null; }
  document.body.innerHTML = "";
});

function menuButtons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll(".session-context-menu .ctx-item")) as HTMLButtonElement[];
}

function labels(): string[] {
  return menuButtons().map((b) => b.textContent ?? "");
}

async function renderMenu(props: Parameters<typeof GenerationMenu>[0]): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(GenerationMenu, props)); });
}

async function click(label: string): Promise<void> {
  const btn = menuButtons().find((b) => (b.textContent ?? "") === label);
  expect(btn, `button "${label}"`).toBeTruthy();
  await act(async () => { btn!.click(); });
}

describe("GenerationMenu native media actions", () => {
  it("offers save/copy/edit/open-folder for an image take with a src", async () => {
    const ref = { rel: "boards/0100/frame.png", calls: [] as string[] };
    await renderMenu({
      menu: { x: 12, y: 34, rel: ref.rel, src: "cascade-media://p1/boards%2F0100%2Fframe.png", media: "image" },
      onClose: () => {},
      onSaveAsReference: (rel) => ref.calls.push(rel),
      onDelete: () => {},
    });
    expect(labels()).toEqual([
      "Save image as…", "Copy image", "Edit externally", "Open file folder",
      "Save as reference", "Delete generation…",
    ]);

    await click("Save image as…");
    expect(calls.saveImage).toEqual(["cascade-media://p1/boards%2F0100%2Fframe.png"]);
  });

  it("routes copy (deferred), edit, and open-folder to the right IPC", async () => {
    await renderMenu({
      menu: { x: 12, y: 34, rel: "boards/0100/frame.png", src: "cascade-media://p1/frame.png", media: "image" },
      onClose: () => {},
    });
    await click("Copy image");
    expect(calls.copyImage).toEqual([[12, 34]]);
    await click("Edit externally");
    expect(calls.editImageExternally).toEqual([{ src: "cascade-media://p1/frame.png", relPath: "boards/0100/frame.png" }]);
    await click("Open file folder");
    expect(calls.showInFolder).toEqual([{ src: "cascade-media://p1/frame.png", relPath: "boards/0100/frame.png" }]);
  });

  it("drops Copy/Edit for a video take but keeps Save video / Open folder", async () => {
    await renderMenu({
      menu: { x: 0, y: 0, rel: "boards/0100/video/shot-0100.mp4", src: "cascade-media://p1/shot-0100.mp4", media: "video" },
      onClose: () => {},
    });
    expect(labels()).toEqual(["Save video as…", "Open file folder"]);
  });

  it("falls back to the path extension when media is omitted", async () => {
    await renderMenu({
      menu: { x: 0, y: 0, rel: "boards/0100/video/shot-0100.webm", src: "cascade-media://p1/shot-0100.webm" },
      onClose: () => {},
    });
    expect(labels()).toContain("Save video as…");
    expect(labels()).not.toContain("Copy image");
  });

  it("shows only the custom items when the target has no src", async () => {
    await renderMenu({
      menu: { x: 0, y: 0, rel: "boards/0100/frame.png" },
      onClose: () => {},
      onSaveAsReference: () => {},
    });
    expect(labels()).toEqual(["Save as reference"]);
  });

  it("offers Edit in Suite for an image and routes the take path", async () => {
    const seen: string[] = [];
    let closed = 0;
    await renderMenu({
      menu: { x: 0, y: 0, rel: "boards/0100/frame.png", src: "cascade-media://p1/frame.png", media: "image" },
      onClose: () => { closed++; },
      onEditInSuite: (rel) => seen.push(rel),
    });
    expect(labels()).toContain("Edit in Suite");
    await click("Edit in Suite");
    expect(seen).toEqual(["boards/0100/frame.png"]);
    expect(closed).toBe(1);
  });

  it("never offers Edit in Suite without the callback or for a video", async () => {
    await renderMenu({
      menu: { x: 0, y: 0, rel: "boards/0100/frame.png", src: "cascade-media://p1/frame.png", media: "image" },
      onClose: () => {},
    });
    expect(labels()).not.toContain("Edit in Suite");

    await act(async () => { root!.unmount(); }); root = null; document.body.innerHTML = "";
    await renderMenu({
      menu: { x: 0, y: 0, rel: "boards/0100/video/shot-0100.mp4", src: "cascade-media://p1/shot-0100.mp4", media: "video" },
      onClose: () => {},
      onEditInSuite: () => {},
    });
    expect(labels()).not.toContain("Edit in Suite");
  });
});
