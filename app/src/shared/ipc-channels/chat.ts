/** Chat-domain IPC channels. Fragment of ipcContract (assembled in ../ipc.ts). */
export const chatChannels = {
  "chat:send": { method: "sendMessage", kind: "invoke" },
  "chat:stop": { method: "stop", kind: "send" },
  "chat:undo": { method: "undoLast", kind: "invoke" },
  "chat:setPlanMode": { method: "setPlanMode", kind: "invoke" },
  "chat:getPlanMode": { method: "getPlanMode", kind: "invoke" },
  "approval:response": { method: "respondApproval", kind: "send" },
  "display:sync": { method: "syncDisplay", kind: "send" },
} as const;
