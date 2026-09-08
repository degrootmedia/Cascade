import { describe, it, expect, afterEach, vi } from "vitest";
import { ChatClient, friendlyApiError, isTransientFailure } from "../src/chat.js";

/** A minimal Response with a ReadableStream body that emits the given SSE lines. */
function okStream(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(new TextEncoder().encode(`${l}\n`));
      controller.close();
    },
  });
  return { ok: true, body } as unknown as Response;
}

function errRes(status: number, text: string): Response {
  return { ok: false, status, text: async () => text } as unknown as Response;
}

/** Stream where the FINAL line has no trailing newline (provider closes the
 *  stream right after the last delta) — the case that used to drop it. */
function okStreamNoTrailingNewline(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < lines.length; i++) {
        controller.enqueue(new TextEncoder().encode(i === lines.length - 1 ? lines[i] : `${lines[i]}\n`));
      }
      controller.close();
    },
  });
  return { ok: true, body } as unknown as Response;
}

const GAB_BANNER = "[gab.ai error] The model failed to generate a response. Please try again.";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isTransientFailure", () => {
  it("treats gab.ai's generic failure banner and 5xx as transient", () => {
    expect(isTransientFailure(`HTTP 500: ${GAB_BANNER}`)).toBe(true);
    expect(isTransientFailure("HTTP 502: bad gateway")).toBe(true);
    expect(isTransientFailure("HTTP 503: unavailable")).toBe(true);
    expect(isTransientFailure("HTTP 504: gateway timeout")).toBe(true);
    expect(isTransientFailure("upstream_timeout")).toBe(true);
    expect(isTransientFailure("model returned an empty response: x")).toBe(true);
  });

  it("treats non-transient failures as non-retryable", () => {
    expect(isTransientFailure("HTTP 401: bad key")).toBe(false);
    expect(isTransientFailure("HTTP 429: slow down")).toBe(false);
    expect(isTransientFailure("fetch failed")).toBe(false);
  });
});

describe("ChatClient.complete retries", () => {
  it("retries the gab.ai 500 banner and succeeds on the next attempt", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      if (calls === 1) return errRes(500, GAB_BANNER);
      return okStream(['data: {"choices":[{"delta":{"content":"hi there"}}]}', "data: [DONE]"]);
    });
    const client = new ChatClient("key", "https://x", { retryDelayMs: 1 });
    const { message } = await client.complete("m", [], [], () => {});
    expect(message.content).toBe("hi there");
    expect(calls).toBe(2);
  });

  it("gives up after the configured max attempts and surfaces the error", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return errRes(500, GAB_BANNER);
    });
    const client = new ChatClient("key", "https://x", { retryDelayMs: 1, maxRetries: 3 });
    await expect(client.complete("m", [], [], () => {})).rejects.toThrow(/failed to generate/);
    expect(calls).toBe(3);
  });

  it("retries a streamed error event when nothing was received", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      if (calls === 1) return okStream([`data: {"error":{"message":"${GAB_BANNER}"}}`]);
      return okStream(['data: {"choices":[{"delta":{"content":"ok"}}]}', "data: [DONE]"]);
    });
    const client = new ChatClient("key", "https://x", { retryDelayMs: 1 });
    const { message } = await client.complete("m", [], [], () => {});
    expect(message.content).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does NOT retry once the stream already emitted content (no duplicate output)", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      if (calls === 1) {
        return okStream([
          'data: {"choices":[{"delta":{"content":"partial"}}]}',
          `data: {"error":{"message":"${GAB_BANNER}"}}`,
        ]);
      }
      return okStream(['data: {"choices":[{"delta":{"content":"should-not-run"}}]}', "data: [DONE]"]);
    });
    const client = new ChatClient("key", "https://x", { retryDelayMs: 1 });
    await expect(client.complete("m", [], [], () => {})).rejects.toThrow(/failed to generate/);
    expect(calls).toBe(1);
  });

  it("turns a 200 stream that ends empty into a retried error, not a silent blank answer", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      if (calls === 1) return okStream(["data: [DONE]"]);
      return okStream(['data: {"choices":[{"delta":{"content":"recovered"}}]}', "data: [DONE]"]);
    });
    const client = new ChatClient("key", "https://x", { retryDelayMs: 1 });
    const { message } = await client.complete("m", [], [], () => {});
    expect(message.content).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("delivers a final tool-call delta that arrives without a trailing newline", async () => {
    // The model says some text then emits the write_file call; the stream
    // closes right after the call with no trailing newline. This used to drop
    // the tool call and make the agent "finish" on just the text fragment.
    vi.stubGlobal("fetch", async () =>
      okStreamNoTrailingNewline([
        'data: {"choices":[{"delta":{"content":"Retrying the file write with correct formatting:"}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_file","arguments":"{\\"path\\":\\"x\\",\\"content\\":\\"hello\\"}"}}]},"finish_reason":"tool_calls"}]}',
      ])
    );
    const client = new ChatClient("key", "https://x");
    const { message } = await client.complete("m", [], [], () => {});
    expect(message.content).toBe("Retrying the file write with correct formatting:");
    expect(message.tool_calls?.[0]?.function.name).toBe("write_file");
    expect(JSON.parse(message.tool_calls![0].function.arguments).path).toBe("x");
  });

  it("delivers a final content delta that arrives without a trailing newline", async () => {
    vi.stubGlobal("fetch", async () =>
      okStreamNoTrailingNewline([
        'data: {"choices":[{"delta":{"content":"done"}}]}',
      ])
    );
    const client = new ChatClient("key", "https://x");
    const { message } = await client.complete("m", [], [], () => {});
    expect(message.content).toBe("done");
  });

  it("surfaces a max-token truncation instead of silently stopping", async () => {
    vi.stubGlobal("fetch", async () =>
      okStream([
        'data: {"choices":[{"delta":{"content":"partial answer "}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
      ])
    );
    const client = new ChatClient("key", "https://x");
    await expect(client.complete("m", [], [], () => {})).rejects.toThrow(/truncated/);
  });
});

describe("friendlyApiError", () => {
  it("maps the empty-response sentinel and generic 5xx to actionable messages", () => {
    expect(friendlyApiError(new Error("model returned an empty response: stream ended"))).toContain("failed to respond");
    expect(friendlyApiError(new Error("HTTP 500: gateway"))).toContain("temporarily unavailable");
  });

  it("still maps the gab.ai banner to the actionable message", () => {
    expect(friendlyApiError(new Error(`HTTP 500: ${GAB_BANNER}`))).toContain("failed to respond");
  });

  it("maps max-token truncation to an actionable message", () => {
    expect(friendlyApiError(new Error("response truncated: the model hit the token limit mid-generation"))).toContain("token limit");
  });
});