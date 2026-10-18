/**
 * CLI status probes (Settings → CLI Tools "Check status"): the status
 * functions take an injected runner, so canned replies drive them without a
 * live binary. Also pins the custom-path resolution contract the Settings
 * check relies on: an explicit bad path resolves to null (honest "not
 * found") instead of silently spawning a different binary or a .cmd shim.
 */
import { describe, it, expect, vi } from "vitest";
import * as path from "node:path";
import { getHiggsfieldCliStatus } from "../src/main/providers/higgsfield-cli.js";
import { getOpenArtCliStatus, resolveOpenArtCliBinary } from "../src/main/providers/openart-cli.js";
import type { CliRun, CliRunResult } from "../src/main/providers/cli-run.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

const ok = (stdout: string): CliRunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): CliRunResult => ({ code: 1, stdout: "", stderr });
/** Spawn failure (e.g. EINVAL spawning a .cmd shim shell-free): code null. */
const spawnFail = (stderr: string): CliRunResult => ({ code: null, stdout: "", stderr });

function fakeRun(handler: (args: string[]) => CliRunResult): { run: CliRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: CliRun = async (args) => {
    calls.push(args);
    return handler(args);
  };
  return { run, calls };
}

describe("getHiggsfieldCliStatus", () => {
  it("reports not-found without running anything when binary is null", async () => {
    const { run, calls } = fakeRun(() => ok(""));
    await expect(getHiggsfieldCliStatus(null, run)).resolves.toEqual({
      binary: null, version: null, authenticated: false, account: null,
    });
    expect(calls).toEqual([]);
  });

  it("reads version + signed-in account", async () => {
    const { run, calls } = fakeRun((args) =>
      args[0] === "version" ? ok("higgsfield 1.2.3\n") : ok(JSON.stringify({ email: "a@b.c", credits: 10 })));
    await expect(getHiggsfieldCliStatus("C:/bin/hf.exe", run)).resolves.toEqual({
      binary: "C:/bin/hf.exe", version: "higgsfield 1.2.3", authenticated: true, account: "a@b.c",
    });
    expect(calls).toEqual([["version"], ["account", "status", "--json", "--no-color"]]);
  });

  it("survives a spawn failure (code null) as binary-present but unknown", async () => {
    const { run } = fakeRun(() => spawnFail("spawn EINVAL"));
    await expect(getHiggsfieldCliStatus("C:/bin/higgsfield.cmd", run)).resolves.toEqual({
      binary: "C:/bin/higgsfield.cmd", version: null, authenticated: false, account: null,
    });
  });

  it("reports not-signed-in when account status fails but version works", async () => {
    const { run } = fakeRun((args) => (args[0] === "version" ? ok("hf 2.0") : fail("Session expired")));
    const s = await getHiggsfieldCliStatus("hf", run);
    expect(s.version).toBe("hf 2.0");
    expect(s.authenticated).toBe(false);
  });
});

describe("getOpenArtCliStatus", () => {
  it("reports not-found without running anything when binary is null", async () => {
    const { run, calls } = fakeRun(() => ok(""));
    await expect(getOpenArtCliStatus(null, run)).resolves.toEqual({
      binary: null, version: null, authenticated: false, account: null,
    });
    expect(calls).toEqual([]);
  });

  it("reads version + signed-in account", async () => {
    const { run, calls } = fakeRun((args) =>
      args[0] === "version" ? ok("openart 0.9.1") : ok(JSON.stringify({ email: "x@y.z" })));
    await expect(getOpenArtCliStatus("C:/bin/openart.exe", run)).resolves.toEqual({
      binary: "C:/bin/openart.exe", version: "openart 0.9.1", authenticated: true, account: "x@y.z",
    });
    expect(calls).toEqual([["version"], ["account", "--json"]]);
  });

  it("survives a spawn failure (code null)", async () => {
    const { run } = fakeRun(() => spawnFail("spawn ENOENT"));
    await expect(getOpenArtCliStatus("C:/bin/openart.exe", run)).resolves.toMatchObject({
      binary: "C:/bin/openart.exe", version: null, authenticated: false,
    });
  });
});

describe("resolveOpenArtCliBinary custom path", () => {
  it("an explicit nonexistent custom path resolves to null, not a PATH fallback", async () => {
    const bogus = path.join("X:", "definitely-not-here", "openart.exe");
    await expect(resolveOpenArtCliBinary(bogus)).resolves.toBeNull();
  });
});
