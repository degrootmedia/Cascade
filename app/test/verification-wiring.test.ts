/**
 * Verification consent wiring: the host asks for auto-run permission at most
 * once, persists the decision (per workspace or per session), stays silent when
 * nothing is detected, and never auto-runs an unapproved command.
 */
import { describe, it, expect, vi } from "vitest";
import { makeVerificationResolver, type VerificationConsentStore } from "../src/main/verify-consent.js";
import type { VerifyCommandIpc } from "../src/shared/ipc.js";

const DETECTED: VerifyCommandIpc[] = [
  { name: "typecheck", argv: ["npm", "run", "typecheck"] },
  { name: "test", argv: ["npm", "run", "test"] },
];

function makeStore(init: { workspace?: VerifyCommandIpc[]; session?: VerifyCommandIpc[]; declined?: boolean } = {}) {
  const state = {
    workspace: init.workspace ?? null,
    session: init.session ?? null,
    declined: init.declined ?? false,
  };
  const store: VerificationConsentStore = {
    getWorkspaceCommands: (ws) => (ws === "/ws" ? state.workspace : null),
    setWorkspaceCommands: (_ws, cmds) => {
      state.workspace = cmds;
    },
    getSessionCommands: () => state.session,
    setSessionCommands: (cmds) => {
      state.session = cmds;
    },
    isDeclined: () => state.declined,
    setDeclined: () => {
      state.declined = true;
    },
  };
  return { store, state };
}

describe("makeVerificationResolver", () => {
  it("asks once; a workspace decision persists and is not re-asked", async () => {
    const { store, state } = makeStore();
    const prompt = vi.fn(async () => "workspace" as const);
    const detect = () => DETECTED;

    const first = makeVerificationResolver({ workspace: "/ws", store, prompt, detect });
    const config = await first();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(config?.commands).toHaveLength(2);
    expect(state.workspace).toEqual(DETECTED);

    // A rebuilt agent (new resolver, same store) sees the saved workspace grant
    // and never prompts again.
    const prompt2 = vi.fn(async () => "deny" as const);
    const second = makeVerificationResolver({ workspace: "/ws", store, prompt: prompt2, detect });
    const config2 = await second();
    expect(prompt2).not.toHaveBeenCalled();
    expect(config2?.commands).toHaveLength(2);
  });

  it("a session decision does not persist to the workspace", async () => {
    const { store, state } = makeStore();
    const prompt = vi.fn(async () => "session" as const);
    const config = await makeVerificationResolver({ workspace: "/ws", store, prompt, detect: () => DETECTED })();
    expect(config?.commands).toHaveLength(2);
    expect(state.session).toEqual(DETECTED);
    expect(state.workspace).toBeNull();
  });

  it("a deny records the decline and returns null", async () => {
    const { store, state } = makeStore();
    const prompt = vi.fn(async () => "deny" as const);
    const config = await makeVerificationResolver({ workspace: "/ws", store, prompt, detect: () => DETECTED })();
    expect(config).toBeNull();
    expect(state.declined).toBe(true);
  });

  it("dismissing the card declines without enabling", async () => {
    const { store, state } = makeStore();
    const prompt = vi.fn(async () => "none" as const);
    const config = await makeVerificationResolver({ workspace: "/ws", store, prompt, detect: () => DETECTED })();
    expect(config).toBeNull();
    expect(state.declined).toBe(true);
    expect(state.workspace).toBeNull();
  });

  it("stays silent and never prompts when nothing is detected", async () => {
    const { store, state } = makeStore();
    const prompt = vi.fn(async () => "workspace" as const);
    const config = await makeVerificationResolver({ workspace: "/ws", store, prompt, detect: () => [] })();
    expect(prompt).not.toHaveBeenCalled();
    expect(config).toBeNull();
    expect(state.declined).toBe(true);
  });

  it("a saved session grant is honored without prompting", async () => {
    const { store } = makeStore({ session: DETECTED });
    const prompt = vi.fn(async () => "deny" as const);
    const config = await makeVerificationResolver({ workspace: "/ws", store, prompt, detect: () => DETECTED })();
    expect(prompt).not.toHaveBeenCalled();
    expect(config?.commands).toEqual(DETECTED);
  });

  it("a declined session skips detection and prompting", async () => {
    const { store } = makeStore({ declined: true });
    const prompt = vi.fn(async () => "workspace" as const);
    const detect = vi.fn(() => DETECTED);
    const config = await makeVerificationResolver({ workspace: "/ws", store, prompt, detect })();
    expect(config).toBeNull();
    expect(prompt).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();
  });

  it("resolves at most once per agent instance", async () => {
    const { store } = makeStore();
    const prompt = vi.fn(async () => "session" as const);
    const resolver = makeVerificationResolver({ workspace: "/ws", store, prompt, detect: () => DETECTED });
    await resolver();
    await resolver();
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
