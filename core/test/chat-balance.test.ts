import { describe, it, expect, afterEach, vi } from "vitest";
import { ChatClient } from "../src/chat.js";

function jsonRes(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatClient.balance", () => {
  it("fetches the declared path and extracts the declared field", async () => {
    let url = "";
    let auth = "";
    vi.stubGlobal("fetch", async (u: string, init: { headers?: Record<string, string> }) => {
      url = u;
      auth = init?.headers?.Authorization ?? "";
      return jsonRes({ balance_usd: 10, available_usd: 7.25, reserved_usd: 2.75 });
    });
    const client = new ChatClient("key", "https://api.example.com/v1");
    // The registry's Cheaper Inference spec: spend the available, not balance.
    const v = await client.balance({ path: "/account/balance", field: "available_usd" });
    expect(url).toBe("https://api.example.com/v1/account/balance");
    expect(auth).toBe("Bearer key");
    expect(v).toBe(7.25);
  });

  it("throws on an HTTP failure, and returns null for a missing/non-numeric field", async () => {
    vi.stubGlobal("fetch", async () => jsonRes({ error: { code: "insufficient_scope" } }, false));
    const client = new ChatClient("key", "https://x");
    // The response body is surfaced so a scope rejection is diagnosable.
    await expect(client.balance({ path: "/account/balance", field: "available_usd" })).rejects.toThrow(
      /HTTP 500.*insufficient_scope/s
    );

    vi.stubGlobal("fetch", async () => jsonRes({ total_available: "12" }));
    expect(await client.balance({ path: "/credits", field: "total_available" })).toBeNull();

    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => { throw new Error("no body"); } }) as unknown as Response);
    expect(await client.balance({ path: "/credits", field: "total_available" })).toBeNull();
  });
});
