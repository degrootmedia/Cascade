import { describe, it, expect } from "vitest";
import { validateIpcArgs } from "../src/shared/ipc-schemas.js";
import { ipcContract } from "../src/shared/ipc.js";
import { normalizeCanvasBusy } from "../src/shared/ipc/window.js";
import { isTrustedSender } from "../src/main/ipc/handle.js";

describe("validateIpcArgs", () => {
  it("accepts a valid external-editor payload", () => {
    expect(() => validateIpcArgs("settings:setExternalEditor", ["C:\\tools\\ed.exe"])).not.toThrow();
    expect(() => validateIpcArgs("settings:setExternalEditor", [null])).not.toThrow();
  });
  it("rejects a non-string external-editor payload", () => {
    expect(() => validateIpcArgs("settings:setExternalEditor", [123])).toThrow();
  });
  it("rejects NUL bytes in any payload", () => {
    expect(() => validateIpcArgs("production:import", ["a\0b"])).toThrow("NUL");
  });
  it("rejects invalid MCP config payloads", () => {
    expect(() => validateIpcArgs("mcp:setConfig", ["not json"])).toThrow();
    expect(() => validateIpcArgs("mcp:setConfig", [JSON.stringify({ foo: 1 })])).toThrow("mcpServers");
    expect(() =>
      validateIpcArgs("mcp:setConfig", [JSON.stringify({ mcpServers: {} })])
    ).not.toThrow();
  });
  it("rejects bad production:create payloads", () => {
    expect(() => validateIpcArgs("production:create", ["", "C:\\x"])).toThrow();
    expect(() => validateIpcArgs("production:create", ["name", 42])).toThrow();
  });
  it("validates cameraGrid:importGridImage source payloads", () => {
    expect(() => validateIpcArgs("cameraGrid:importGridImage", ["p1", "s1", { kind: "ref", refId: "r1" }])).not.toThrow();
    expect(() => validateIpcArgs("cameraGrid:importGridImage", ["p1", "s1", { kind: "editgen" }])).toThrow();
    expect(() => validateIpcArgs("cameraGrid:importGridImage", ["p1", "s1", null])).toThrow();
  });
});

describe("ipcContract assembly", () => {
  it("every channel has a spec and the security-sensitive channels exist", () => {
    const keys = Object.keys(ipcContract);
    expect(keys.length).toBeGreaterThan(100);
    for (const k of ["settings:setExternalEditor", "mcp:setConfig", "production:create", "production:import"]) {
      expect(keys).toContain(k);
    }
  });
  it("channel methods are unchanged (golden spot-check)", () => {
    expect(ipcContract["settings:setExternalEditor"]).toEqual({ method: "setExternalEditor", kind: "invoke" });
    expect(ipcContract["chat:send"]).toEqual({ method: "sendMessage", kind: "invoke" });
    expect(ipcContract["production:generateVideo"]).toEqual({ method: "generateVideo", kind: "invoke" });
    expect(ipcContract["ledger:get"]).toEqual({ method: "getLedger", kind: "invoke" });
  });
});

describe("canvas busy snapshot (Spec 03 cross-window relay)", () => {
  it("normalizes a partial snapshot and fills missing collections", () => {
    expect(normalizeCanvasBusy({ productionId: "p1" })).toEqual({
      productionId: "p1",
      image: [],
      video: [],
      editVideo: [],
      editNodes: [],
      tween: {},
      stitching: [],
    });
  });
  it("keeps valid entries", () => {
    const s = normalizeCanvasBusy({
      productionId: "p1",
      image: ["s1"],
      video: ["s2"],
      editNodes: ["s1:edit0"],
      tween: { s3: "b1" },
    });
    expect(s.image).toEqual(["s1"]);
    expect(s.tween).toEqual({ s3: "b1" });
  });
  it("rejects malformed snapshots", () => {
    expect(() => normalizeCanvasBusy(null)).toThrow();
    expect(() => normalizeCanvasBusy({})).toThrow(/productionId/);
    expect(() => normalizeCanvasBusy({ productionId: "p1", image: [1] })).toThrow(/image/);
    expect(() => normalizeCanvasBusy({ productionId: "p1", tween: { s1: 2 } })).toThrow(/tween/);
  });
  it("is wired into the generic IPC validator", () => {
    expect(() => validateIpcArgs("canvas:busyChanged", [{ productionId: "p1" }])).not.toThrow();
    expect(() => validateIpcArgs("canvas:busyChanged", [{ productionId: "p1", video: "nope" }])).toThrow();
    expect(ipcContract["canvas:busyChanged"]).toEqual({ method: "canvasBusyChanged", kind: "send" });
  });
});

describe("isTrustedSender", () => {
  const frame = (url: string) => ({ senderFrame: { url } }) as never;
  it("trusts the packaged file:// renderer", () => {
    delete process.env.ELECTRON_RENDERER_URL;
    expect(isTrustedSender(frame("file:///out/renderer/index.html"))).toBe(true);
  });
  it("rejects foreign frames", () => {
    delete process.env.ELECTRON_RENDERER_URL;
    expect(isTrustedSender(frame("https://evil.example/x"))).toBe(false);
  });
  it("trusts the dev server origin when set", () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
    expect(isTrustedSender(frame("http://localhost:5173/index.html"))).toBe(true);
    expect(isTrustedSender(frame("https://evil.example/"))).toBe(false);
    delete process.env.ELECTRON_RENDERER_URL;
  });
});
