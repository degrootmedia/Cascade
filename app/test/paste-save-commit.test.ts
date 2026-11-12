/**
 * Regression for: pasting an image and clicking Save sometimes creates no
 * reference and shows no error (intermittent silent failure, downstream of
 * Bug #11's paste-not-registering fix in image-paste-focus.test.ts — here
 * the save popup DOES appear, and the commit after Save is what dies).
 *
 * The commit used to run entirely after the dialog had already dismissed:
 * file read, oversize downsample, the references-dir write, and the
 * whole-document save were all fire-and-forget, so a slow or failing step
 * produced no reference, no visible error, and no way to retry. These tests
 * pin the fixed contract: Save waits for the image data (busy, dialog
 * retained), a failed write/save shows an in-dialog error and keeps the
 * pasted image for retry, the dialog only closes after the saved document
 * verifiably contains the new reference, and repeated submits are
 * idempotent (exactly one reference, one file write).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ProductionWorkspace } from "../src/renderer/src/components/ProductionWorkspace.js";
import { NamePromptHost } from "../src/renderer/src/components/NamePromptDialog.js";
import { ConfirmHost } from "../src/renderer/src/components/ConfirmDialog.js";
import { IMAGE_IMPORT_LIMIT_BYTES, OVERSIZE_IMAGE_CONVERT_LABEL } from "../src/shared/image-import.js";

class ROStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as Record<string, unknown>).ResizeObserver = ROStub;
(globalThis as Record<string, unknown>).requestAnimationFrame ??= (() => 0) as never;
(globalThis as Record<string, unknown>).cancelAnimationFrame ??= (() => {}) as never;

// FileReader stub with an optional hold: while `readHold` is set, reads do
// not complete until `releaseReads()` — the simulated slow materialization.
let readHold = false;
const heldReads: Array<() => void> = [];
function releaseReads(): void {
  readHold = false;
  for (const go of heldReads.splice(0)) go();
}
class FRStub {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  error: Error | null = null;
  readAsDataURL(): void {
    const finish = () => { this.result = "data:image/png;base64,UEFTVEVE"; this.onload?.(); };
    if (readHold) heldReads.push(finish);
    else queueMicrotask(finish);
  }
}
(globalThis as Record<string, unknown>).FileReader = FRStub;

let disk: Record<string, unknown> | null = null;

/** Controllable reference-image write: gate (slow), fail-once, or normal. */
const writeCtl = {
  gate: null as null | { promise: Promise<void>; release: () => void },
  failNext: 0,
};
function holdWrites(): void {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  writeCtl.gate = { promise, release };
}
function releaseWrites(): void {
  writeCtl.gate?.release();
  writeCtl.gate = null;
}
const addReferenceImage = vi.fn(async (_id: string, name: string, _dataUrl: string) => {
  if (writeCtl.gate) await writeCtl.gate.promise;
  if (writeCtl.failNext > 0) { writeCtl.failNext -= 1; throw new Error("disk full (simulated)"); }
  return { path: `references/${name}` };
});
const downsampleImage = vi.fn(async (_dataUrl: string) => "data:image/jpeg;base64,U0hSVU5L");
const saveCtl = { failNext: 0 };
const saveProduction = vi.fn(async (p: Record<string, unknown>) => {
  if (saveCtl.failNext > 0) { saveCtl.failNext -= 1; throw new Error("save failed (simulated)"); }
  disk = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  return disk;
});

