/**
 * Verification consent: the host-side decision of whether the agent may run
 * checks automatically after edits.
 *
 * Auto-running commands is only legitimate when the user has explicitly
 * approved them for the workspace or the session — so the resolver asks at most
 * once (on the first successful mutation), persists the decision, and stays
 * silent when nothing is detected. It is a small deep module: all policy lives
 * here, the concrete store and consent prompt are injected, and that injection
 * IS the test surface.
 */
import { detectVerifyCommands, type VerificationConfig } from "@core";
import type { VerifyCommandIpc } from "../shared/ipc.js";

export type VerificationConsent = "workspace" | "session" | "deny";

export interface VerificationConsentStore {
  /** Commands approved for this workspace folder (absolute path key), or null. */
  getWorkspaceCommands(workspace: string): VerifyCommandIpc[] | null;
  setWorkspaceCommands(workspace: string, commands: VerifyCommandIpc[]): void;
  /** Commands approved for this chat, or null. */
  getSessionCommands(): VerifyCommandIpc[] | null;
  setSessionCommands(commands: VerifyCommandIpc[]): void;
  /** The user declined auto-run for this chat. */
  isDeclined(): boolean;
  setDeclined(): void;
}

export interface VerificationConsentDeps {
  workspace: string;
  store: VerificationConsentStore;
  /** Shows the one-time consent card. "none" = dismissed without choosing. */
  prompt: (commands: VerifyCommandIpc[]) => Promise<VerificationConsent | "none">;
  /** Detection seam (defaults to the core detector). */
  detect?: (workspace: string) => VerifyCommandIpc[];
}

async function resolveOnce(deps: VerificationConsentDeps): Promise<VerificationConfig | null> {
  const session = deps.store.getSessionCommands();
  if (session?.length) return { commands: session };
  if (deps.store.isDeclined()) return null;

  const workspace = deps.store.getWorkspaceCommands(deps.workspace);
  if (workspace?.length) {
    deps.store.setSessionCommands(workspace);
    return { commands: workspace };
  }

  const detect = deps.detect ?? detectVerifyCommands;
  const detected = detect(deps.workspace);
  if (!detected.length) {
    // Nothing to run — stay silent so there's no empty-check noise.
    deps.store.setDeclined();
    return null;
  }

  const decision = await deps.prompt(detected);
  if (decision === "workspace" || decision === "session") {
    if (decision === "workspace") deps.store.setWorkspaceCommands(deps.workspace, detected);
    deps.store.setSessionCommands(detected);
    return { commands: detected };
  }
  deps.store.setDeclined();
  return null;
}

/**
 * Build the `resolveVerification` callback the agent calls on its first
 * mutation. The returned function resolves at most once per agent instance.
 */
export function makeVerificationResolver(deps: VerificationConsentDeps): () => Promise<VerificationConfig | null> {
  let done = false;
  let cached: VerificationConfig | null = null;
  return async () => {
    if (done) return cached;
    done = true;
    cached = await resolveOnce(deps);
    return cached;
  };
}
