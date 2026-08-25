/**
 * Minimal Gab.ai API client (OpenAI-compatible), raw fetch, streaming.
 * Proven against the live API in phase0/test-tool-calling.mjs.
 */
import type { ChatMessage, ToolDefinition, ToolCall, Usage } from "./types.js";

const DEFAULT_BASE = "https://gab.ai/v1";
const READ_TIMEOUT_MS = 210_000;

/** Map raw HTTP/network failures to messages a non-developer can act on. */
export function friendlyApiError(e: unknown): string {
  const msg = String(e);
  if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) {
    return "Your Gab.ai API key was rejected. Check it in Settings.";
  }
  if (msg.includes("HTTP 402") || msg.toLowerCase().includes("insufficient")) {
    return "You're out of Gab.ai credits. Top up or wait for your monthly reset.";
  }
  if (msg.includes("HTTP 429")) {
    return "Rate limited by Gab.ai — wait a minute and try again.";
  }
  if (msg.includes("HTTP 504") || msg.includes("upstream_timeout")) {
    return "The model timed out repeatedly. Try again, or switch to a faster model.";
  }
  if (msg.includes("fetch failed") || msg.includes("ENOTFOUND") || msg.includes("EAI_AGAIN") || msg.includes("ECONNRE")) {
    return "Can't reach Gab.ai — check your internet connection.";
  }
  if (msg.includes("TimeoutError") || msg.includes("aborted")) {
    return "The request was interrupted.";
  }
  // Gab wraps every upstream model failure in a generic banner that hides the
  // real reason (provider refusal, content-policy block, timeout, outage).
  // Surface it as something actionable instead of a confusing dead-end.
  if (msg.includes("gab.ai error") || msg.includes("failed to generate a response")) {
    return "Gab's model failed to respond. This is often a temporary outage, a safety/content block, or a model-specific issue — try again, switch to a different model, or rephrase the request.";
  }
  return msg;
}

export interface CompletionResult {
  message: ChatMessage;
  usage: Usage;
}

export class GabClient {
  constructor(
    private apiKey: string,
    private baseUrl: string = DEFAULT_BASE
  ) {}

  /**
   * Streaming chat completion. Emits text deltas via onTextDelta; assembles
   * tool-call deltas internally. Retries 504s with backoff.
   */
  async complete(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onTextDelta: (text: string) => void,
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.streamOnce(model, messages, tools, onTextDelta, signal);
      } catch (e: unknown) {
        const msg = String(e);
        const retryable = msg.includes("504") || msg.includes("upstream_timeout");
        if (!retryable || attempt >= 3 || signal?.aborted) throw e;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }

  private async streamOnce(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onTextDelta: (text: string) => void,
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    // Idle/keepalive timeout, not a total wall-clock timeout: resets on every
    // received chunk so long but actively-streaming responses are never
    // interrupted. Only a genuinely silent connection gets aborted.
    const IDLE_TIMEOUT_MS = 60_000;
    const idle = new AbortController();
    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(new Error("request aborted: stream idle timeout")), IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    };

    const combined = signal ? AbortSignal.any([idle.signal, signal]) : idle.signal;

    const payload = {
      model,
      messages,
      tools,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 8000,
    };
    console.log(`[gab] streaming payload (${model}, ${messages.length} msgs, ${tools?.length ?? 0} tools):`);
    console.log(JSON.stringify(payload, null, 2));
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(payload),
      signal: combined,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    let content = "";
    const toolCallParts: Record<number, { id: string; name: string; args: string }> = {};
    let usage: Usage = {};

    const decoder = new TextDecoder();
    let buf = "";
    resetIdle(); // start counting before the first chunk arrives
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      resetIdle(); // got data → refresh the idle timer
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue; // tolerate malformed keepalive chunks
        }
        if (json.usage) usage = json.usage;
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          onTextDelta(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0;
          toolCallParts[i] ??= { id: "", name: "", args: "" };
          if (tc.id) toolCallParts[i].id = tc.id;
          if (tc.function?.name) toolCallParts[i].name += tc.function.name;
          if (tc.function?.arguments) toolCallParts[i].args += tc.function.arguments;
        }
      }
    }
    if (idleTimer) clearTimeout(idleTimer);

    const tool_calls: ToolCall[] = Object.keys(toolCallParts)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => {
        const p = toolCallParts[Number(k)];
        return { id: p.id, type: "function" as const, function: { name: p.name, arguments: p.args } };
      });

    const message: ChatMessage = {
      role: "assistant",
      content: content || null,
      ...(tool_calls.length ? { tool_calls } : {}),
    };
    return { message, usage };
  }

  /** Non-streaming completion without tools — used for summarization. Usage data IS present on non-streaming responses. */
  async completeOnce(model: string, messages: ChatMessage[], maxTokens = 1000): Promise<{ text: string; usage: Usage }> {
    const payload = { model, messages, max_tokens: maxTokens };
    console.log(`[gab] summarization payload (${model}, ${messages.length} msgs):`);
    console.log(JSON.stringify(payload, null, 2));
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: Usage };
    return { text: json.choices?.[0]?.message?.content ?? "", usage: json.usage ?? {} };
  }

  async credits(): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/credits`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}