function freshProd(): Record<string, unknown> {
  return {
    meta: { id: "p1", name: "Test production", folder: "C:/test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stepDone: 0, shotCount: 0 },
    currentStep: 2,
    visualStyle: "",
    styles: [],
    brand: { colors: [], font: "" },
    scenes: [],
    characters: [],
    products: [],
    references: [],
    suggestedReferences: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    magicEnabled: false,
    magicPrompts: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
    assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
  };
}

function cascadeMock(): Record<string, unknown> {
  const stub = () => Promise.resolve();
  return {
    boardThumbnail: async () => null,
    showImageMenu: async () => {},
    videoModelOptions: async () => null,
    getOpenArtCredits: async () => null,
    listProductions: async () => [{ id: "p1", name: "Test production", folder: "C:/test", shotCount: 0, stepDone: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    onProductionEvent: () => () => {},
    onBoardExternalUpdate: () => () => {},
    onReferencesExternalUpdate: () => () => {},
    checkExternalEdits: async () => {},
    loadProduction: async () => disk,
    boardImage: async () => "data:image/png;base64,AAAA",
    addReferenceImage: (id: string, name: string, dataUrl: string) => addReferenceImage(id, name, dataUrl),
    downsampleImage: (dataUrl: string) => downsampleImage(dataUrl),
    getBoardPrompt: async () => null,
    saveProduction: (p: Record<string, unknown>) => saveProduction(p),
    getMcpStatus: async () => [],
    listOpenArtModels: async () => [],
    getMediaProvider: async () => "openart",
    listMediaProviders: async () => [{ id: "openart", displayName: "OpenArt", available: true }],
    listModels: async () => [],
    getSettings: async () => ({}),
    generateBoards: stub, regenerateBoards: stub, exportBoardPrompts: stub, saveBoardPrompts: stub,
    importBoards: stub, pickBoardImages: stub, editBoard: stub,
    generateFrameNode: stub, generateVideoNode: stub, generateEditNode: stub,
    applyGraphOutput: stub, applyGraphRefOutput: stub,
    addReferenceMedia: stub, removeReferenceFile: stub,
    importVoiceover: stub, voiceoverFile: stub,
    importMusic: stub, musicFile: stub, removeMusic: stub, removeVoiceover: stub,
    pickReferenceImage: stub, refineStylePrompt: stub, styleFromImage: stub, generateMagicPrompts: stub,
    setMagicEnabled: stub, ingestScript: stub, createProduction: stub,
    removeProduction: stub, pickProductionFolder: stub, pickScriptFile: stub,
    reorderShot: stub, promoteBoardHistory: stub, recheckBoard: stub, removeVideo: stub,
    updateBoardPrompt: async () => disk,
  };
}

const flush = async (ms = 20) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

async function waitFor(what: string, cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await flush(10);
  }
  expect(cond(), what).toBe(true);
}

function setup(): void {
  disk = freshProd();
  readHold = false;
  heldReads.length = 0;
  writeCtl.gate = null;
  writeCtl.failNext = 0;
  saveCtl.failNext = 0;
  addReferenceImage.mockClear();
  downsampleImage.mockClear();
  saveProduction.mockClear();
  (globalThis as Record<string, unknown>).window = (globalThis as Record<string, unknown>).window ?? {};
  (globalThis.window as unknown as Record<string, unknown>).cascade = cascadeMock();
}

const mounted: Array<{ host: HTMLDivElement; root: ReturnType<typeof createRoot> }> = [];

async function openDesignPage(): Promise<{ host: HTMLDivElement; root: ReturnType<typeof createRoot> }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ host, root });
  await act(async () => {
    root.render(createElement(Fragment, null, createElement(ProductionWorkspace, {}), createElement(NamePromptHost), createElement(ConfirmHost)));
    await new Promise((r) => setTimeout(r, 0));
  });
  const openBtn = host.querySelector(".prod-card-open") as HTMLButtonElement;
  expect(openBtn).toBeTruthy();
  await act(async () => { openBtn.click(); await new Promise((r) => setTimeout(r, 0)); });
  return { host, root };
}

async function teardown(host: HTMLDivElement, root: ReturnType<typeof createRoot>): Promise<void> {
  releaseReads();
  releaseWrites();
  // Drain any open/queued dialogs (the hosts keep module-level queues, so a
  // dialog left by a failing test would leak into the next one).
  for (let i = 0; i < 12; i++) {
    const cancel = saveForm()?.querySelector('button[type="button"]') as HTMLButtonElement | null;
    if (!cancel) break;
    await act(async () => { cancel.click(); });
    await flush(10);
  }
  await flush(30); // let in-flight commits settle into THIS test's disk
  const idx = mounted.findIndex((m) => m.host === host);
  if (idx >= 0) mounted.splice(idx, 1);
  await act(async () => { root.unmount(); });
  document.body.removeChild(host);
}

afterEach(async () => {
  for (const m of [...mounted]) await teardown(m.host, m.root);
});

function pasteImage(target: HTMLElement, file?: File): void {
  const f = file ?? new File(["x"], "image.png", { type: "image/png" });
  const items = [{ kind: "file", type: f.type, getAsFile: () => f }];
  const ev = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  ev.clipboardData = { items, files: [f], getData: () => "" };
  target.dispatchEvent(ev);
}

function saveForm(): HTMLFormElement | null {
  return document.body.querySelector(".name-prompt-input")?.closest("form") as HTMLFormElement | null;
}
function saveButton(): HTMLButtonElement | null {
  return saveForm()?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
}
function dialogError(): string | null {
  return document.body.querySelector(".name-prompt-error")?.textContent ?? null;
}
function diskRefNames(): string[] {
  return ((disk?.references as Array<Record<string, unknown>> | undefined) ?? []).map((r) => r.name as string);
}

async function pasteAndOpenDialog(host: HTMLDivElement, file?: File): Promise<void> {
  await act(async () => { pasteImage(host, file); });
  await waitFor("save-reference popup shown", () => !!saveForm());
}

