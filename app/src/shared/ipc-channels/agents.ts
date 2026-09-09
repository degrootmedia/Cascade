/** Agents IPC channels. Fragment of ipcContract. */
export const agentChannels = {
  "agents:list": { method: "listAgents", kind: "invoke" },
  "agents:get": { method: "getAgent", kind: "invoke" },
  "agents:create": { method: "createAgent", kind: "invoke" },
  "agents:update": { method: "updateAgent", kind: "invoke" },
  "agents:uploadAvatar": { method: "uploadAgentAvatar", kind: "invoke" },
  "agents:duplicate": { method: "duplicateAgent", kind: "invoke" },
  "agents:remove": { method: "removeAgent", kind: "invoke" },
  "agents:export": { method: "exportAgent", kind: "invoke" },
  "agents:import": { method: "importAgent", kind: "invoke" },
  "agents:getSessionAgent": { method: "getSessionAgent", kind: "invoke" },
  "agents:setSessionAgent": { method: "setSessionAgent", kind: "invoke" },
} as const;
