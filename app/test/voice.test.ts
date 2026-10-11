import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  coerceWhisperModel,
  ensureWhisperModel,
  isModelReady,
  parseWhisperText,
  pcm16ToWav,
  resolveWhisperBinary,
  transcribeWav,
  whisperModelFilename,
  whisperModelPath,
  type RunFn,
} from "../src/main/voice.js";

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-voice-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("pcm16ToWav", () => {
  it("writes a 44-byte PCM WAV header for 16-bit mono", () => {
    const pcm = Int16Array.from([0, 1, -1, 32767]);
    const wav = pcm16ToWav(pcm, 16000);
    expect(wav.length).toBe(44 + pcm.length * 2);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length * 2);
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16); // bits
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(pcm.length * 2);
    expect(wav.readInt16LE(44)).toBe(0);
    expect(wav.readInt16LE(50)).toBe(32767);
  });
});

describe("parseWhisperText", () => {
  it("joins segment lines and drops timestamps/blanks", () => {
    const raw = "  Hello there.\n\n[00:00:01.000 --> 00:00:02.000]   How are you?\n";
    expect(parseWhisperText(raw)).toBe("Hello there. How are you?");
  });

  it("returns empty for empty input", () => {
    expect(parseWhisperText("   \n\n")).toBe("");
  });
});

describe("resolveWhisperBinary", () => {
  it("prefers an explicit override that exists", () => {
    const d = tmpDir();
    const bin = path.join(d, "whisper-cli.exe");
    fs.writeFileSync(bin, "x");
    expect(resolveWhisperBinary(bin)).toBe(bin);
  });

  it("ignores a non-existent override", () => {
    const missing = path.join(tmpDir(), "nope.exe");
    // Falls through to PATH lookup; may be null on a clean box, but must not
    // return the bogus override.
    expect(resolveWhisperBinary(missing)).not.toBe(missing);
  });
});

describe("model path + readiness", () => {
  it("names the ggml file per model", () => {
    expect(whisperModelFilename("base.en")).toBe("ggml-base.en.bin");
    expect(whisperModelPath("/x", "tiny.en")).toBe(path.join("/x", "ggml-tiny.en.bin"));
  });

  it("treats a missing or empty file as not ready", () => {
    const d = tmpDir();
    expect(isModelReady(d, "base.en")).toBe(false);
    fs.writeFileSync(whisperModelPath(d, "base.en"), "");
    expect(isModelReady(d, "base.en")).toBe(false);
    fs.writeFileSync(whisperModelPath(d, "base.en"), "abc");
    expect(isModelReady(d, "base.en")).toBe(true);
  });
});

describe("ensureWhisperModel", () => {
  it("downloads once and reuses the file", async () => {
    const d = tmpDir();
    let calls = 0;
    const fetchTo = async (_url: string, dest: string) => {
      calls++;
      fs.writeFileSync(dest, "model-bytes");
    };
    const p = await ensureWhisperModel(d, "base.en", undefined, fetchTo);
    expect(p).toBe(whisperModelPath(d, "base.en"));
    expect(fs.readFileSync(p, "utf8")).toBe("model-bytes");
    await ensureWhisperModel(d, "base.en", undefined, fetchTo);
    expect(calls).toBe(1);
  });

  it("requests the ggml model from the whisper.cpp repo root", async () => {
    const d = tmpDir();
    let seenUrl = "";
    const fetchTo = async (url: string, dest: string) => {
      seenUrl = url;
      fs.writeFileSync(dest, "x");
    };
    await ensureWhisperModel(d, "tiny.en", undefined, fetchTo);
    // The converted models live at the repo root, not under models/.
    expect(seenUrl).toBe("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin");
  });

  it("cleans up the partial file on failure", async () => {
    const d = tmpDir();
    const fetchTo = async (_url: string, dest: string) => {
      fs.writeFileSync(dest, "half");
      throw new Error("network down");
    };
    await expect(ensureWhisperModel(d, "small.en", undefined, fetchTo)).rejects.toThrow("network down");
    expect(fs.existsSync(`${whisperModelPath(d, "small.en")}.part`)).toBe(false);
    expect(isModelReady(d, "small.en")).toBe(false);
  });
});

describe("transcribeWav", () => {
  it("runs whisper-cli with the txt flags and parses its output", async () => {
    const d = tmpDir();
    const bin = "whisper-cli";
    const modelPath = whisperModelPath(d, "base.en");
    const wavPath = path.join(d, "audio.wav");
    const outBase = path.join(d, "audio");
    fs.writeFileSync(wavPath, "RIFF");
    let seenArgv: string[] = [];
    const run: RunFn = async (_bin, argv) => {
      seenArgv = argv;
      fs.writeFileSync(`${outBase}.txt`, " Hello from whisper \n");
    };
    const text = await transcribeWav({ bin, modelPath, wavPath, outBase, language: "en", threads: 4 }, run);
    expect(text).toBe("Hello from whisper");
    expect(seenArgv).toContain("-m");
    expect(seenArgv).toContain(modelPath);
    expect(seenArgv).toContain("-f");
    expect(seenArgv).toContain("-otxt");
    expect(seenArgv[seenArgv.indexOf("-of") + 1]).toBe(outBase);
    expect(seenArgv[seenArgv.indexOf("-l") + 1]).toBe("en");
    expect(seenArgv[seenArgv.indexOf("-t") + 1]).toBe("4");
    // The temp .txt is cleaned up.
    expect(fs.existsSync(`${outBase}.txt`)).toBe(false);
  });
});

describe("coerceWhisperModel", () => {
  it("accepts known sizes and falls back for junk", () => {
    expect(coerceWhisperModel("tiny.en")).toBe("tiny.en");
    expect(coerceWhisperModel("bogus")).toBe("base.en");
    expect(coerceWhisperModel(undefined)).toBe("base.en");
  });
});
