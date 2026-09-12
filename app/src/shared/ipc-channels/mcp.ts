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
  "media:getCredits": { method: "getMediaCredits", kind: "invoke" },
  "media:getHiggsCliBinary": { method: "getHiggsfieldCliBinary", kind: "invoke" },
  "media:setHiggsCliBinary": { method: "setHiggsfieldCliBinary", kind: "invoke" },
  "media:getHiggsCliStatus": { method: "getHiggsfieldCliStatus", kind: "invoke" },
  "media:getOpenArtCliBinary": { method: "getOpenArtCliBinary", kind: "invoke" },
  "media:setOpenArtCliBinary": { method: "setOpenArtCliBinary", kind: "invoke" },
  "media:getOpenArtCliStatus": { method: "getOpenArtCliStatus", kind: "invoke" },
} as const;
