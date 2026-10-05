/**
 * Chat workspace resolution: a chat can mirror the active Production Assistant
 * project, and that binding is resolved before pure-chat / per-chat / default.
 */
import { describe, it, expect, vi } from "vitest";

const { dataDir } = vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
  return { dataDir: `${base}/cascade-ws-${process.pid}-${Date.now()}` };
});

vi.mock("electron", () => ({ app: { getPath: () => dataDir } }));

import { newSessionFile, resolveWorkspace, loadSession, saveSession, type SessionFile } from "../src/main/sessions.js";

type Binding = Pick<SessionFile, "followProduction" | "pureChat" | "workspace">;
const base: Binding = { followProduction: false, pureChat: false, workspace: null };

describe("resolveWorkspace", () => {
  it("uses the active production folder when following (over the per-chat folder)", () => {
    expect(resolveWorkspace({ ...base, followProduction: true, workspace: "/old" }, "/prod", "/default")).toBe("/prod");
  });

  it("returns null when following with no production open", () => {
    expect(resolveWorkspace({ ...base, followProduction: true }, null, "/default")).toBeNull();
  });

  it("returns null for pure chat", () => {
    expect(resolveWorkspace({ ...base, pureChat: true }, "/prod", "/default")).toBeNull();
  });

  it("uses the per-chat folder, then the default", () => {
    expect(resolveWorkspace({ ...base, workspace: "/mine" }, "/prod", "/default")).toBe("/mine");
    expect(resolveWorkspace(base, "/prod", "/default")).toBe("/default");
  });
});

describe("newSessionFile followProduction", () => {
  it("marks a following new chat as not pure even with no folder", () => {
    const s = newSessionFile(null, null, true);
    expect(s.followProduction).toBe(true);
    expect(s.pureChat).toBe(false);
  });

  it("defaults to a plain chat with no folder and no follow", () => {
    const s = newSessionFile(null);
    expect(s.followProduction).toBe(false);
    expect(s.pureChat).toBe(true);
  });
});

describe("newSessionFile autonomous default", () => {
  it("applies the autonomous default and starts with no grants", () => {
    const s = newSessionFile(null, null, false, true);
    expect(s.autonomousMode).toBe(true);
    expect(s.planMode).toBe(false);
    expect(s.allowedTools).toEqual([]);
    expect(s.allowedToolGroups).toEqual([]);
  });
});

describe("session approval grants persist", () => {
  it("round-trips grants, dropping blank/non-string/oversized/duplicate entries", () => {
    const s = newSessionFile("/ws");
    s.allowedTools = ["openart__gen", "", 123 as unknown as string, "openart__gen", "a".repeat(200)];
    s.allowedToolGroups = ["openart", "openart", "x".repeat(100)];
    saveSession(s);
    const loaded = loadSession(s.id)!;
    expect(loaded.allowedTools).toEqual(["openart__gen"]);
    expect(loaded.allowedToolGroups).toEqual(["openart"]);
  });
});
