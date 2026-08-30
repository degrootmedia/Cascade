/**
 * MCP client manager. Reads a Claude Desktop-compatible config
 * ({ "mcpServers": { name: { command, args?, env? } | { url } } }),
 * connects each server, and exposes its tools as AgentTools namespaced
 * `servername__toolname`. All MCP tool calls go through the approval gate —
 * Cascade can't know which external tools are destructive, so the user
 * decides (with per-session "always allow" available per tool).
 */
import * as fs from "node:fs";
import * as path from "node:path";

// Soft dependency: thumbnail generation needs Electron's nativeImage, but this
// module must also load outside Electron (test harness). Files still save
// without it — only the chat thumbnail is skipped.
let nativeImage: typeof import("electron").nativeImage | undefined;
void import("electron")
  .then((m) => {
    nativeImage = m.nativeImage;
  })
  .catch(() => {});
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpOAuthProvider, waitForAuthorizationCode } from "./mcp-auth.js";
import type { AgentTool } from "@core";
import { IMAGE_URL_RX } from "../shared/prompt-grammar.js";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  disabled?: boolean;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpServerStatus {
  name: string;
  status: "connected" | "error" | "disabled";
  toolCount: number;
  error?: string;
}

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;

/** Tool names must satisfy ^[a-zA-Z0-9_-]{1,64}$ for the chat API. */
function sanitizeName(serverName: string, toolName: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${clean(serverName)}__${clean(toolName)}`.slice(0, 64);
}

export class McpManager {
  private clients = new Map<string, Client>();
  private statuses: McpServerStatus[] = [];
  private tools: Record<string, AgentTool> = {};

  constructor(private configPath: string) {}

  readConfigText(): string {
    try {
      return fs.readFileSync(this.configPath, "utf8");
    } catch {
      return JSON.stringify({ mcpServers: {} }, null, 2);
    }
  }

  writeConfigText(text: string): void {
    // Validate before persisting so a typo can't wedge startup.
    const parsed = JSON.parse(text) as McpConfigFile;
    if (typeof parsed.mcpServers !== "object" || parsed.mcpServers === null) {
      throw new Error('config must have an "mcpServers" object');
    }
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(parsed, null, 2), "utf8");
  }

  getStatuses(): McpServerStatus[] {
    return this.statuses;
  }

  getTools(): Record<string, AgentTool> {
    return this.tools;
  }

  /**
   * Call a tool on a named server directly from host code (bypasses the
   * approval gate — used by first-party helpers like the native OpenArt
   * uploader). Returns the combined text of the result content items.
   */
  async callRaw(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    return (await this.callRawFull(serverName, toolName, args)).text;
  }

  /**
   * Like callRaw, but also returns any binary image content items as Buffers
   * (base64-decoded). Host-side generation helpers (storyboards) need the
   * actual pixels, which the text-only callRaw view discards.
   */
  async callRawFull(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ text: string; images: Buffer[] }> {
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP server "${serverName}" is not connected`);
    const result = await withTimeout(
      client.callTool({ name: toolName, arguments: args }),
      CALL_TIMEOUT_MS,
      `${serverName}.${toolName}`
    );
    const text = resultContentText(result.content);
    if (result.isError) {
      throw new Error(text ? `MCP error: ${text}` : `MCP server error from ${serverName}.${toolName}`);
    }
    const images: Buffer[] = [];
    if (Array.isArray(result.content)) {
      for (const c of result.content as McpContentItem[]) {
        if (c.type === "image" && c.data) images.push(Buffer.from(c.data, "base64"));
        else if (c.type === "resource" && c.resource?.blob && c.resource.mimeType?.startsWith("image/")) {
          images.push(Buffer.from(c.resource.blob, "base64"));
        }
      }
    }
    return { text, images };
  }

  /**
   * Like callRawFull, but also surfaces image/resource-link URIs so async
   * generation results (e.g. OpenArt's PENDING submission → completion) can be
   * dereferenced from the raw result content instead of just matching URLs in
   * the text blob.
   */
  async callRawContent(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ text: string; images: Buffer[]; uris: string[] }> {
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP server "${serverName}" is not connected`);
    const result = await withTimeout(
      client.callTool({ name: toolName, arguments: args }),
      CALL_TIMEOUT_MS,
      `${serverName}.${toolName}`
    );
    const text = resultContentText(result.content);
    if (result.isError) {
      throw new Error(text ? `MCP error: ${text}` : `MCP server error from ${serverName}.${toolName}`);
    }
    const images: Buffer[] = [];
    const uris: string[] = [];
    if (Array.isArray(result.content)) {
      for (const c of result.content as McpContentItem[]) {
        if (c.type === "image" && c.data) images.push(Buffer.from(c.data, "base64"));
        else if (c.type === "resource" && c.resource?.blob && c.resource.mimeType?.startsWith("image/")) {
          images.push(Buffer.from(c.resource.blob, "base64"));
        } else if (c.type === "resource_link" && c.uri) {
          uris.push(c.uri);
        } else if (c.type === "resource" && c.resource?.uri) {
          uris.push(c.resource.uri);
        }
      }
    }
    return { text, images, uris };
  }

  /** Disconnect everything and reconnect from the current config file. */
  async reload(): Promise<McpServerStatus[]> {
    await this.shutdown();
    this.statuses = [];
    this.tools = {};

    let config: McpConfigFile;
    try {
      config = JSON.parse(this.readConfigText());
    } catch (e) {
      this.statuses.push({ name: "(config)", status: "error", toolCount: 0, error: `invalid JSON: ${e}` });
      return this.statuses;
    }

    for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
      if (server.disabled) {
        this.statuses.push({ name, status: "disabled", toolCount: 0 });
        continue;
      }
      try {
        const count = await this.connectServer(name, server);
        this.statuses.push({ name, status: "connected", toolCount: count });
      } catch (e) {
        this.statuses.push({ name, status: "error", toolCount: 0, error: String(e).slice(0, 300) });
      }
    }
    return this.statuses;
  }

  private async connectServer(name: string, server: McpServerConfig): Promise<number> {
    let client: Client;

    if (server.url) {
      client = await this.connectHttp(name, server.url);
    } else if (server.command) {
      client = new Client({ name: "cascade", version: "0.1.0" });
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) },
        stderr: "ignore",
      });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect to ${name}`);
    } else {
      throw new Error('server config needs either "command" or "url"');
    }
    this.clients.set(name, client);

    const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `list tools of ${name}`);
    for (const tool of tools) {
      const qualified = sanitizeName(name, tool.name);
      this.tools[qualified] = {
        requiresApproval: true,
        definition: {
          type: "function",
          function: {
            name: qualified,
            description: `[${name} MCP] ${tool.description ?? tool.name}`.slice(0, 1024),
            parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
          },
        },
        describe: (args) => ({
          tool: qualified,
          summary: `${name}: ${tool.name}`,
          detail: JSON.stringify(args, null, 2).slice(0, 2000),
        }),
        run: async (args, workspaceRoot) => {
          const result = await withTimeout(
            client.callTool({ name: tool.name, arguments: args }),
            CALL_TIMEOUT_MS,
            `${name}.${tool.name}`
          );
          const processed = processContent(result.content, workspaceRoot);
          if (result.isError) {
            return `ERROR: ${processed.text}`;
          }
          return { text: processed.text || "(empty result)", images: processed.images };
        },
      };
    }
    return tools.length;
  }

  /**
   * Connect to a remote (streamable-HTTP) server. If it demands OAuth, the
   * SDK opens the user's browser (via our provider); we catch the redirect
   * on the loopback server, complete the token exchange, and reconnect.
   */
  private async connectHttp(name: string, url: string): Promise<Client> {
    const authProvider = new McpOAuthProvider(name, path.join(path.dirname(this.configPath), "mcp-auth"));

    const attempt = async () => {
      const client = new Client({ name: "cascade", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider });
      await client.connect(transport);
      return { client, transport };
    };

    try {
      const { client } = await withTimeout(attempt(), CONNECT_TIMEOUT_MS, `connect to ${name}`);
      return client;
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
    }

    // Browser has been opened to the authorization page; wait for the code.
    // (No overall timeout here beyond the 3-minute callback wait — the user
    // is off signing in.)
    const code = await waitForAuthorizationCode();
    const finishTransport = new StreamableHTTPClientTransport(new URL(url), { authProvider });
    await finishTransport.finishAuth(code);
    await finishTransport.close();

    // Tokens are stored; reconnect cleanly.
    const { client } = await withTimeout(attempt(), CONNECT_TIMEOUT_MS, `reconnect to ${name}`);
    return client;
  }

  async shutdown(): Promise<void> {
    for (const [, client] of this.clients) {
      try {
        await client.close();
      } catch {
        /* already dead */
      }
    }
    this.clients.clear();
  }
}

