/** Session todo-list IPC channel. Fragment of ipcContract (assembled in ../ipc.ts). */
export const todoChannels = {
  "todos:get": { method: "getSessionTodos", kind: "invoke" },
} as const;
