import { contextBridge, ipcRenderer } from "electron";
import type { CascadeApi, ChatEvent, ApprovalRequestIpc, ApprovalDecisionIpc, ProductionEvent } from "../shared/ipc.js";

const api: CascadeApi = {
  sendMessage: (sessionId, text, images) => ipcRenderer.invoke("chat:send", sessionId, text, images),
  stop: (sessionId) => ipcRenderer.send("chat:stop", sessionId),
  undoLast: (sessionId) => ipcRenderer.invoke("chat:undo", sessionId),
  respondApproval: (id: number, decision: ApprovalDecisionIpc) =>
    ipcRenderer.send("approval:response", id, decision),

  onAgentEvent(cb: (e: ChatEvent) => void) {
    const listener = (_e: unknown, ev: ChatEvent) => cb(ev);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  onApprovalRequest(cb: (req: ApprovalRequestIpc) => void) {
    const listener = (_e: unknown, req: ApprovalRequestIpc) => cb(req);
    ipcRenderer.on("approval:request", listener);
    return () => ipcRenderer.removeListener("approval:request", listener);
  },
  onMentionAdded(cb: (e: { sessionId: string; dataUrl: string; filename: string }) => void) {
    const listener = (_e: unknown, e: { sessionId: string; dataUrl: string; filename: string }) => cb(e);
    ipcRenderer.on("mention:added", listener);
    return () => ipcRenderer.removeListener("mention:added", listener);
  },

  pickWorkspace: () => ipcRenderer.invoke("workspace:pick"),
  pickSessionWorkspace: () => ipcRenderer.invoke("workspace:pickSession"),
  setSessionWorkspace: (dir) => ipcRenderer.invoke("workspace:setSession", dir),
  getRecentWorkspaces: () => ipcRenderer.invoke("workspace:recent"),
  getCurrentWorkspace: () => ipcRenderer.invoke("workspace:current"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setApiKey: (key) => ipcRenderer.invoke("settings:setApiKey", key),
  setModel: (model) => ipcRenderer.invoke("settings:setModel", model),
  setAccent: (color) => ipcRenderer.invoke("settings:setAccent", color),
  onOpenSettings(cb: () => void) {
    const listener = () => cb();
    ipcRenderer.on("menu:openSettings", listener);
    return () => ipcRenderer.removeListener("menu:openSettings", listener);
  },
  onZoomChanged(cb: () => void) {
    const listener = () => cb();
    ipcRenderer.on("zoom:changed", listener);
    return () => ipcRenderer.removeListener("zoom:changed", listener);
  },
  listModels: () => ipcRenderer.invoke("models:list"),
  getCredits: () => ipcRenderer.invoke("credits:get"),

  listSessions: () => ipcRenderer.invoke("sessions:list"),
  loadSession: (id) => ipcRenderer.invoke("sessions:load", id),
  activateSession: (id) => ipcRenderer.send("sessions:activate", id),
  newSession: () => ipcRenderer.invoke("sessions:new"),
  getCurrentSessionId: () => ipcRenderer.invoke("sessions:current"),
  removeSession: (id, mode) => ipcRenderer.invoke("sessions:remove", id, mode),
  renameSession: (id) => ipcRenderer.invoke("sessions:rename", id),
  onSessionRenamed(cb: (e: { id: string; title: string }) => void) {
    const listener = (_e: unknown, ev: { id: string; title: string }) => cb(ev);
    ipcRenderer.on("session:renamed", listener);
    return () => ipcRenderer.removeListener("session:renamed", listener);
  },

  listSkills: () => ipcRenderer.invoke("skills:list"),
  openSkillsFolder: () => ipcRenderer.invoke("skills:openFolder"),

  getWorkspaceInstructions: () => ipcRenderer.invoke("workspace:instructions"),
  openWorkspaceInstructions: () => ipcRenderer.invoke("workspace:openInstructions"),

  getMcpConfig: () => ipcRenderer.invoke("mcp:getConfig"),
  setMcpConfig: (text) => ipcRenderer.invoke("mcp:setConfig", text),
  getMcpStatus: () => ipcRenderer.invoke("mcp:status"),
  reloadMcp: () => ipcRenderer.invoke("mcp:reload"),
  getMcpOnDemand: () => ipcRenderer.invoke("mcp:onDemand"),
  setMcpOnDemand: (names) => ipcRenderer.invoke("mcp:setOnDemand", names),

  listAgents: () => ipcRenderer.invoke("agents:list"),
  getAgent: (id: string) => ipcRenderer.invoke("agents:get", id),
  createAgent: (data: unknown) => ipcRenderer.invoke("agents:create", data),
  updateAgent: (id: string, patch: unknown) => ipcRenderer.invoke("agents:update", id, patch),
  uploadAgentAvatar: (id: string, dataUrl: string) => ipcRenderer.invoke("agents:uploadAvatar", id, dataUrl),
  duplicateAgent: (id: string) => ipcRenderer.invoke("agents:duplicate", id),
  removeAgent: (id: string, mode: "delete" | "archive") => ipcRenderer.invoke("agents:remove", id, mode),
  exportAgent: (id: string) => ipcRenderer.invoke("agents:export", id),
  importAgent: (json: string, md: string) => ipcRenderer.invoke("agents:import", json, md),
  getSessionAgent: (sessionId: string) => ipcRenderer.invoke("agents:getSessionAgent", sessionId),
  setSessionAgent: (sessionId: string, agentId: string | null) => ipcRenderer.invoke("agents:setSessionAgent", sessionId, agentId),
  onAgentSwitched(cb: (e: { sessionId: string; agentId: string | null; frame: unknown }) => void) {
    const listener = (_e: unknown, ev: { sessionId: string; agentId: string | null; frame: unknown }) => cb(ev);
    ipcRenderer.on("agents:switched", listener);
    return () => ipcRenderer.removeListener("agents:switched", listener);
  },

  /* Production Assistant */
  listProductions: () => ipcRenderer.invoke("production:list"),
  pickProductionFolder: () => ipcRenderer.invoke("production:pickFolder"),
  createProduction: (name, folder) => ipcRenderer.invoke("production:create", name, folder),
  loadProduction: (id) => ipcRenderer.invoke("production:load", id),
  saveProduction: (p) => ipcRenderer.invoke("production:save", p),
  removeProduction: (id, mode) => ipcRenderer.invoke("production:remove", id, mode),
  pickScriptFile: () => ipcRenderer.invoke("production:pickScriptFile"),
  pickReferenceImage: () => ipcRenderer.invoke("production:pickReferenceImage"),
  addReferenceMedia: (productionId: string, fileName: string, mime: string, bytes: ArrayBuffer) => ipcRenderer.invoke("production:addReferenceMedia", productionId, fileName, mime, bytes),
  addReferenceImage: (productionId: string, fileName: string, dataUrl: string) => ipcRenderer.invoke("production:addReferenceImage", productionId, fileName, dataUrl),
  removeReferenceFile: (productionId: string, rel: string) => ipcRenderer.invoke("production:removeReferenceFile", productionId, rel),
  ingestScript: (productionId, source) => ipcRenderer.invoke("production:ingest", productionId, source),
  refineStylePrompt: (productionId, style) => ipcRenderer.invoke("production:refineStyle", productionId, style),
  generateStyles: (productionId, notes) => ipcRenderer.invoke("production:generateStyles", productionId, notes),
  styleFromImage: (productionId, imageDataUrl) => ipcRenderer.invoke("production:styleFromImage", productionId, imageDataUrl),
  insertShot: (productionId, sceneNumber, index) => ipcRenderer.invoke("production:insertShot", productionId, sceneNumber, index),
  deleteShot: (productionId, shotId) => ipcRenderer.invoke("production:deleteShot", productionId, shotId),
  updateShot: (productionId, shotId, patch) => ipcRenderer.invoke("production:updateShot", productionId, shotId, patch),
  generateBoards: (productionId, opts) => ipcRenderer.invoke("production:generateBoards", productionId, opts),
  regenerateBoard: (productionId, shotId) => ipcRenderer.invoke("production:regenerateBoard", productionId, shotId),
  regenerateBoards: (productionId, shotIds) => ipcRenderer.invoke("production:regenerateBoards", productionId, shotIds),
  exportBoardPrompts: (productionId) => ipcRenderer.invoke("production:boardPrompts", productionId),
  getBoardPrompt: (productionId, shotId) => ipcRenderer.invoke("production:boardPrompt", productionId, shotId),
  updateBoardPrompt: (productionId, shotId, prompt) => ipcRenderer.invoke("production:updateBoardPrompt", productionId, shotId, prompt),
  refreshBoardPrompt: (productionId, shotId) => ipcRenderer.invoke("production:refreshBoardPrompt", productionId, shotId),
  listOpenArtModels: () => ipcRenderer.invoke("production:openArtModels"),
  getOpenArtCredits: () => ipcRenderer.invoke("production:openArtCredits"),
  pickBoardImages: () => ipcRenderer.invoke("production:pickBoardImages"),
  importBoards: (productionId, files, shotId) => ipcRenderer.invoke("production:importBoards", productionId, files, shotId),
  boardImage: (productionId, shotId, index) => ipcRenderer.invoke("production:boardImage", productionId, shotId, index),
  boardImageFull: (productionId, shotId, index) => ipcRenderer.invoke("production:boardImageFull", productionId, shotId, index),
  boardThumbnail: (productionId, shotId, index) => ipcRenderer.invoke("production:boardThumbnail", productionId, shotId, index),
  deleteBoardImage: (productionId, shotId) => ipcRenderer.invoke("production:deleteBoardImage", productionId, shotId),
  editBoard: (productionId, shotId, model, prompt) => ipcRenderer.invoke("production:editBoard", productionId, shotId, model, prompt),
  promoteBoardHistory: (productionId, shotId, index) => ipcRenderer.invoke("production:promoteBoardHistory", productionId, shotId, index),
  generateVideo: (productionId, shotId, opts) => ipcRenderer.invoke("production:generateVideo", productionId, shotId, opts),
  generateFrameNode: (productionId, shotId, opts) => ipcRenderer.invoke("production:generateFrameNode", productionId, shotId, opts),
  generateVideoNode: (productionId, shotId, opts) => ipcRenderer.invoke("production:generateVideoNode", productionId, shotId, opts),
  applyGraphOutput: (productionId, shotId, opts) => ipcRenderer.invoke("production:applyGraphOutput", productionId, shotId, opts),
  applyGraphRefOutput: (productionId, shotId, refId) => ipcRenderer.invoke("production:applyGraphRefOutput", productionId, shotId, refId),
  videoUrl: (productionId, shotId) => ipcRenderer.invoke("production:videoUrl", productionId, shotId),
  removeVideo: (productionId, shotId) => ipcRenderer.invoke("production:removeVideo", productionId, shotId),
  videoModelOptions: (modelId, withImage) => ipcRenderer.invoke("production:videoModelOptions", modelId, withImage),
  planAnimatic: (productionId) => ipcRenderer.invoke("production:planAnimatic", productionId),
  listAudioModels: () => ipcRenderer.invoke("production:listAudioModels"),
  generateVoiceover: (productionId, opts) => ipcRenderer.invoke("production:generateVoiceover", productionId, opts),
  importVoiceover: (productionId) => ipcRenderer.invoke("production:importVoiceover", productionId),
  voiceoverFile: (productionId) => ipcRenderer.invoke("production:voiceoverFile", productionId),
  voiceoverUrl: (productionId) => ipcRenderer.invoke("production:voiceoverUrl", productionId),
  removeVoiceover: (productionId) => ipcRenderer.invoke("production:removeVoiceover", productionId),
  importMusic: (productionId) => ipcRenderer.invoke("production:importMusic", productionId),
  generateMusic: (productionId, opts) => ipcRenderer.invoke("production:generateMusic", productionId, opts),
  musicFile: (productionId) => ipcRenderer.invoke("production:musicFile", productionId),
  musicUrl: (productionId) => ipcRenderer.invoke("production:musicUrl", productionId),
  removeMusic: (productionId) => ipcRenderer.invoke("production:removeMusic", productionId),
  onProductionEvent(cb: (e: ProductionEvent) => void) {
    const listener = (_e: unknown, ev: ProductionEvent) => cb(ev);
    ipcRenderer.on("production:event", listener);
    return () => ipcRenderer.removeListener("production:event", listener);
  },
};

contextBridge.exposeInMainWorld("cascade", api);

// Renderer pushes display items for persistence, tagged with the chat id.
contextBridge.exposeInMainWorld("cascadeSync", {
  syncDisplay: (sessionId: string, display: unknown[]) => ipcRenderer.send("display:sync", sessionId, display),
});
