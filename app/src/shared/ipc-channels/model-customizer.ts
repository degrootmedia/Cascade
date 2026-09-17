/** Dev Model Customizer IPC channels. Fragment of ipcContract. */
export const modelCustomizerChannels = {
  "modelCustomizer:getExposure": { method: "getModelOptionExposure", kind: "invoke" },
  "modelCustomizer:setExposure": { method: "setModelOptionExposure", kind: "invoke" },
  "modelCustomizer:resetExposure": { method: "resetModelOptionExposure", kind: "invoke" },
  "modelCustomizer:getSurfaces": { method: "getModelSurfaces", kind: "invoke" },
  "modelCustomizer:setSurfaces": { method: "setModelSurfaces", kind: "invoke" },
  "modelCustomizer:resetSurfaces": { method: "resetModelSurfaces", kind: "invoke" },
  "modelCustomizer:getParamDefaults": { method: "getModelParamDefaults", kind: "invoke" },
  "modelCustomizer:setParamDefault": { method: "setModelParamDefault", kind: "invoke" },
  "modelCustomizer:resetParamDefaults": { method: "resetModelParamDefaults", kind: "invoke" },
  "modelCustomizer:probeModels": { method: "probeModels", kind: "invoke" },
  "modelCustomizer:probeOptions": { method: "probeModelOptions", kind: "invoke" },
  "modelCustomizer:refresh": { method: "refreshModelProbe", kind: "invoke" },
  "modelCustomizer:getCreditRate": { method: "getHiggsfieldCreditRate", kind: "invoke" },
  "modelCustomizer:setCreditRate": { method: "setHiggsfieldCreditRate", kind: "invoke" },
} as const;
