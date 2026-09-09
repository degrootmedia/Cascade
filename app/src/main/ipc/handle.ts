/**
 * Main-side IPC sender trust. Only the app's own renderer frames may invoke
 * privileged handlers — messages from any embedded frame are rejected.
 */
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

export function appOrigin(): string {
  return process.env.ELECTRON_RENDERER_URL ?? "file://";
}

/** True when the event came from the app's own renderer frame. */
export function isTrustedSender(e: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const url = (e as IpcMainInvokeEvent).senderFrame?.url ?? "";
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (dev) return url.startsWith(dev);
  return url.startsWith("file://");
}
