/** 16-panel camera-grid node IPC channels (Spec 04). Fragment of ipcContract. */
export const cameraGridChannels = {
  "cameraGrid:generate": { method: "generateCameraGrid", kind: "invoke" },
  "cameraGrid:importGridImage": { method: "importCameraGridImage", kind: "invoke" },
  "cameraGrid:cutout": { method: "cutoutCameraGrid", kind: "invoke" },
} as const;
