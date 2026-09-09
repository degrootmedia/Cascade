/** Sessions + skills IPC channels. Fragment of ipcContract. */
export const sessionChannels = {
  "sessions:list": { method: "listSessions", kind: "invoke" },
  "sessions:load": { method: "loadSession", kind: "invoke" },
  "sessions:activate": { method: "activateSession", kind: "send" },
  "sessions:new": { method: "newSession", kind: "invoke" },
  "sessions:current": { method: "getCurrentSessionId", kind: "invoke" },
  "sessions:remove": { method: "removeSession", kind: "invoke" },
  "sessions:rename": { method: "renameSession", kind: "invoke" },

  "skills:list": { method: "listSkills", kind: "invoke" },
  "skills:openFolder": { method: "openSkillsFolder", kind: "invoke" },
  "workspace:instructions": { method: "getWorkspaceInstructions", kind: "invoke" },
  "workspace:openInstructions": { method: "openWorkspaceInstructions", kind: "invoke" },
} as const;
