import type { CascadeApi } from "../../shared/ipc.js";

declare global {
  interface Window {
    cascade: CascadeApi;
    cascadeSync: { syncDisplay(sessionId: string, display: unknown[]): void };
  }
}

/** Items rendered in the chat transcript. */
export type DisplayItem =
  | { kind: "user"; text: string; images?: string[] }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "tool"; name: string; args: string; result?: string; isError?: boolean; images?: string[] }
  | { kind: "mention"; filename: string; image: string }
  | { kind: "agent-switch"; agentId: string | null; name: string; description?: string; model?: string; avatar: { kind: "emoji"; value: string } | { kind: "image"; path: string } | null; avatarDataUrl?: string | null; at: string }
  | { kind: "notice"; text: string };
