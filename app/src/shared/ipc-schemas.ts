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
import { isGraphShotPatchField } from "./graph/shot-patch.js";

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

/** An optional caller-supplied base revision for structural commands. */
function checkOptionalRev(v: unknown): void {
  if (v === null || v === undefined) return;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error("IPC validation: baseRev must be a finite number");
  }
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
  "settings:setMaxIterations": (args) => {
    if (typeof args[0] !== "number" || !Number.isFinite(args[0])) {
      throw new Error("IPC validation: maxIterations must be a finite number");
    }
  },
  "production:create": (args) => {
    if (!isString(args[0]) || args[0].length === 0 || args[0].length > 256) {
      throw new Error("IPC validation: production name must be 1..256 chars");
    }
    checkPathString(args[1], "folder");
  },
  "production:selectGraphTake": (args) => {
    checkPathString(args[0], "productionId");
    checkPathString(args[1], "shotId");
    const req = args[2];
    if (!req || typeof req !== "object" || Array.isArray(req)) {
      throw new Error("IPC validation: selectGraphTake request must be an object");
    }
    const r = req as Record<string, unknown>;
    if (typeof r.path === "string") {
      if (r.path.length > 4096) throw new Error("IPC validation: selectGraphTake path too long");
      return;
    }
    if (r.kind === "unpipe") return;
    if (r.kind === "imagegen" || r.kind === "editgen" || r.kind === "upscale" || r.kind === "videogen") {
      if (typeof r.index !== "number" || !Number.isInteger(r.index) || r.index < 0) {
        throw new Error("IPC validation: selectGraphTake index must be a non-negative integer");
      }
      if (r.nodeId !== undefined && typeof r.nodeId !== "string") {
        throw new Error("IPC validation: selectGraphTake nodeId must be a string");
      }
      return;
    }
    throw new Error("IPC validation: selectGraphTake request shape invalid");
  },
  "production:updateGraphLayout": (args) => {
    checkPathString(args[0], "productionId");
    checkPathString(args[1], "shotId");
    const patch = args[2];
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("IPC validation: updateGraphLayout patch must be an object");
    }
    const p = patch as Record<string, unknown>;
    const xyMap = (v: unknown, what: string): void => {
      if (v === undefined) return;
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        throw new Error(`IPC validation: updateGraphLayout ${what} must be an object`);
      }
      for (const [k, pt] of Object.entries(v as Record<string, unknown>)) {
        if (typeof k !== "string" || k.length === 0 || k.length > 256) {
          throw new Error(`IPC validation: updateGraphLayout ${what} key must be 1..256 chars`);
        }
        if (!pt || typeof pt !== "object" || Array.isArray(pt)) {
          throw new Error(`IPC validation: updateGraphLayout ${what} values must be point/size objects`);
        }
        for (const coord of Object.values(pt as Record<string, unknown>)) {
          if (typeof coord !== "number" || !Number.isFinite(coord) || Math.abs(coord) > 100000) {
            throw new Error(`IPC validation: updateGraphLayout ${what} coordinates must be finite numbers`);
          }
        }
      }
    };
    xyMap(p.positions, "positions");
    xyMap(p.sizes, "sizes");
    if (p.waypoints !== undefined) {
      if (!p.waypoints || typeof p.waypoints !== "object" || Array.isArray(p.waypoints)) {
        throw new Error("IPC validation: updateGraphLayout waypoints must be an object");
      }
      for (const [k, pts] of Object.entries(p.waypoints as Record<string, unknown>)) {
        if (typeof k !== "string" || k.length === 0 || k.length > 256 || !Array.isArray(pts) || pts.length > 64) {
          throw new Error("IPC validation: updateGraphLayout waypoints must map edge ids to point arrays");
        }
        for (const pt of pts) {
          const q = pt as Record<string, unknown>;
          if (!q || typeof q !== "object" || typeof q.x !== "number" || typeof q.y !== "number" ||
            !Number.isFinite(q.x) || !Number.isFinite(q.y) || Math.abs(q.x) > 100000 || Math.abs(q.y) > 100000) {
            throw new Error("IPC validation: updateGraphLayout waypoint coordinates must be finite numbers");
          }
        }
      }
    }
    if (p.collapsed !== undefined) {
      if (!p.collapsed || typeof p.collapsed !== "object" || Array.isArray(p.collapsed)) {
        throw new Error("IPC validation: updateGraphLayout collapsed must be an object");
      }
      for (const [k, v] of Object.entries(p.collapsed as Record<string, unknown>)) {
        if (typeof k !== "string" || k.length === 0 || k.length > 256 || typeof v !== "boolean") {
          throw new Error("IPC validation: updateGraphLayout collapsed must map ids to booleans");
        }
      }
    }
    if (p.viewport !== undefined) {
      const v = p.viewport as Record<string, unknown>;
      if (!v || typeof v !== "object" || typeof v.x !== "number" || typeof v.y !== "number" || typeof v.zoom !== "number" ||
        !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.zoom)) {
        throw new Error("IPC validation: updateGraphLayout viewport must be {x,y,zoom} numbers");
      }
    }
    if (p.remove !== undefined) {
      if (!Array.isArray(p.remove) || p.remove.some((x) => typeof x !== "string")) {
        throw new Error("IPC validation: updateGraphLayout remove must be a string array");
      }
    }
  },
  "production:updateGraphShotFields": (args) => {
    checkPathString(args[0], "productionId");
    checkPathString(args[1], "shotId");
    const patch = args[2];
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("IPC validation: updateGraphShotFields patch must be an object");
    }
    for (const key of Object.keys(patch as Record<string, unknown>)) {
      if (!isGraphShotPatchField(key)) {
        throw new Error("IPC validation: updateGraphShotFields field not allowed: " + key);
      }
    }
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
        // A pending entry carries "" (no file yet — its vendor receipt is
        // the durable handle); any real path must stay production-relative.
        const pendingOnly = e.outputPath === "" && !!e.pending;
        if (!pendingOnly && typeof e.outputPath === "string" && !isProductionRelative(e.outputPath)) {
          throw new Error("IPC validation: suite entry outputPath must be production-relative (no '..')");
        }
      }
    }
  },
  "suite:deleteEntry": (args) => {
    checkPathString(args[0], "productionId", 256);
    checkPathString(args[1], "entryId", 256);
  },
  // Structural shot commands: an optional trailing base revision rejects a
  // stale destructive edit with a recoverable conflict (Phase 4). Insert
  // takes an optional caller-supplied shot id for retry-safe creation.
  "production:deleteShot": (args) => {
    checkPathString(args[0], "productionId", 256);
    checkPathString(args[1], "shotId", 256);
    checkOptionalRev(args[2]);
  },
  "production:reorderShot": (args) => {
    checkPathString(args[0], "productionId", 256);
    checkPathString(args[1], "shotId", 256);
    if (args[2] !== null && typeof args[2] !== "string") {
      throw new Error("IPC validation: reorderShot beforeShotId must be a string or null");
    }
    if (args[3] !== undefined && (typeof args[3] !== "number" || !Number.isFinite(args[3]))) {
      throw new Error("IPC validation: reorderShot endSceneNumber must be a finite number");
    }
    checkOptionalRev(args[4]);
  },
  "production:removeOutdatedShot": (args) => {
    checkPathString(args[0], "productionId", 256);
    checkPathString(args[1], "shotId", 256);
    checkOptionalRev(args[2]);
  },
  "production:deleteShotSequence": (args) => {
    checkPathString(args[0], "productionId", 256);
    checkPathString(args[1], "sequenceId", 256);
    checkOptionalRev(args[2]);
  },
  "production:insertShot": (args) => {
    checkPathString(args[0], "productionId", 256);
    if (args[3] !== undefined && (typeof args[3] !== "string" || (args[3] as string).length > 256)) {
      throw new Error("IPC validation: insertShot shotId must be a string up to 256 chars");
    }
  },
  "suite:exportEntry": (args) => {
    checkPathString(args[0], "productionId", 256);
    checkPathString(args[1], "entryId", 256);
    if (args[2] !== "references" && args[2] !== "boards") throw new Error("IPC validation: suite export target must be 'references' or 'boards'");
    if (args[3] !== undefined && (typeof args[3] !== "string" || args[3].length > 128)) throw new Error("IPC validation: suite export name must be a string of at most 128 chars");
    if (args[4] !== undefined && (typeof args[4] !== "string" || args[4].length > 256)) throw new Error("IPC validation: suite export categoryId must be a string of at most 256 chars");
  },
  "suite:recheckEntry": (args) => {
    checkPathString(args[0], "productionId", 256);
    checkPathString(args[1], "entryId", 256);
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