interface McpContentItem {
  type?: string;
  text?: string;
  data?: string; // base64 (image/audio)
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Join the text portions of raw MCP result content (for callRaw). */
function resultContentText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return (content as McpContentItem[])
    .map((c) => c.text ?? `[${c.type ?? "unknown"}]`)
    .join("\n")
    .slice(0, 50_000);
}

/**
 * Turn MCP result content into model-facing text plus UI thumbnails.
 * Binary images are saved into the chat's working folder (cascade-images/)
 * so they persist; the model is told the saved path.
 */
function processContent(content: unknown, workspaceRoot: string): { text: string; images?: string[] } {
  if (!Array.isArray(content)) return { text: JSON.stringify(content ?? "") };
  const texts: string[] = [];
  const images: string[] = [];

  for (const c of content as McpContentItem[]) {
    if (c.type === "text") {
      texts.push(c.text ?? "");
      collectImageUrls(c.text ?? "", images);
    } else if (c.type === "image" && c.data) {
      texts.push(saveImage(c.data, c.mimeType, workspaceRoot, images));
    } else if (c.type === "resource_link" && c.uri) {
      texts.push(`${c.name ?? "resource"}: ${c.uri}`);
      collectImageUrls(c.uri, images);
    } else if (c.type === "resource" && c.resource) {
      if (c.resource.text) texts.push(c.resource.text);
      else if (c.resource.blob && c.resource.mimeType?.startsWith("image/")) {
        texts.push(saveImage(c.resource.blob, c.resource.mimeType, workspaceRoot, images));
      } else texts.push(`resource: ${c.resource.uri ?? "(embedded)"}`);
    } else {
      texts.push(`[${c.type ?? "unknown"} content]`);
    }
  }
  return { text: texts.join("\n").slice(0, 20_000), images: images.length ? images : undefined };
}