async function submitSave(): Promise<void> {
  const form = saveForm();
  expect(form, "save-reference popup shown").toBeTruthy();
  await act(async () => { form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}

describe("paste -> Save commit reliability (Design page)", () => {
  it("slow image write + immediate Save: dialog stays busy, then exactly one reference", async () => {
    setup();
    const { host, root } = await openDesignPage();
    holdWrites();
    await pasteAndOpenDialog(host);
    await submitSave();
    await flush(40);
    // The write has not landed: the dialog must still be there, busy —
    // never dismissed with the commit dangling behind it.
    expect(saveForm(), "dialog retained while the write is in flight").toBeTruthy();
    expect(saveButton()?.disabled, "Save busy/disabled while writing").toBe(true);
    expect(diskRefNames()).toEqual([]);

    releaseWrites();
    await waitFor("dialog closes after verified commit", () => !saveForm());
    expect(diskRefNames()).toEqual(["Ref_001"]);
    expect(addReferenceImage).toHaveBeenCalledTimes(1);
    await teardown(host, root);
  });

  it("slow image read (unfinished materialization) + immediate Save: waits, then exactly one reference", async () => {
    setup();
    const { host, root } = await openDesignPage();
    readHold = true;
    await pasteAndOpenDialog(host);
    await submitSave();
    await flush(40);
    expect(saveForm(), "dialog retained while the image data is unfinished").toBeTruthy();
    expect(addReferenceImage, "no write attempted against unfinished data").not.toHaveBeenCalled();
    expect(diskRefNames()).toEqual([]);

    releaseReads();
    await waitFor("dialog closes after verified commit", () => !saveForm());
    expect(diskRefNames()).toEqual(["Ref_001"]);
    expect(addReferenceImage).toHaveBeenCalledTimes(1);
    await teardown(host, root);
  });

  it("image-write failure: visible in-dialog error, paste retained, retry creates exactly one reference", async () => {
    setup();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host, root } = await openDesignPage();
    writeCtl.failNext = 1;
    await pasteAndOpenDialog(host);
    await submitSave();
    await waitFor("in-dialog error shown after write failure", () => !!dialogError());
    expect(saveForm(), "dialog retained for retry").toBeTruthy();
    expect(saveButton()?.disabled, "Save re-enabled for retry").toBe(false);
    expect(diskRefNames()).toEqual([]);
    // Diagnosable from the log (renderer console.error mirrors to main.log).
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("[paste-reference]"))).toBe(true);

    await submitSave();
    await waitFor("dialog closes after successful retry", () => !saveForm());
    expect(diskRefNames()).toEqual(["Ref_001"]);
    expect(addReferenceImage).toHaveBeenCalledTimes(2); // failed attempt + retry
    errSpy.mockRestore();
    await teardown(host, root);
  });

  it("reference-record save failure: error shown, retry reuses the written file (one write, one reference)", async () => {
    setup();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host, root } = await openDesignPage();
    saveCtl.failNext = 1;
    await pasteAndOpenDialog(host);
    await submitSave();
    await waitFor("in-dialog error shown after record-save failure", () => !!dialogError());
    expect(saveForm(), "dialog retained for retry").toBeTruthy();

    await submitSave();
    await waitFor("dialog closes after successful retry", () => !saveForm());
    expect(diskRefNames()).toEqual(["Ref_001"]);
    expect(addReferenceImage, "file write not repeated on record-retry").toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("[paste-reference]"))).toBe(true);
    errSpy.mockRestore();
    await teardown(host, root);
  });

  it("double-submit of Save creates exactly one reference and one file write", async () => {
    setup();
    const { host, root } = await openDesignPage();
    holdWrites();
    await pasteAndOpenDialog(host);
    const form = saveForm()!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      saveButton()?.click();
    });
    await flush(30);
    releaseWrites();
    await waitFor("dialog closes after commit", () => !saveForm());
    expect(diskRefNames()).toEqual(["Ref_001"]);
    expect(addReferenceImage).toHaveBeenCalledTimes(1);
    await teardown(host, root);
  });

  it("20 consecutive paste -> Save cycles (incl. one very large image) all create their reference", async () => {
    setup();
    const { host, root } = await openDesignPage();
    for (let i = 1; i <= 20; i++) {
      const file = i === 10
        ? new File([new Uint8Array(IMAGE_IMPORT_LIMIT_BYTES + 1024)], "image.png", { type: "image/png" })
        : new File(["x"], "image.png", { type: "image/png" });
      await act(async () => { pasteImage(host, file); });
      // Drive whichever popup is up (oversize convert consent, then the save
      // popup) until this cycle's reference lands on disk.
      let acted = 0;
      for (let step = 0; step < 300 && diskRefNames().length < i; step++) {
        const convert = Array.from(document.body.querySelectorAll(".confirm-layer button"))
          .find((b) => b.textContent === OVERSIZE_IMAGE_CONVERT_LABEL) as HTMLButtonElement | undefined;
        const form = saveForm();
        if (convert) { await act(async () => { convert.click(); }); acted++; }
        else if (form && !saveButton()?.disabled) { await submitSave(); acted++; }
        else await flush(10);
      }
      expect(acted, `cycle ${i} was driven`).toBeGreaterThan(0);
      expect(diskRefNames().length, `cycle ${i} created its reference`).toBe(i);
      await waitFor(`cycle ${i} dialog closed`, () => !saveForm());
    }
    expect(diskRefNames()).toEqual(Array.from({ length: 20 }, (_, k) => `Ref_${String(k + 1).padStart(3, "0")}`));
    expect(downsampleImage, "the very large image went through the downsample").toHaveBeenCalledTimes(1);
    await teardown(host, root);
  }, 60000);
});
