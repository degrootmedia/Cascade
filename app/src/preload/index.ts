import { contextBridge, ipcRenderer } from "electron";
import { ipcContract, type CascadeApi, type ChatEvent, type ApprovalRequestIpc, type ApprovalDecisionIpc, type ProductionEvent } from "../shared/ipc.js";

/**
 * Build `window.cascade` mechanically from the shared channel contract
 * (shared/ipc.ts) instead of hand-listing every method. Adding a channel is
 * one line in ipcContract — this adapter and the main-process handlers follow
 * automatically. The `on*` subscriptions are wired by hand because they take
 * callbacks and unsubscribe functions, not request payloads.
 */
function buildApi(): CascadeApi {
  const api: Record<string, unknown> = {};
  for (const [channel, spec] of Object.entries(ipcContract)) {
    api[spec.method] =
      spec.kind === "invoke"
        ? (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
        : (...args: unknown[]) => ipcRenderer.send(channel, ...args);
  }

  api.onAgentEvent = (cb: (e: ChatEvent) => void) => {
    const listener = (_e: unknown, ev: ChatEvent) => cb(ev);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  };
  api.onApprovalRequest = (cb: (req: ApprovalRequestIpc) => void) => {
    const listener = (_e: unknown, req: ApprovalRequestIpc) => cb(req);
    ipcRenderer.on("approval:request", listener);
    return () => ipcRenderer.removeListener("approval:request", listener);
  };
  api.onMentionAdded = (cb: (e: { sessionId: string; dataUrl: string; filename: string }) => void) => {
    const listener = (_e: unknown, e: { sessionId: string; dataUrl: string; filename: string }) => cb(e);
    ipcRenderer.on("mention:added", listener);
    return () => ipcRenderer.removeListener("mention:added", listener);
  };
  api.onOpenSettings = (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("menu:openSettings", listener);
    return () => ipcRenderer.removeListener("menu:openSettings", listener);
  };
  api.onZoomChanged = (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("zoom:changed", listener);
    return () => ipcRenderer.removeListener("zoom:changed", listener);
  };
  api.onSessionRenamed = (cb: (e: { id: string; title: string }) => void) => {
    const listener = (_e: unknown, ev: { id: string; title: string }) => cb(ev);
    ipcRenderer.on("session:renamed", listener);
    return () => ipcRenderer.removeListener("session:renamed", listener);
  };
  api.onAgentSwitched = (cb: (e: { sessionId: string; agentId: string | null; frame: import("../shared/ipc.js").DisplayItem }) => void) => {
    const listener = (_e: unknown, ev: { sessionId: string; agentId: string | null; frame: import("../shared/ipc.js").DisplayItem }) => cb(ev);
    ipcRenderer.on("agents:switched", listener);
    return () => ipcRenderer.removeListener("agents:switched", listener);
  };
  api.onProductionEvent = (cb: (e: ProductionEvent) => void) => {
    const listener = (_e: unknown, ev: ProductionEvent) => cb(ev);
    ipcRenderer.on("production:event", listener);
    return () => ipcRenderer.removeListener("production:event", listener);
  };

  // The contract↔CascadeApi drift guard in shared/ipc.ts guarantees every
  // method this object carries is a real CascadeApi member, so the cast is
  // safe by construction.
  return api as unknown as CascadeApi;
}

contextBridge.exposeInMainWorld("cascade", buildApi());