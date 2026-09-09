/**
 * Minimal OpenAI-compatible chat client, raw fetch, streaming. Every LLM
 * provider Cascade talks to (Gab, Cheaper Inference, OpenAI, …) speaks this
 * protocol — the provider registry (app/src/shared/providers.ts) supplies the
 * base URL, so this class stays provider-agnostic.
 * Proven against the live gab.ai API in phase0/test-tool-calling.mjs.
 */
import type { ChatMessage, ToolDefinition, ToolCall, Usage } from "./types.js";

const DEFAULT_BASE = "https://gab.ai/v1";
const READ_TIMEOUT_MS = 210_000;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

/** Full conversation payloads are only logged when the operator opts in. */
const CHAT_DEBUG = process.env.CASCADE_DEBUG_CHAT === "1";

const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|[A-Za-z0-9+/]{40,}={0,2})\b/g;

/** Mask key-like material so even debug logs are not credential dumps. */
export function redactSecrets(s: string): string {
  return s.replace(SECRET_RE, "[REDACTED]");
}

interface ChatLogMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string } }>;
}

/**
 * Log chat traffic: metadata only by default (roles, char counts, tool
 * names); full payloads only with CASCADE_DEBUG_CHAT=1, redacted.
 */
export function logChatMetadata(
  tag: string,
  messages: ChatLogMessage[],
  extra?: { model?: string; promptTokens?: number; completionTokens?: number }
): void {
  if (CHAT_DEBUG) {
    console.debug(`${tag} payload`, redactSecrets(JSON.stringify(messages)));
    return;
  }
  console.info(
    `${tag} ${JSON.stringify({
      ...extra,
      count: messages.length,
      messages: messages.map((m) => ({
        role: m.role,
        chars: typeof m.content === "string" ? m.content.length : undefined,
        tools: m.tool_calls?.map((t) => t.function?.name).filter(Boolean),
      })),
    })}`
  );
}

/** Whether an error message indicates a transient upstream failure worth
 *  retrying. gab.ai wraps every backend hiccup in a generic
 *  "[gab.ai error] The model failed to generate a response" banner; 5xx
 *  gateway errors, upstream timeouts, and empty generations are the same
 *  class of flake — a retry is the textbook remedy. */
export function isTransientFailure(msg: string): boolean {
  return (
    msg.includes("HTTP 500") ||
    msg.includes("HTTP 502") ||
    msg.includes("HTTP 503") ||
    msg.includes("HTTP 529") ||
    msg.includes("504") ||
    msg.includes("upstream_timeout") ||
    msg.includes("gab.ai error") ||
    msg.includes("failed to generate a response") ||
    msg.includes("empty response")
  );
}

/** Map raw HTTP/network failures to messages a non-developer can act on. */
export function friendlyApiError(e: unknown): string {
  const msg = String(e);
  if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) {
    return "Your API key was rejected. Check it in Settings.";
  }
  if (msg.includes("HTTP 402") || msg.toLowerCase().includes("insufficient")) {
    return "You're out of credits. Top up or wait for your monthly reset.";
  }
  if (msg.includes("HTTP 429")) {
    return "Rate limited by the API — wait a minute and try again.";
  }
  if (msg.includes("HTTP 504") || msg.includes("upstream_timeout")) {
    return "The model timed out repeatedly. Try again, or switch to a faster model.";
  }
  // The API wraps every upstream model failure in a generic banner that hides
  // the real reason (provider refusal, content-policy block, timeout, outage).
  // Surface it as something actionable instead of a confusing dead-end.
  if (msg.includes("gab.ai error") || msg.includes("failed to generate a response") || msg.includes("empty response")) {
    return "The model failed to respond. This is often a temporary outage, a safety/content block, or a model-specific issue — try again, switch to a different model, or rephrase the request.";
  }
  if (/HTTP 5\d\d/.test(msg)) {
    return "The API service is temporarily unavailable — try again in a moment.";
  }
  if (msg.includes("fetch failed") || msg.includes("ENOTFOUND") || msg.includes("EAI_AGAIN") || msg.includes("ECONNRE")) {
    return "Can't reach the API — check your internet connection.";
  }
  if (msg.includes("TimeoutError") || msg.includes("aborted")) {
    return "The request was interrupted.";
  }
  if (msg.includes("truncated")) {
    return "The response hit the token limit and was cut off — the answer may be incomplete. Ask me to continue, or break the task into smaller steps.";
  }
  return msg;
}

export interface CompletionResult {
  message: ChatMessage;
  usage: Usage;
}

/** Tracks whether a stream emitted anything (text or a tool call) so the
 *  retry loop never repeats a partial response. */
interface StreamState {
  received: boolean;
}

export interface ChatClientOptions {
  /** Max attempts for transient upstream failures (default 3). */
  maxRetries?: number;
  /** Base backoff between retries, multiplied by attempt number (default 2000). */
  retryDelayMs?: number;
}

