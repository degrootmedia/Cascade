/**
 * The Cascade agent loop.
 *
 * Sends the conversation to Gab, executes any tool calls (routing mutating
 * ones through the approval gate), appends results, and repeats until the
 * model produces a plain text answer or maxIterations is hit.
 */
import { GabClient, friendlyApiError } from "./gab.js";
import { TOOLS } from "./tools.js";
import { systemPrompt } from "./prompts.js";
import { loadWorkspaceInstructions, resolveSafe, WorkspaceError } from "./workspace.js";
import { FileJournal } from "./journal.js";
import { planCompaction, summaryPrompt, summaryMessage } from "./compact.js";
import { contentText, type AgentConfig, type AgentTool, type ChatMessage, type ToolCall, type ToolDefinition } from "./types.js";

/** Cheap model used for background summarization. */
const COMPACT_MODEL = "arya";

const DEFAULT_MAX_ITERATIONS = 50;

/** Synthetic lazy group for first-party helper tools that lack an MCP `__` prefix. */
const FIRST_PARTY_GROUP = "firstparty";
/** Natural-language terms that surface the first-party helpers (e.g. the file picker). */
const FIRST_PARTY_TRIGGERS = ["upload", "reference", "picker", "pick a file", "choose a file"];
/** MCP groups that, when enabled, also activate the first-party helpers. */
const FIRST_PARTY_COMPANIONS = ["openart"];

export class Agent {
  private messages: ChatMessage[] = [];
  private client: GabClient;
  private sessionAllowed = new Set<string>(); // tools granted "always allow" this session
  private sessionAllowedGroups = new Set<string>(); // server prefixes (e.g. "openart") granted wholesale
  private abort?: AbortController;
  private tools: Record<string, AgentTool>;
  private toolDefinitions: ToolDefinition[];
  /** On-demand tools not in the default payload (attached only on request). */
  private lazyTools: Record<string, AgentTool>;
  /** Server prefixes activated this session (e.g. "openart"). */
  private enabledLazyGroups = new Set<string>();
  /** Per-turn snapshot of file states so the last response can be undone. */
  private journal = new FileJournal();
  totalCredits = 0;

  constructor(private config: AgentConfig) {
    this.client = new GabClient(config.apiKey, config.baseUrl);
    this.tools = { ...TOOLS, ...config.extraTools };
    this.lazyTools = config.lazyTools ?? {};
    this.toolDefinitions = Object.values(this.tools).map((t) => t.definition);
    const lazyNote =
      config.lazyGroupNotes?.length && Object.keys(this.lazyTools).length
        ? `\n\nOptional tools — kept out of the normal request to stay lean. You can use them only after the user explicitly asks by name (for example, "use ${config.lazyGroupNotes[0].name}" or "with ${config.lazyGroupNotes[0].name}"). Available on request:\n` +
          config.lazyGroupNotes.map((g) => `- ${g.name}: ${g.hint}`).join("\n")
        : "";
    this.messages.push({
      role: "system",
      content: systemPrompt(
        config.workspaceRoot,
        config.skills,
        loadWorkspaceInstructions(config.workspaceRoot),
        lazyNote,
        config.agentPrompt
      ),
    });
  }

  /** Restore a previous conversation (excluding system prompt). */
  loadHistory(history: ChatMessage[]) {
    this.messages = [this.messages[0], ...history];
  }

  getHistory(): ChatMessage[] {
    return this.messages.slice(1);
  }

  /** Whether the most recent turn made any journaled file changes. */
  canUndo(): boolean {
    return this.journal.hasChanges();
  }

  /** Restore files changed by the most recent turn to their pre-turn state. */
  undoLastTurn(): import("./journal.js").UndoOutcome {
    return this.journal.undo();
  }

  stop() {
    this.abort?.abort();
  }

  /** Auto-enable on-demand tool groups the user names in their message. */
  private activateLazyToolsFor(userText: string): void {
    if (!Object.keys(this.lazyTools).length) return;
    const lower = userText.toLowerCase();
    const groups = [
      ...new Set(
        Object.keys(this.lazyTools)
          .map((n) => (n.includes("__") ? n.split("__")[0] : null))
          .filter((g): g is string => Boolean(g))
      ),
    ];
    // First-party helpers (no `__` server prefix) share one synthetic group.
    if (Object.keys(this.lazyTools).some((n) => !n.includes("__"))) groups.push(FIRST_PARTY_GROUP);

    for (const g of groups) {
      if (this.enabledLazyGroups.has(g)) continue;
      let requested: boolean;
      if (g === FIRST_PARTY_GROUP) {
        // Enabled on explicit reference-helpers terms, or automatically once
        // a companion MCP group (e.g. openart) is already active.
        requested =
          FIRST_PARTY_COMPANIONS.some((c) => this.enabledLazyGroups.has(c)) ||
          FIRST_PARTY_TRIGGERS.some((t) => lower.includes(t));
      } else {
        const re = new RegExp(`(^|[^a-zA-Z0-9_-])${escapeRegExp(g)}([^a-zA-Z0-9_-]|$)`, "i");
        requested =
          re.test(userText) ||
          lower.includes(`enable ${g}`) ||
          lower.includes(`use ${g}`) ||
          lower.includes(`with ${g}`) ||
          lower.includes(`via ${g}`) ||
          lower.includes(`activate ${g}`);
      }
      if (requested) this.enableLazyGroup(g);
    }
  }

