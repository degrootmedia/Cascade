import { describe, it, expect } from "vitest";
import { validateIpcArgs } from "../src/shared/ipc-schemas.js";
import { ipcContract } from "../src/shared/ipc.js";
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
