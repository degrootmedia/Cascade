/**
 * MCP server configuration grammar: the Claude Desktop-compatible document
 * ({ "mcpServers": { name: { command, args?, env?, envPassthrough? } | { url } } })
 * plus the pure parse/serialize/edit helpers the Settings UI and main's
 * `McpManager` share. The document text is the wire format
 * (`mcp:getConfig` / `mcp:setConfig`), so this is the one home for its shape —
 * the friendly form editor and the advanced raw-JSON editor both round-trip
 * through here instead of hand-rolling `mcpServers` objects.
 */

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Opt-in passthrough of parent env vars by name (e.g. GITHUB_TOKEN). */
  envPassthrough?: string[];
  url?: string;
  disabled?: boolean;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export type McpTransport = "stdio" | "http";

export type McpConfigParseResult =
  | { ok: true; file: McpConfigFile }
  | { ok: false; error: string };

export function emptyMcpConfig(): McpConfigFile {
  return { mcpServers: {} };
}

/** A server talks HTTP when it declares a `url`, else stdio via `command`. */
export function mcpTransport(server: McpServerConfig): McpTransport {
  return server.url?.trim() ? "http" : "stdio";
}

export function mcpServerEntries(file: McpConfigFile): { name: string; server: McpServerConfig }[] {
  return Object.entries(file.mcpServers).map(([name, server]) => ({ name, server }));
}

export function blankMcpServer(transport: McpTransport): McpServerConfig {
  return transport === "http" ? { url: "" } : { command: "" };
}

/**
 * Tolerant decode of the config text. Invalid JSON, a missing/non-object
 * `mcpServers`, or a non-object server entry yields a readable error (the raw
 * editor keeps the user's text); a valid document yields the structured file.
 * A JSON `null` from a hand-edited file is treated as an empty config.
 */
export function parseMcpConfigText(text: string): McpConfigParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, file: emptyMcpConfig() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "This isn't valid JSON." };
  }
  if (parsed === null) return { ok: true, file: emptyMcpConfig() };
  if (typeof parsed !== "object") return { ok: false, error: "The config must be a JSON object." };
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (servers === undefined) return { ok: true, file: emptyMcpConfig() };
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return { ok: false, error: 'The config needs an "mcpServers" object.' };
  }
  for (const value of Object.values(servers as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: 'Each entry under "mcpServers" must be an object.' };
    }
  }
  return { ok: true, file: { mcpServers: servers as Record<string, McpServerConfig> } };
}

/** Pretty-print the document in the shape Claude Desktop expects. */
export function serializeMcpConfig(file: McpConfigFile): string {
  return JSON.stringify({ mcpServers: file.mcpServers }, null, 2);
}

/**
 * Drop blank optional fields (and the unused transport's fields) before saving,
 * while preserving any unknown keys a hand-written config may carry.
 */
export function cleanMcpServer(server: McpServerConfig): McpServerConfig {
  const out: McpServerConfig = { ...server };

  const url = out.url?.trim();
  if (url) out.url = url;
  else delete out.url;

  const command = out.command?.trim();
  if (command) out.command = command;
  else delete out.command;

  const args = (out.args ?? []).map((a) => a.trim()).filter(Boolean);
  if (args.length) out.args = args;
  else delete out.args;

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(out.env ?? {})) {
    const key = k.trim();
    if (key) env[key] = v.trim();
  }
  if (Object.keys(env).length) out.env = env;
  else delete out.env;

  const passthrough = (out.envPassthrough ?? []).map((n) => n.trim()).filter(Boolean);
  if (passthrough.length) out.envPassthrough = passthrough;
  else delete out.envPassthrough;

  if (!out.disabled) delete out.disabled;

  // A server is one transport or the other — never carry the loser's fields.
  if (out.url) {
    delete out.command;
    delete out.args;
  } else {
    delete out.url;
  }
  return out;
}

/** Insert or replace a server, keeping the target's position on rename/edit. */
export function upsertMcpServer(
  file: McpConfigFile,
  name: string,
  server: McpServerConfig,
  previousName?: string
): McpConfigFile {
  const target = name.trim();
  const next: Record<string, McpServerConfig> = {};
  let placed = false;
  for (const [key, value] of Object.entries(file.mcpServers)) {
    const isTarget = key === previousName || key === target;
    if (isTarget) {
      if (!placed) {
        next[target] = server;
        placed = true;
      }
      continue;
    }
    next[key] = value;
  }
  if (!placed) next[target] = server;
  return { mcpServers: next };
}

export function removeMcpServer(file: McpConfigFile, name: string): McpConfigFile {
  const next = { ...file.mcpServers };
  delete next[name];
  return { mcpServers: next };
}

/**
 * Form-level validation. `existingNames` should already exclude the name being
 * edited, so renaming a server onto its own name is allowed.
 */
export function validateMcpServer(
  name: string,
  server: McpServerConfig,
  existingNames: string[] = [],
  transport: McpTransport = mcpTransport(server)
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the server a name.";
  if (existingNames.includes(trimmed)) return `A server named “${trimmed}” already exists.`;
  if (transport === "http") {
    const url = (server.url ?? "").trim();
    if (!url) return "Enter the server URL.";
    if (!/^https?:\/\//i.test(url)) return "The URL must start with http:// or https://.";
  } else if (!(server.command ?? "").trim()) {
    return "Enter the command that launches the server.";
  }
  return null;
}

/** Arguments: one per line. */
export function argsToLines(args: string[] | undefined): string {
  return (args ?? []).join("\n");
}

export function linesToArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Environment: `KEY=value` per line, `#` comments ignored. */
export function envToText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

export function textToEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key) env[key] = line.slice(eq + 1).trim();
  }
  return env;
}

/** Passthrough names: comma- or newline-separated. */
export function namesToText(names: string[] | undefined): string {
  return (names ?? []).join("\n");
}

export function textToNames(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((name) => name.trim())
    .filter(Boolean);
}
