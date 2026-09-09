import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { validateExternalEditor, openWithExternalEditor } from "../src/main/external-editor.js";

describe("validateExternalEditor", () => {
  it("rejects relative paths", async () => {
    await expect(validateExternalEditor("notepad.exe")).rejects.toThrow("absolute");
  });
  it("rejects script extensions", async () => {
    await expect(validateExternalEditor("C:\\tools\\edit.bat")).rejects.toThrow("Script files");
  });
  it("rejects missing files", async () => {
    await expect(
      validateExternalEditor(path.join(os.tmpdir(), "cascade-no-such-editor-xyz"))
    ).rejects.toThrow();
  });
  it("accepts a real file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-ed-"));
    try {
      const exe = path.join(dir, "editor.exe");
      fs.writeFileSync(exe, "x");
      await expect(validateExternalEditor(exe)).resolves.toBe(exe);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("openWithExternalEditor never builds a shell command and never elevates", () => {
  const target = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-edt-"));
    const exe = path.join(dir, "editor.exe");
    fs.writeFileSync(exe, "x");
    const evil = path.join(dir, "a$(whoami); rm -rf .mp4");
    fs.writeFileSync(evil, "x");
    return { dir, exe, evil };
  };

  it("passes hostile filenames as a single argv entry", async () => {
    const { dir, exe, evil } = target();
    try {
      const calls: Array<{ exe: string; args: string[]; opts: Record<string, unknown> }> = [];
      await openWithExternalEditor(evil, {
        getEditor: () => exe,
        openPath: async () => {
          throw new Error("should not fall through to openPath");
        },
        spawnFn: (e, a, o) => {
          calls.push({ exe: e, args: a, opts: o });
          const listeners = new Map<string, Array<(...x: never[]) => void>>();
          return {
            on: (ev: string, cb: (...x: never[]) => void) => {
              const list = listeners.get(ev) ?? [];
              list.push(cb);
              listeners.set(ev, list);
              if (ev === "spawn") queueMicrotask(() => list.forEach((f) => f()));
            },
            unref: () => {},
          };
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].exe).toBe(exe);
      expect(calls[0].args).toEqual([evil]);
      expect(calls[0].opts.shell).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses openPath when no editor is configured", async () => {
    const { dir, evil } = target();
    try {
      let opened: string | null = null;
      await openWithExternalEditor(evil, {
        getEditor: () => null,
        openPath: async (p) => {
          opened = p;
          return "";
        },
        spawnFn: () => {
          throw new Error("should not spawn");
        },
      });
      expect(opened).toBe(evil);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses relative targets", async () => {
    await expect(openWithExternalEditor("relative/path.mp4", { getEditor: () => null })).rejects.toThrow(
      "non-absolute"
    );
  });
});
