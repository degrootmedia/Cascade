/** Session goal IPC channels. Fragment of ipcContract (assembled in ../ipc.ts). */
export const goalChannels = {
  "goals:get": { method: "getSessionGoal", kind: "invoke" },
  "goals:set": { method: "setSessionGoal", kind: "invoke" },
} as const;