export class ChatClient {
  private maxRetries: number;
  private retryDelayMs: number;

  constructor(
    private apiKey: string,
    private baseUrl: string = DEFAULT_BASE,
    opts: ChatClientOptions = {}
  ) {
    this.maxRetries = opts.maxRetries ?? MAX_RETRY_ATTEMPTS;
    this.retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
  }

  /**
   * Streaming chat completion. Emits text deltas via onTextDelta; assembles
   * tool-call deltas internally. Retries transient upstream failures (5xx,
   * the generic gab.ai failure banner, empty/streamed-error generations) with
   * backoff — but only when nothing was streamed yet, so a partial response is
   * never repeated.
   */
  async complete(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onTextDelta: (text: string) => void,
    signal?: AbortSignal
  ): Promise<CompletionResult> {
    const state: StreamState = { received: false };
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.streamOnce(model, messages, tools, onTextDelta, signal, state);
      } catch (e: unknown) {
        const msg = String(e);
        const retryable = !state.received && isTransientFailure(msg);
        if (!retryable || attempt >= this.maxRetries || signal?.aborted) throw e;
        await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
      }
    }
  }

  private async streamOnce(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    onTextDelta: (text: string) => void,
    signal?: AbortSignal,
    state?: StreamState
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
      // Generous output budget: long tool-call arguments (e.g. a corrected file
      // written in one call) can exceed 8k tokens, and a truncated generation
      // used to surface as a silent mid-task stop.
      max_tokens: 16000,
    };
    console.log(`[chat] streaming payload (${model}, ${messages.length} msgs, ${tools?.length ?? 0} tools):`);
    logChatMetadata("chat.request", messages, { model });
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
    let finishReason: string | undefined;

    const decoder = new TextDecoder();
    let buf = "";
    resetIdle(); // start counting before the first chunk arrives

    // Process one SSE `data:` line. Throws on a provider error event so a
    // streamed failure surfaces instead of being swallowed.
    const handleLine = (line: string) => {
      if (!line.startsWith("data: ")) return;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        return; // tolerate malformed keepalive chunks
      }
      if (json.usage) usage = json.usage;
      // The provider can stream an error event on an HTTP 200 connection
      // (e.g. the model failed to start generating). Surface it instead of
      // silently treating the stream as an empty answer.
      if (json.error) {
        const m = typeof json.error?.message === "string" ? json.error.message : "model error";
        throw new Error(m);
      }
      const choice = json.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (!delta) return;
      if (delta.content) {
        if (state) state.received = true;
        content += delta.content;
        onTextDelta(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        toolCallParts[i] ??= { id: "", name: "", args: "" };
        if (tc.id) toolCallParts[i].id = tc.id;
        if (tc.function?.name) toolCallParts[i].name += tc.function.name;
        if (tc.function?.arguments) toolCallParts[i].args += tc.function.arguments;
        if (state) state.received = true;
      }
    };

    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      resetIdle(); // got data → refresh the idle timer
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) handleLine(line);
    }
    if (idleTimer) clearTimeout(idleTimer);
    // Flush the final partial line. A provider may close the stream right
    // after the last delta without a trailing newline; skipping this would
    // silently drop the final content or tool-call fragment (a mid-task stop
    // where the agent "finishes" with just the text it said before the call).
    if (buf.trim()) handleLine(buf);

    const tool_calls: ToolCall[] = Object.keys(toolCallParts)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => {
        const p = toolCallParts[Number(k)];
        return { id: p.id, type: "function" as const, function: { name: p.name, arguments: p.args } };
      });

    // A 200 stream that ends with no content and no tool call is a failed
    // generation, not a real answer — let the retry loop have another go.
    if (!state?.received) {
      throw new Error("model returned an empty response: the stream ended without content or a tool call");
    }

    // The model hit max_tokens mid-generation. A truncated response is not a
    // completed turn: surface it instead of silently stopping with a partial
    // answer. (Truncated tool-call arguments fail JSON parsing downstream and
    // the model recovers on its own, so only the content-only case throws.)
    if (finishReason === "length" && tool_calls.length === 0) {
      throw new Error("response truncated: the model hit the token limit mid-generation");
    }

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
    logChatMetadata("chat.summarize", messages, { model });
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

  /**
   * Account balance, when the provider exposes one (gab: /credits →
   * total_available). Returns null for providers without a balance endpoint
   * or an unrecognized response — callers hide the balance display then.
   */
  async balance(): Promise<number | null> {
    const res = await fetch(`${this.baseUrl}/credits`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) return null;
    const c = (await res.json().catch(() => null)) as { total_available?: unknown } | null;
    return typeof c?.total_available === "number" ? c.total_available : null;
  }
}