const MAX_AUTO_IMAGES = 4;

/** Pull display-worthy image URLs out of result text so the UI can show them immediately. */
function collectImageUrls(text: string, images: string[]): void {
  for (const match of text.matchAll(IMAGE_URL_RX)) {
    if (images.length >= MAX_AUTO_IMAGES) return;
    if (!images.includes(match[0])) images.push(match[0]);
  }
}

/** Save a base64 image to the workspace; returns the model-facing description. */
function saveImage(base64: string, mimeType: string | undefined, workspaceRoot: string, images: string[]): string {
  try {
    const buffer = Buffer.from(base64, "base64");
    const ext = EXT_BY_MIME[mimeType ?? ""] ?? "png";
    const dir = path.join(workspaceRoot, "cascade-images");
    fs.mkdirSync(dir, { recursive: true });
    const file = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    fs.writeFileSync(path.join(dir, file), buffer);

    // Small thumbnail for the chat UI (kept modest so session files stay lean).
    if (nativeImage) {
      const img = nativeImage.createFromBuffer(buffer);
      if (!img.isEmpty()) {
        const { width } = img.getSize();
        const thumb = width > 512 ? img.resize({ width: 512 }) : img;
        images.push(thumb.toDataURL());
      }
    }
    return `Image saved to cascade-images/${file} in the working folder.`;
  } catch (e) {
    return `[image content — failed to save: ${e}]`;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what} (${ms / 1000}s)`)), ms)),
  ]);
}
