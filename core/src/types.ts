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
}

export interface AgentConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  workspaceRoot: string;
  maxIterations?: number;
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
