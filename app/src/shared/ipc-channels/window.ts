/** Detached canvas window IPC channels (Spec 03). Fragment of ipcContract.
 *
 *  `window:*` are request/response; `canvas:selectionChanged` is a
 *  fire-and-forget send from the main window's frame selection (kept as a send
 *  so following the selection stays snappy). The main→renderer events
 *  (`canvas:context`, `canvas:selectionChanged`, `canvas:busyChanged`,
 *  `window:detachedClosed`) are hand-wired subscriptions in preload, like every
 *  other `on*` method. */
export const windowChannels = {
  "window:openDetachedCanvas": { method: "openDetachedCanvas", kind: "invoke" },
  "window:closeDetachedCanvas": { method: "closeDetachedCanvas", kind: "invoke" },
  "window:detachedState": { method: "getDetachedCanvasState", kind: "invoke" },
  "canvas:selectionChanged": { method: "canvasSelectionChanged", kind: "send" },
  "canvas:busyChanged": { method: "canvasBusyChanged", kind: "send" },
} as const;
