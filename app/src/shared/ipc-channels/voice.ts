/** Voice input (local Whisper) IPC channels. Fragment of ipcContract. */
export const voiceChannels = {
  "voice:status": { method: "getVoiceStatus", kind: "invoke" },
  "voice:prepare": { method: "prepareVoice", kind: "invoke" },
  "voice:transcribe": { method: "transcribeVoice", kind: "invoke" },
  "voice:getEnabled": { method: "getVoiceEnabled", kind: "invoke" },
  "voice:setEnabled": { method: "setVoiceEnabled", kind: "invoke" },
  "voice:getModel": { method: "getWhisperModel", kind: "invoke" },
  "voice:setModel": { method: "setWhisperModel", kind: "invoke" },
  "voice:getCliBinary": { method: "getVoiceCliBinary", kind: "invoke" },
  "voice:setCliBinary": { method: "setVoiceCliBinary", kind: "invoke" },
} as const;
