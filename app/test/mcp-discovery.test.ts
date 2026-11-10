/**
 * Regression: the OpenArt MCP server showed "connected" while its models
 * appeared nowhere. Live probe (2026-11-10): the real `openart_model_list`
 * reply is a `{"balance":…,"models":[…]}` document well over 50,000 chars,
 * and McpManager's host-side result text was sliced at exactly 50,000 —
 * mid-JSON — so the model-list parser read a truncated document and
 * produced zero models for every picker and the Model Customizer.
 *
 * This drives the REAL McpManager.callRaw seam (a fake SDK client stands in
 * for the transport) so the truncation itself is the thing under test.
 */
import { describe, it, expect, vi } from "vitest";
import { McpManager } from "../src/main/mcp.js";
import { shapeOpenArtModelChoices } from "../src/main/providers/openart-core.js";

vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }) },
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

/** A model-list reply in the live server's shape, padded past 50k chars the
 *  same way the real catalog is: many models with long marketing
 *  descriptions and media-keyed mode objects. */
function bigModelListReply(modelCount: number): string {
  const models = Array.from({ length: modelCount }, (_, i) => ({
    id: `model-${i}`,
    displayName: `Model ${i}`,
    description:
      `Model ${i} — a detailed marketing description that explains at length when to pick ` +
      `this model over its siblings, what it is strongest at, and which reference kinds it ` +
      `accepts. Text- and image-to-image generation with strong subject separation.`,
    modes: { image: [{ mode: "text2image" }, { mode: "image2image" }] },
  }));
  return JSON.stringify({ balance: 42, models });
}

describe("McpManager.callRaw host-side replies (model discovery)", () => {
  it("a >50k model-list reply survives intact and parses to every model", async () => {
    const reply = bigModelListReply(200);
    expect(reply.length).toBeGreaterThan(50_000);

    const mcp = new McpManager("/nonexistent/mcp.json");
    const fakeClient = {
      callTool: async () => ({ content: [{ type: "text", text: reply }], isError: false }),
      close: async () => {},
    };
    // The clients map is the transport seam; a fake SDK client is the
    // smallest stand-in that still exercises callRaw's text assembly.
    (mcp as unknown as { clients: Map<string, unknown> }).clients.set("openart", fakeClient);

    const text = await mcp.callRaw("openart", "openart_model_list", {});
    expect(text).toBe(reply);
    const choices = shapeOpenArtModelChoices(text);
    expect(choices).toHaveLength(200);
    expect(choices[199].id).toBe("model-199");
  });
});
