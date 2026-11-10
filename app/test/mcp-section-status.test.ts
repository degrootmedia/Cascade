/**
 * Settings → MCP Servers must never show a plain "connected" while a
 * media-backed server has zero models loaded (the OpenArt incident: the
 * transport handshake succeeded, discovery silently produced nothing, and
 * every picker was empty). These pin the truthful labels and when the row
 * offers Retry.
 */
import { describe, it, expect } from "vitest";
import { connectedLabel, discoveryNeedsRetry } from "../src/renderer/src/components/McpSection.js";
import type { McpStatusIpc, ModelDiscoveryState } from "../src/shared/ipc.js";

const status = (discovery?: ModelDiscoveryState): McpStatusIpc => ({
  name: "openart",
  status: "connected",
  toolCount: 21,
  ...(discovery ? { discovery } : {}),
});

describe("connectedLabel", () => {
  it("plain MCP servers (no discovery tracking) keep the tool count", () => {
    expect(connectedLabel(status())).toBe("21 tools");
  });

  it("connected but discovery failed with no models says so, not plain connected", () => {
    const s = status({ state: "error", modelCount: 0, stale: false, error: "boom" });
    expect(connectedLabel(s)).toBe("Connected — no models loaded");
    expect(discoveryNeedsRetry(s)).toBe(true);
  });

  it("connected but discovery came back empty says so", () => {
    const s = status({ state: "empty", modelCount: 0, stale: false });
    expect(connectedLabel(s)).toBe("Connected — no models loaded");
    expect(discoveryNeedsRetry(s)).toBe(true);
  });

  it("while discovery runs, the label says models are loading", () => {
    expect(connectedLabel(status({ state: "loading", modelCount: 0, stale: false }))).toBe(
      "Connected · loading models…"
    );
    expect(discoveryNeedsRetry(status({ state: "loading", modelCount: 0, stale: false }))).toBe(false);
  });

  it("a successful discovery shows the model count", () => {
    const s = status({ state: "ok", modelCount: 137, stale: false });
    expect(connectedLabel(s)).toBe("Connected · 137 models");
    expect(discoveryNeedsRetry(s)).toBe(false);
  });

  it("the kept last-good list is marked as possibly out of date", () => {
    const s = status({ state: "error", modelCount: 137, stale: true, error: "boom" });
    expect(connectedLabel(s)).toBe("Connected · 137 models (may be out of date)");
    // Models are on offer, so the action is Refresh, not Retry.
    expect(discoveryNeedsRetry(s)).toBe(false);
  });
});
