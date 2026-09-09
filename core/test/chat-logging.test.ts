import { describe, it, expect, vi, afterEach } from "vitest";
import { logChatMetadata, redactSecrets } from "../src/chat.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CASCADE_DEBUG_CHAT;
});

describe("chat logging", () => {
  it("emits metadata only by default (no content)", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const sentinel = "SENTINEL-UNIQUE-CONTENT-12345";
    logChatMetadata(
      "chat.request",
      [
        { role: "user", content: sentinel },
        { role: "assistant", content: null, tool_calls: [{ function: { name: "read_file" } }] },
      ],
      { model: "m" }
    );
    expect(info).toHaveBeenCalledTimes(1);
    const logged = String(info.mock.calls[0].join(" "));
    expect(logged).not.toContain(sentinel);
    expect(logged).toContain("user");
    expect(logged).toContain("read_file");
    expect(debug).not.toHaveBeenCalled();
  });

  it("redacts key-like material", () => {
    expect(redactSecrets("key sk-abcdefghijklmnop123456 end")).toContain("[REDACTED]");
    expect(redactSecrets("key sk-abcdefghijklmnop123456 end")).not.toContain("sk-abcdef");
    expect(redactSecrets("nothing secret here")).toBe("nothing secret here");
  });
});
