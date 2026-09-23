/**
 * Runtime IPC payload validation (main side). TypeScript types are erased at
 * runtime, so a compromised or buggy renderer can send any shape over
 * `ipcRenderer.invoke` — these validators run before the handler does.
 *
 * Each entry maps a channel to a function that checks the raw arg array and
 * throws on invalid payloads. Channels without an entry get a generic
 * NUL-byte / length guard via `validateIpcArgs`.
 */

import { isProductionRelative, type SuiteSession } from "./ipc/suite.js";
import { normalizeCanvasBusy } from "./ipc/window.js";
import { normalizeGraphSource } from "./ipc/camera-grid.js";

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function checkPathString(v: unknown, what: string, max = 4096): string {
  if (!isString(v) || v.length === 0 || v.length > max) {
    throw new Error(`IPC validation: ${what} must be a string of 1..${max} chars`);
  }
  if (v.includes("\0")) throw new Error(`IPC validation: ${what} contains a NUL byte`);
  return v;
}

function checkOptionalPathString(v: unknown, what: string, max = 4096): string | null {
  if (v === null || v === undefined) return null;
  return checkPathString(v, what, max);
}

/** Generic guard applied to every channel: no NUL bytes in strings. */
function checkNoNul(v: unknown, depth = 0): void {
  if (depth > 10) return;
  if (typeof v === "string" && v.includes("\0")) {
    throw new Error("IPC validation: payload contains a NUL byte");
  }
  if (Array.isArray(v)) {
    for (const item of v) checkNoNul(item, depth + 1);
    return;
  }
  if (v && typeof v === "object") {
    for (const item of Object.values(v as Record<string, unknown>)) checkNoNul(item, depth + 1);
  }
}

