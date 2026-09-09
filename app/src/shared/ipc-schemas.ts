/**
 * Runtime IPC payload validation (main side). TypeScript types are erased at
 * runtime, so a compromised or buggy renderer can send any shape over
 * `ipcRenderer.invoke` — these validators run before the handler does.
 *
 * Each entry maps a channel to a function that checks the raw arg array and
 * throws on invalid payloads. Channels without an entry get a generic
 * NUL-byte / length guard via `validateIpcArgs`.
 */

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
};

/** Validate raw invoke/send args for a channel. Throws on invalid payloads. */
export function validateIpcArgs(channel: string, args: unknown[]): void {
  for (const a of args) checkNoNul(a);
  validators[channel]?.(args);
}
