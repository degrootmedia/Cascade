import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { imageMimeForPath, makeVisionTools, type VisionHost } from "../src/main/vision-tools.js";

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-vision-"));
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

function makeHost(overrides: Partial<VisionHost> = {}): VisionHost {
  return {
    captureDisplay: async () => "data:image/png;base64,PNGDATA",
    saveCapture: (_dataUrl, root) => {
      const rel = "cascade-images/screenshot-x.png";
      fs.mkdirSync(path.join(root, "cascade-images"), { recursive: true });
      fs.writeFileSync(path.join(root, rel), "x");
      return rel;
    },
    toModelImage: (bytes, mime) => `data:${mime};base64,MODEL(${bytes.length})`,
    ...overrides,
  };
}

describe("imageMimeForPath", () => {
  it("maps common image extensions and rejects others", () => {
    expect(imageMimeForPath("a/b.png")).toBe("image/png");
    expect(imageMimeForPath("a/b.JPG")).toBe("image/jpeg");
    expect(imageMimeForPath("a/b.webp")).toBe("image/webp");
    expect(imageMimeForPath("a/b.txt")).toBeNull();
    expect(imageMimeForPath("a/b")).toBeNull();
  });
});

describe("view_image", () => {
  it("loads a workspace image as a model image", async () => {
    const ws = tmpDir();
    fs.writeFileSync(path.join(ws, "frame.png"), Buffer.from([1, 2, 3, 4]));
    const host = makeHost();
    const tools = makeVisionTools(host, { capture: false });
    const res = await tools.view_image.run({ path: "frame.png" }, ws);
    expect(typeof res).toBe("object");
    if (typeof res === "string") throw new Error("expected object");
    expect(res.text).toContain("frame.png");
    expect(res.modelImages).toEqual(["data:image/png;base64,MODEL(4)"]);
    // Also shown in the transcript (parity with other image-producing tools).
    expect(res.images).toEqual(["data:image/png;base64,MODEL(4)"]);
  });

  it("rejects a path that escapes the workspace", async () => {
    const ws = tmpDir();
    const tools = makeVisionTools(makeHost(), { capture: false });
    const res = await tools.view_image.run({ path: "../secret.png" }, ws);
    if (typeof res === "string") throw new Error("expected object");
    expect(res.text.startsWith("ERROR")).toBe(true);
    expect(res.modelImages).toBeUndefined();
  });

  it("rejects a non-image file", async () => {
    const ws = tmpDir();
    fs.writeFileSync(path.join(ws, "notes.txt"), "hi");
    const tools = makeVisionTools(makeHost(), { capture: false });
    const res = await tools.view_image.run({ path: "notes.txt" }, ws);
    if (typeof res === "string") throw new Error("expected object");
    expect(res.text).toContain("not a supported image");
  });

  it("reports a missing file", async () => {
    const ws = tmpDir();
    const tools = makeVisionTools(makeHost(), { capture: false });
    const res = await tools.view_image.run({ path: "nope.png" }, ws);
    if (typeof res === "string") throw new Error("expected object");
    expect(res.text.startsWith("ERROR")).toBe(true);
  });

  it("requires a path", async () => {
    const ws = tmpDir();
    const tools = makeVisionTools(makeHost(), { capture: false });
    const res = await tools.view_image.run({}, ws);
    if (typeof res === "string") throw new Error("expected object");
    expect(res.text).toContain("`path` is required");
  });
});

describe("capture_screen", () => {
  it("is present only when capture is enabled", () => {
    expect(makeVisionTools(makeHost(), { capture: false }).capture_screen).toBeUndefined();
    expect(makeVisionTools(makeHost(), { capture: true }).capture_screen).toBeDefined();
  });

  it("captures, saves, and returns the image for the model", async () => {
    const ws = tmpDir();
    const captureDisplay = vi.fn(async () => "data:image/png;base64,PNGDATA");
    const host = makeHost({ captureDisplay });
    const tools = makeVisionTools(host, { capture: true });
    const res = await tools.capture_screen.run({}, ws);
    if (typeof res === "string") throw new Error("expected object");
    expect(captureDisplay).toHaveBeenCalledTimes(1);
    expect(res.text).toContain("cascade-images/screenshot-x.png");
    expect(res.modelImages).toHaveLength(1);
    expect(res.images).toHaveLength(1);
    // It is approval-gated (privacy).
    expect(tools.capture_screen.requiresApproval).toBe(true);
  });

  it("surfaces a capture failure as an error", async () => {
    const ws = tmpDir();
    const host = makeHost({ captureDisplay: async () => { throw new Error("no display"); } });
    const tools = makeVisionTools(host, { capture: true });
    const res = await tools.capture_screen.run({}, ws);
    if (typeof res === "string") throw new Error("expected object");
    expect(res.text).toContain("screen capture failed");
    expect(res.modelImages).toBeUndefined();
  });
});
