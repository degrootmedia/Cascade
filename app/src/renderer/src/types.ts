import type { CascadeApi, ChatAttachment, DisplayItem } from "../../shared/ipc.js";

declare global {
  interface Window {
    cascade: CascadeApi;
  }
}

export type { ChatAttachment, DisplayItem } from "../../shared/ipc.js";