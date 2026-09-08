/** Shared types for the Cascade agent core. */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** OpenAI-style multimodal content part. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** A file attached to a user message (image, PDF, document, etc.). */
export interface Attachment {
  /** Data URL of the file (any MIME: `data:image/png;base64,…`, `data:application/pdf;base64,…`, …). */
  dataUrl: string;
  /** Original filename. */
  name: string;
  /** MIME type. */
  mime: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** Extract the plain-text portion of any message content. */
export function contentText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .map((p) => (p.type === "text" ? p.text : "[image]"))
    .join(" ");
}

/** MIME types whose bytes can be read as plain text by any frontier model. */
const INLINE_TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/x-csv",
  "text/tab-separated-values",
  "text/html",
  "text/xml",
  "text/css",
  "text/javascript",
  "text/x-tex",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/yaml",
  "application/x-yaml",
  "application/sql",
]);

/** Cap for files inlined as text so a huge document can't blow up the context. */
const MAX_INLINE_TEXT_CHARS = 100_000;

/** Decode a `data:` URL into its raw text payload (base64 or percent-encoded). */
function decodeDataUrlText(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return "";
  const header = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (header.includes(";base64")) {
    try {
      const bin = atob(body);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return "";
    }
  }
  try {
    return decodeURIComponent(body);
  } catch {
    return body;
  }
}

/**
 * Build the content parts for a user message with attachments. Images and
 * opaque media (PDF, office docs) pass through as OpenAI-style media parts
 * (`image_url` with a data URL — the only media part chat-completions speaks,
 * and how Gemini-style endpoints accept PDFs); plain-text documents are
 * inlined as a labeled text part so every model can read them.
 */
export function attachmentParts(text: string, attachments?: Attachment[]): ChatMessage["content"] {
  if (!attachments?.length) return text;
  const parts: ContentPart[] = [{ type: "text", text }];
  for (const a of attachments) {
    const base = a.mime.split(";")[0].trim().toLowerCase();
    if (base.startsWith("image/")) {
      parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
    } else if (INLINE_TEXT_MIMES.has(base)) {
      let body = decodeDataUrlText(a.dataUrl).trim();
      if (body.length > MAX_INLINE_TEXT_CHARS) {
        body = body.slice(0, MAX_INLINE_TEXT_CHARS) + "\n…(truncated — file too large to inline fully)";
      }
      if (body) parts.push({ type: "text", text: `\n[Attached file: ${a.name}]\n${body}` });
      else parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
    } else {
      // PDFs, office documents, etc. — the OpenAI-compatible endpoint decides
      // whether the model can ingest them.
      parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
    }
  }
  return parts;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  credits_used?: number;
}

/** JSON-schema tool definition in OpenAI format. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** An action awaiting user approval. */
export interface ApprovalRequest {
  tool: string;
  /** Human-readable description, e.g. "Write 240 chars to notes/summary.md" */
  summary: string;
  /** Full detail for display: file diff, command text, etc. */
  detail: string;
}

export type ApprovalDecision =
  | "allow"
  | "allow-session" // this tool, rest of session
  | "allow-group-session" // all tools sharing this tool's server prefix (e.g. openart__*)
  | "deny";

/** Events emitted by the agent loop, consumed by CLI or UI. */
export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "text-done"; text: string }
  | { type: "tool-start"; call: { name: string; args: Record<string, unknown> } }
  | { type: "tool-result"; name: string; result: string; isError: boolean; images?: string[] }
  | { type: "turn-done"; usage: Usage }
  | { type: "agent-done"; finalText: string; totalCredits: number }
  | { type: "group-enabled"; group: string }
  | { type: "notice"; text: string }
  | { type: "error"; message: string };

/** Rich tool result: text goes to the model; images (data URLs) go to the UI. */
export interface ToolRunResult {
  text: string;
  images?: string[];
}

/** A tool the agent can call. Built-ins and MCP wrappers share this shape. */
export interface AgentTool {
  definition: ToolDefinition;
  requiresApproval: boolean;
  /** Build the approval request shown to the user (approval-gated tools). */
  describe?: (args: Record<string, unknown>, workspaceRoot: string) => ApprovalRequest;
  run: (args: Record<string, unknown>, workspaceRoot: string) => Promise<string | ToolRunResult>;
}

export interface SkillMeta {
  name: string;
  description: string;
  /** Namespace the skill lives under ("spec", "oracle", "code", …). Flat
   *  skills have none. Grouped into sections in the system prompt so the
   *  model knows how to treat each kind (follow closely vs. adapt vs. use
   *  on demand). */
  namespace?: string;
  /** How the model should treat the skill. Sequential skills produce
   *  artifacts and are followed closely; advisory skills adapt to context;
   *  utility skills are reached for on demand. Defaults to "utility". */
  kind?: "sequential" | "advisory" | "utility";
  /** Trigger phrases — surfaced as routing hints (not enforced) so the
   *  model knows which skill matches a user request. */
  triggers?: string[];
}

/** The mutating tools the agent may not call while plan mode is on. */
export const PLAN_GATED_TOOLS = ["write_file", "edit_file", "run_command"];

export interface AgentConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /**
   * Cheap background model used for compaction (titles come through
   * suggestChatTitle). Resolved per provider by the app from its model list
   * (the cheapest usable model); falls back to `model` when omitted.
   */
  helperModel?: string;
  /** Folder the agent may touch; omitted in pure-chat mode. */
  workspaceRoot?: string;
  maxIterations?: number;
  /** Pure chat: no tools, no workspace, minimal prompt — web-chat-like. */
  pureChat?: boolean;
  /**
   * Plan mode: the agent researches and writes a written plan, but cannot
   * mutate the workspace (write/edit/run_command are gated) until the user
   * reviews and approves the plan. Enforced in the loop, not just prompted.
   */
  planMode?: boolean;
  /** Agent persona prompt injected before the Cascade base prompt. */
  agentPrompt?: string;
  /** Skills advertised in the system prompt; content is fetched via a read_skill tool. */
  skills?: SkillMeta[];
  /** Additional tools (e.g. MCP server tools) merged with the built-ins. */
  extraTools?: Record<string, AgentTool>;
  /**
   * On-demand tools (e.g. large/rarely-used MCP sets like OpenArt).
   * Excluded from the default model payload; attached automatically the
   * moment the user asks for them by name. Keeps requests lean.
   */
  lazyTools?: Record<string, AgentTool>;
  /**
   * One-line advertising for each on-demand group, shown in the system prompt
   * so the model knows the capability exists and requires explicit request.
   * `name` matches the tool prefix (the server prefix, e.g. "openart").
   */
  lazyGroupNotes?: Array<{ name: string; hint: string }>;
  /** Called before any mutating action. Return a decision. */
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  onEvent: (event: AgentEvent) => void;
}
