import { describe, it, expect } from "vitest";
import {
  SANDBOX_DOCKER_IMAGE,
  applySandbox,
  normalizeSandboxMode,
  sandboxAvailable,
  sandboxFallbackNotice,
} from "../src/sandbox.js";

const WS = "/work/space";

describe("normalizeSandboxMode", () => {
  it("defaults unknown values to none", () => {
    expect(normalizeSandboxMode(undefined)).toBe("none");
    expect(normalizeSandboxMode("bogus")).toBe("none");
    expect(normalizeSandboxMode("srt")).toBe("srt");
    expect(normalizeSandboxMode("docker")).toBe("docker");
  });
});

describe("applySandbox", () => {
  it("none is a pure passthrough", () => {
    const out = applySandbox(["npm", "test"], "none", WS);
    expect(out.argv).toEqual(["npm", "test"]);
    expect(out.notice).toBeUndefined();
  });

  it("wraps srt with network denied and writes confined to the workspace", () => {
    const out = applySandbox(["npm", "run", "lint"], "srt", WS, { commandExists: (n) => n === "srt" });
    expect(out.argv).toEqual(["srt", "--deny-network", "--allow-write", WS, "--", "npm", "run", "lint"]);
    expect(out.notice).toBeUndefined();
  });

  it("wraps docker with the workspace mounted and network off", () => {
    const out = applySandbox(["npm", "test"], "docker", WS, { commandExists: (n) => n === "docker" });
    expect(out.argv).toEqual([
      "docker",
      "run",
      "--rm",
      "--network=none",
      "-v",
      `${WS}:${WS}`,
      "-w",
      WS,
      SANDBOX_DOCKER_IMAGE,
      "npm",
      "test",
    ]);
    expect(out.notice).toBeUndefined();
  });

  it("does not fake isolation: unavailable backend keeps argv and surfaces a notice", () => {
    const out = applySandbox(["npm", "test"], "srt", WS, { commandExists: () => false });
    expect(out.argv).toEqual(["npm", "test"]);
    expect(out.notice).toBe(sandboxFallbackNotice("srt"));
    expect(out.notice).toContain("WITHOUT OS isolation");
  });
});

describe("sandboxAvailable", () => {
  it("none is always available", () => {
    expect(sandboxAvailable("none", { commandExists: () => false })).toBe(true);
  });
  it("srt/docker depend on the injected PATH lookup", () => {
    expect(sandboxAvailable("srt", { commandExists: (n) => n === "srt" })).toBe(true);
    expect(sandboxAvailable("srt", { commandExists: () => false })).toBe(false);
    expect(sandboxAvailable("docker", { commandExists: (n) => n === "docker" })).toBe(true);
  });
});
