/**
 * Settings persistence. The API key is encrypted with Electron safeStorage
 * (OS keychain-backed) and stored base64-encoded; it is never written in
 * plain text and never sent to the renderer.
 */
import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

interface SettingsFile {
  encryptedApiKey?: string; // base64
  model: string;
  workspace: string | null;
  /** Most recently used folders, most-recent first. */
  recentWorkspaces: string[];
  /** Most recently opened production folders, most-recent first (max 10). */
  recentProductions: string[];
  /**
   * MCP server names whose tools are attached only on user request (not sent
   * in the default model payload). OpenArt defaults to on-demand because its
   * schema set is large and rarely needed.
   */
  mcpOnDemand: string[];
  /** UI accent color (hex), applied to the --accent CSS variable. */
  accent: string;
}

const DEFAULTS: SettingsFile = {
  model: "arya",
  workspace: null,
  recentWorkspaces: [],
  recentProductions: [],
  mcpOnDemand: ["openart"],
  accent: "#4f8ef7",
};
const MAX_RECENT_WORKSPACES = 10;
const MAX_RECENT_PRODUCTIONS = 10;

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

let cache: SettingsFile | null = null;

function load(): SettingsFile {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), "utf8")) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache!;
}

function save(): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(load(), null, 2), "utf8");
}

export function getApiKey(): string | null {
  const s = load();
  if (!s.encryptedApiKey) return null;
  try {
    return safeStorage.decryptString(Buffer.from(s.encryptedApiKey, "base64"));
  } catch {
    return null;
  }
}

export function setApiKey(key: string): void {
  const s = load();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS encryption unavailable; refusing to store API key in plain text");
  }
  s.encryptedApiKey = safeStorage.encryptString(key).toString("base64");
  save();
}

export function getModel(): string {
  return load().model;
}

export function setModel(model: string): void {
  load().model = model;
  save();
}

export function getWorkspace(): string | null {
  return load().workspace;
}

export function setWorkspace(dir: string | null): void {
  load().workspace = dir;
  save();
}

/** Most recently used folders, most-recent first (deduped, capped). */
export function getRecentWorkspaces(): string[] {
  return load().recentWorkspaces ?? [];
}

/** Push a folder onto the recent list. Called whenever a folder is used. */
export function addRecentWorkspace(dir: string): void {
  const s = load();
  const rest = (s.recentWorkspaces ?? []).filter((p) => p !== dir);
  s.recentWorkspaces = [dir, ...rest].slice(0, MAX_RECENT_WORKSPACES);
  save();
}

/** Production folders MRU (last 10), most-recent first. */
export function getRecentProductions(): string[] {
  return load().recentProductions ?? [];
}

/** Push a production folder onto the production MRU list. */
export function addRecentProduction(dir: string): void {
  const s = load();
  const rest = (s.recentProductions ?? []).filter((p) => p !== dir);
  s.recentProductions = [dir, ...rest].slice(0, MAX_RECENT_PRODUCTIONS);
  save();
}

/** MCP server names whose tools attach only on user request. */
export function getMcpOnDemand(): string[] {
  return load().mcpOnDemand ?? [];
}

export function setMcpOnDemand(names: string[]): void {
  load().mcpOnDemand = names;
  save();
}

/** UI accent color (hex string). */
export function getAccent(): string {
  return load().accent ?? DEFAULTS.accent;
}

export function setAccent(color: string): void {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return; // hex only — it's injected into CSS
  load().accent = color;
  save();
}
