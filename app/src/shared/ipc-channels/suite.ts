/** Image Generation & Editing Suite IPC channels. Fragment of ipcContract. */
export const suiteChannels = {
  "suite:loadSession": { method: "loadSuiteSession", kind: "invoke" },
  "suite:saveSession": { method: "saveSuiteSession", kind: "invoke" },
  "suite:deleteEntry": { method: "deleteSuiteEntry", kind: "invoke" },
  "suite:exportEntry": { method: "exportSuiteEntry", kind: "invoke" },
  "suite:generate": { method: "generateSuiteImage", kind: "invoke" },
} as const;
