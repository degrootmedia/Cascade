/** MCP + media-vendor IPC channels. Fragment of ipcContract. */
export const mcpChannels = {
  "mcp:getConfig": { method: "getMcpConfig", kind: "invoke" },
  "mcp:setConfig": { method: "setMcpConfig", kind: "invoke" },
  "mcp:status": { method: "getMcpStatus", kind: "invoke" },
  "mcp:reload": { method: "reloadMcp", kind: "invoke" },
  "mcp:onDemand": { method: "getMcpOnDemand", kind: "invoke" },
  "mcp:setOnDemand": { method: "setMcpOnDemand", kind: "invoke" },
  "media:listProviders": { method: "listMediaProviders", kind: "invoke" },
  "media:getProvider": { method: "getMediaProvider", kind: "invoke" },
  "media:setProvider": { method: "setMediaProvider", kind: "invoke" },
} as const;