  /** Move one on-demand group's tools into the active definition set for this session. */
  private enableLazyGroup(group: string): void {
    if (this.enabledLazyGroups.has(group)) return;
    this.enabledLazyGroups.add(group);
    for (const [name, tool] of Object.entries(this.lazyTools)) {
      if (this.tools[name]) continue; // already active
      if (group === FIRST_PARTY_GROUP) {
        if (name.includes("__")) continue; // only first-party helpers
      } else {
        const g = name.includes("__") ? name.split("__")[0] : null;
        if (g !== group) continue;
      }
      this.tools[name] = tool;
      this.toolDefinitions.push(tool.definition);
    }
    this.config.onEvent({ type: "group-enabled", group });
  }

  /** Run one user turn to completion. Images are data URLs (vision models only). */
  async send(userText: string, images?: string[]): Promise<void> {
    const { onEvent, requestApproval } = this.config;
    const maxIter = this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const content: ChatMessage["content"] = images?.length
      ? [{ type: "text", text: userText }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))]
      : userText;
    this.messages.push({ role: "user", content });
    this.abort = new AbortController();
    // Each send() is one undo unit: start capturing this turn's file states.
    this.journal.beginTurn();

    try {
      await this.maybeCompact();
      // Attach any on-demand tool group the user just asked for by name.
      this.activateLazyToolsFor(userText);
      for (let iter = 0; iter < maxIter; iter++) {
        let streamedText = "";
        const { message, usage } = await this.client.complete(
          this.config.model,
          this.messages,
          this.toolDefinitions,
          (delta) => {
            streamedText += delta;
            onEvent({ type: "text-delta", text: delta });
          },
          this.abort.signal
        );
        this.totalCredits += usage.credits_used ?? 0;
        onEvent({ type: "turn-done", usage });
        this.messages.push(message);
        if (streamedText) onEvent({ type: "text-done", text: streamedText });

        if (!message.tool_calls?.length) {
          onEvent({ type: "agent-done", finalText: contentText(message.content), totalCredits: this.totalCredits });
          return;
        }

        for (const call of message.tool_calls) {
          const result = await this.executeToolCall(call, requestApproval);
          this.messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
      }
      const msg = `Stopped after ${maxIter} iterations without a final answer. This usually means the model kept calling tools instead of answering. Try again, or ask Cascade to break the task into smaller steps.`;
      onEvent({ type: "error", message: msg });
    } catch (e: unknown) {
      if (this.abort.signal.aborted) {
        onEvent({ type: "error", message: "Stopped by user." });
      } else {
        // Log the failing model + raw error so repeated failures across models
        // (the "[gab.ai error] The model failed to generate a response" banner)
        // become diagnosable instead of a dead end for the user.
        console.error(`[cascade] model "${this.config.model}" failed:`, e);
        onEvent({ type: "error", message: friendlyApiError(e) });
      }
    }
  }

  /** Fold old turns into a summary when the conversation gets large. */
  private async maybeCompact(): Promise<void> {
    const plan = planCompaction(this.messages);
    if (!plan) return;
    try {
      const { text } = await this.client.completeOnce(COMPACT_MODEL, summaryPrompt(plan.toSummarize));
      if (text.trim()) {
        this.messages = [plan.keep[0], summaryMessage(text.trim()), ...plan.keep.slice(1)];
      }
    } catch {
      // Compaction is an optimization; on failure keep full history and let
      // the provider reject the request if it truly exceeds the window.
    }
  }

  private async executeToolCall(
    call: ToolCall,
    requestApproval: AgentConfig["requestApproval"]
  ): Promise<string> {
    const { onEvent, workspaceRoot } = this.config;
    const spec = this.tools[call.function.name];
    if (!spec) return `ERROR: unknown tool ${call.function.name}`;

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return `ERROR: tool arguments were not valid JSON`;
    }

    onEvent({ type: "tool-start", call: { name: call.function.name, args } });

    const group = call.function.name.includes("__") ? call.function.name.split("__")[0] : null;
    const preApproved =
      this.sessionAllowed.has(call.function.name) || (group !== null && this.sessionAllowedGroups.has(group));

    if (spec.requiresApproval && !preApproved) {
      let req;
      try {
        req = spec.describe
          ? spec.describe(args, workspaceRoot)
          : {
              tool: call.function.name,
              summary: `Call ${call.function.name}`,
              detail: JSON.stringify(args, null, 2).slice(0, 2000),
            };
      } catch (e) {
        return `ERROR: ${e instanceof Error ? e.message : e}`;
      }
      const decision = await requestApproval(req);
      if (decision === "deny") {
        const result = "DENIED: the user rejected this action.";
        onEvent({ type: "tool-result", name: call.function.name, result, isError: true });
        return result;
      }
      if (decision === "allow-session") this.sessionAllowed.add(call.function.name);
      if (decision === "allow-group-session") {
        if (group) this.sessionAllowedGroups.add(group);
        else this.sessionAllowed.add(call.function.name); // no group → same as allow-session
      }
    }

    // Snapshot the target file(s) before a mutating file tool runs, so the
    // turn can be undone. Reads (resolveSafe with mustExist) aren't journaled.
    if (call.function.name === "write_file" || call.function.name === "edit_file") {
      const rel = args.path;
      if (typeof rel === "string") {
        try {
          this.journal.snapshotFile(resolveSafe(workspaceRoot, rel));
        } catch {
          // Path escapes/errors will surface from the tool run itself.
        }
      }
    }

    let result: string;
    let images: string[] | undefined;
    let isError = false;
    try {
      const out = await spec.run(args, workspaceRoot);
      result = typeof out === "string" ? out : out.text;
      images = typeof out === "string" ? undefined : out.images;
      isError = result.startsWith("ERROR");
    } catch (e: unknown) {
      isError = true;
      result = e instanceof WorkspaceError ? `ERROR: ${e.message}` : `ERROR: ${String(e)}`;
    }
    onEvent({ type: "tool-result", name: call.function.name, result, isError, images });
    return result;
  }
}

/** Escape a string for literal use inside a RegExp (for group-name matching). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);
}