const validators: Record<string, (args: unknown[]) => void> = {
  "settings:setExternalEditor": (args) => {
    checkOptionalPathString(args[0], "externalEditor");
  },
  "settings:setPromptTemplates": (args) => {
    const o = args[0];
    if (!o || typeof o !== "object" || Array.isArray(o)) {
      throw new Error("IPC validation: prompt templates must be an object");
    }
    for (const [key, value] of Object.entries(o as Record<string, unknown>)) {
      if (typeof key !== "string" || key.length === 0 || key.length > 64) {
        throw new Error("IPC validation: prompt template key must be 1..64 chars");
      }
      if (typeof value !== "string" || value.length > 20000) {
        throw new Error("IPC validation: prompt template value must be a string (max 20000 chars)");
      }
    }
  },
  "production:create": (args) => {
    if (!isString(args[0]) || args[0].length === 0 || args[0].length > 256) {
      throw new Error("IPC validation: production name must be 1..256 chars");
    }
    checkPathString(args[1], "folder");
  },
  "production:import": (args) => {
    checkPathString(args[0], "folder");
  },
  "mcp:setConfig": (args) => {
    if (!isString(args[0]) || args[0].length > 1024 * 1024) {
      throw new Error("IPC validation: MCP config must be a string up to 1MB");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(args[0]);
    } catch {
      throw new Error("IPC validation: MCP config is not valid JSON");
    }
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (typeof servers !== "object" || servers === null) {
      throw new Error('IPC validation: MCP config must have an "mcpServers" object');
    }
  },
  "workspace:setSession": (args) => {
    checkPathString(args[0], "dir");
  },
  "image:showInFolder": (args) => {
    const o = args[0] as { productionId?: unknown; relPath?: unknown; src?: unknown } | undefined;
    if (!o || typeof o !== "object") throw new Error("IPC validation: image:showInFolder expects an options object");
    if (o.productionId !== undefined) checkOptionalPathString(o.productionId, "productionId", 256);
    if (o.relPath !== undefined) checkOptionalPathString(o.relPath, "relPath");
    if (o.src !== undefined) checkOptionalPathString(o.src, "src", 8192);
  },
  // Image suite: reject any entry path that could escape the production root
  // before it is written or served (`assetPath` re-checks containment).
  "suite:loadSession": (args) => {
    checkPathString(args[0], "productionId", 256);
  },
  "suite:saveSession": (args) => {
    checkPathString(args[0], "productionId", 256);
    const s = args[1] as SuiteSession | undefined;
    if (s && Array.isArray(s.entries)) {
      for (const e of s.entries) {
        if (!e || typeof e !== "object") continue;
        if (typeof e.outputPath === "string" && !isProductionRelative(e.outputPath)) {
          throw new Error("IPC validation: suite entry outputPath must be production-relative (no '..')");
        }
      }
    }
  },
  "suite:deleteEntry": (args) => {
    checkPathString(args[0], "productionId", 256);
    checkPathString(args[1], "entryId", 256);
  },
  "suite:exportEntry": (args) => {
    checkPathString(args[0], "productionId", 256);
    checkPathString(args[1], "entryId", 256);
    if (args[2] !== "references" && args[2] !== "boards") throw new Error("IPC validation: suite export target must be 'references' or 'boards'");
  },
  "suite:generate": (args) => {
    checkPathString(args[0], "productionId", 256);
  },
  // Detached canvas (Spec 03): the target must be one of the two canvases and
  // the production id a real id — the main handler re-validates before sending.
  "window:openDetachedCanvas": (args) => {
    const o = args[0] as { productionId?: unknown; target?: unknown; frameId?: unknown } | undefined;
    if (!o || typeof o !== "object") throw new Error("IPC validation: window:openDetachedCanvas expects a context object");
    checkPathString(o.productionId, "productionId", 256);
    if (o.target !== "graph" && o.target !== "moodboard") {
      throw new Error('IPC validation: detached canvas target must be "graph" or "moodboard"');
    }
    if (o.frameId !== null && o.frameId !== undefined && typeof o.frameId !== "string") {
      throw new Error("IPC validation: detached canvas frameId must be a string or null");
    }
  },
  "canvas:selectionChanged": (args) => {
    if (args[0] !== null && args[0] !== undefined && typeof args[0] !== "string") {
      throw new Error("IPC validation: canvas selection frameId must be a string or null");
    }
  },
  // Cross-window in-flight canvas jobs (Spec 03): main relays the sanitized
  // snapshot to the sibling window, so the shape is validated here.
  "canvas:busyChanged": (args) => {
    normalizeCanvasBusy(args[0]);
  },
  // Camera grid (Spec 04): the sheet path must be production-relative (main
  // re-validates containment via assetPath) and every crop rect a finite
  // normalized number.
  "cameraGrid:generate": (args) => {
    checkPathString(args[0], "productionId", 256);
    checkPathString(args[1], "shotId", 256);
  },
  // Camera grid grid-image import: ids plus a valid graph-source descriptor
  // (image node / edit node / reference) main resolves to the sheet bytes.
  "cameraGrid:importGridImage": (args) => {
    checkPathString(args[0], "productionId", 256);
    checkPathString(args[1], "shotId", 256);
    if (!normalizeGraphSource(args[2])) {
      throw new Error("IPC validation: cameraGrid:importGridImage expects a graph source object");
    }
  },
  // Upscale node: production/shot ids must be real ids; the handler reads the
  // node's source wiring from the shot and re-validates the model.
  "production:generateUpscaleNode": (args) => {
    checkPathString(args[0], "productionId", 256);
    checkPathString(args[1], "shotId", 256);
    const o = args[2] as { model?: unknown; resolution?: unknown } | undefined;
    if (!o || typeof o !== "object") {
      throw new Error("IPC validation: generateUpscaleNode expects an options object");
    }
  },
  "cameraGrid:cutout": (args) => {
    const r = args[0] as {
      productionId?: unknown;
      shotId?: unknown;
      nodeId?: unknown;
      sheetPath?: unknown;
      rects?: unknown;
      labels?: unknown;
    } | undefined;
    if (!r || typeof r !== "object") throw new Error("IPC validation: cameraGrid:cutout expects a request object");
    checkPathString(r.productionId, "productionId", 256);
    checkPathString(r.shotId, "shotId", 256);
    checkPathString(r.nodeId, "nodeId", 256);
    if (typeof r.sheetPath !== "string" || !isProductionRelative(r.sheetPath)) {
      throw new Error("IPC validation: camera grid sheetPath must be production-relative (no '..')");
    }
    if (!Array.isArray(r.rects) || r.rects.length === 0 || r.rects.length > 64) {
      throw new Error("IPC validation: camera grid rects must be a non-empty array (max 64)");
    }
    for (const rect of r.rects) {
      if (!rect || typeof rect !== "object") throw new Error("IPC validation: camera grid rect must be an object");
      for (const k of ["x", "y", "w", "h"] as const) {
        const v = (rect as Record<string, unknown>)[k];
        if (typeof v !== "number" || !Number.isFinite(v)) {
          throw new Error(`IPC validation: camera grid rect.${k} must be a finite number`);
        }
      }
    }
    if (r.labels !== undefined && (!Array.isArray(r.labels) || r.labels.some((l) => typeof l !== "string"))) {
      throw new Error("IPC validation: camera grid labels must be strings");
    }
  },
};

/** Validate raw invoke/send args for a channel. Throws on invalid payloads. */
export function validateIpcArgs(channel: string, args: unknown[]): void {
  for (const a of args) checkNoNul(a);
  validators[channel]?.(args);
}
