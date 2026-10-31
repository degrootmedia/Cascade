import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openWithExternalEditor } from "../src/main/external-editor.js";

describe("audio editor", () => {
  it("opens an audio file in the configured audio editor as a single argv entry", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-aud-"));
    try {
      const exe = path.join(dir, "audacity.exe");
      const wav = path.join(dir, "take 1.wav");
      fs.writeFileSync(exe, "x");
      fs.writeFileSync(wav, "x");
      const calls: Array<{ exe: string; args: string[] }> = [];
      await openWithExternalEditor(wav, {
        getEditor: () => exe,
        openPath: async () => { throw new Error("no fallthrough"); },
        spawnFn: (e, a) => {
          calls.push({ exe: e, args: a });
          return { on: (ev, cb) => { if (ev === "spawn") queueMicrotask(() => (cb as () => void)()); }, unref: () => {} };
        },
      });
      expect(calls).toEqual([{ exe, args: [wav] }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
