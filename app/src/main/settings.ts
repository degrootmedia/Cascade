/**
 * Settings persistence. The API key is encrypted with Electron safeStorage
 * (OS keychain-backed) and stored base64-encoded; it is never written in
 * plain text and never sent to the renderer. Keys and models are stored per
 * LLM API provider (see shared/providers.ts) — switching providers in
 * Settings keeps each one's key and model choice intact.
 */
import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProvider } from "../shared/providers.js";

interface SettingsFile {
  /** Selected LLM API provider id (see shared/providers.ts). */
  provider: string;
  /** base64-encrypted API keys, one per provider id. */
  encryptedApiKeys: Record<string, string>;
  /** Last chosen model per provider id. */
  models: Record<string, string>;
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
  /** Absolute path to the external image editor executable (e.g. Photoshop). */
  externalEditor: string | null;
}

const DEFAULTS: SettingsFile = {
  provider: "gab",
  encryptedApiKeys: {},
  models: {},
  workspace: null,
  recentWorkspaces: [],
  recentProductions: [],
  mcpOnDemand: ["openart"],
  accent: "#4f8ef7",
  externalEditor: null,
};
const MAX_RECENT_WORKSPACES = 10;
const MAX_RECENT_PRODUCTIONS = 10;

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

let cache: SettingsFile | null = null;

function load(): SettingsFile {
  if (cache) return cache;
  let s: SettingsFile = { ...DEFAULTS };
  try {
    s = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), "utf8")) };
  } catch {
    // no settings file yet — use defaults
  }
  // Migration from pre-provider settings: a single key + model belonged to gab.
  const legacy = s as unknown as { encryptedApiKey?: string; model?: string };
  if (legacy.encryptedApiKey && !s.encryptedApiKeys["gab"]) {
    s.encryptedApiKeys["gab"] = legacy.encryptedApiKey;
  }
  if (legacy.model && !s.models["gab"]) {
    s.models["gab"] = legacy.model;
  }
  delete legacy.encryptedApiKey;
  delete legacy.model;
  if (!getProvider(s.provider)) s.provider = "gab";
  cache = s;
  return cache!;
}

function save(): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(load(), null, 2), "utf8");
}

function currentProvider(): string {
  const p = load().provider;
  return getProvider(p) ? p : "gab";
}

/** Base URL of the selected provider (e.g. "https://gab.ai/v1"). */
export function getBaseUrl(): string {
  return getProvider(currentProvider())?.baseUrl ?? "";
}

export function getProviderId(): string {
  return currentProvider();
}

export function setProvider(id: string): void {
  if (!getProvider(id)) return;
  load().provider = id;
  save();
}

export function getApiKey(provider?: string): string | null {
  const s = load();
  const enc = s.encryptedApiKeys[provider ?? currentProvider()];
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, "base64"));
  } catch {
    return null;
  }
}

export function hasApiKey(provider?: string): boolean {
  return getApiKey(provider) !== null;
}

export function setApiKey(key: string, provider?: string): void {
  const s = load();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS encryption unavailable; refusing to store API key in plain text");
  }
  s.encryptedApiKeys[provider ?? currentProvider()] = safeStorage.encryptString(key).toString("base64");
  save();
}

export function getModel(provider?: string): string {
  const s = load();
  const id = provider ?? currentProvider();
  const model = s.models[id];
  if (model) return model;
  return getProvider(id)?.defaultModel ?? "";
}

export function setModel(model: string, provider?: string): void {
  load().models[provider ?? currentProvider()] = model;
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

export function getExternalEditor(): string | null {
  return load().externalEditor ?? null;
}

export function setExternalEditor(p: string | null): void {
  const next = typeof p === "string" && p.trim() ? p.trim() : null;
  load().externalEditor = next;
  save();
}