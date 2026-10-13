/**
 * The Cascade agent loop.
 *
 * Sends the conversation to the configured OpenAI-compatible provider (see
 * shared/providers.ts for the registry), executes any tool calls (routing
 * mutating ones through the approval gate), appends results, and repeats
 * until the model produces a plain text answer or maxIterations is hit.
 */
import { ChatClient, friendlyApiError } from "./chat.js";
import { TOOLS, parseArgv, assertLaunchable, runCommandArgv, DEFAULT_CMD_TIMEOUT_MS } from "./tools.js";
import { applySandbox, normalizeSandboxMode, sandboxAvailable, sandboxFallbackNotice, type SandboxMode } from "./sandbox.js";
import { systemPrompt, pureChatSystemPrompt } from "./prompts.js";
import { planGate } from "./planmode.js";
import { loadWorkspaceInstructions, resolveSafe, WorkspaceError } from "./workspace.js";
import { FileJournal } from "./journal.js";
import { planCompaction, summaryPrompt, summaryMessage } from "./compact.js";
import { formatVerificationFeedback, maxRepairRounds, passed, runVerification, type VerificationConfig, type VerifyResult } from "./verify.js";
import { contentText, attachmentParts, toolImageContent, type AgentConfig, type AgentTool, type Attachment, type ChatMessage, type ToolCall, type ToolDefinition } from "./types.js";

/** Fallback turn cap for long agentic tasks; the host may override it. */
const DEFAULT_MAX_ITERATIONS = 250;

/** Synthetic lazy group for first-party helper tools that lack an MCP `__` prefix. */
const FIRST_PARTY_GROUP = "firstparty";
/** Natural-language terms that surface the first-party helpers (e.g. the file picker). */
const FIRST_PARTY_TRIGGERS = ["upload", "reference", "picker", "pick a file", "choose a file"];
/** MCP groups that, when enabled, also activate the first-party helpers. */
const FIRST_PARTY_COMPANIONS = ["openart"];

/** What one tool call contributes: the text that becomes the `tool` message,
 *  plus (optionally) image data-URLs the model should also receive — attached
 *  later as a synthetic user turn, and only when `visionEnabled`. */
interface ToolExecution {
  text: string;
  modelImages?: string[];
  /** The tool run errored (or was blocked/denied) — no workspace mutation. */
  isError?: boolean;
  /** The tool mutated the workspace and succeeded (drives verification). */
  mutated?: boolean;
}

export class Agent {
  private messages: ChatMessage[] = [];
  private client: ChatClient;
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
  /** Verification config resolved once per agent (static config or host resolver). */
  private verificationResolved = false;
  private resolvedVerification: VerificationConfig | null = null;
  /** Notices queued during construction (before the host can receive events). */
  private pendingNotices: string[] = [];
  totalCredits = 0;

  constructor(private config: AgentConfig) {
    this.client = new ChatClient(config.apiKey, config.baseUrl);
    const pureChat = config.pureChat === true;
    this.tools = pureChat ? {} : { ...TOOLS, ...config.extraTools };
    this.lazyTools = pureChat ? {} : (config.lazyTools ?? {});
    this.applySandboxToRunCommand(pureChat);
    this.toolDefinitions = Object.values(this.tools).map((t) => t.definition);
    // Session grants are persisted by the host, so a rebuilt agent re-seeds the
    // "always allow" decisions instead of asking again.
    for (const t of config.initialAllowedTools ?? []) this.sessionAllowed.add(t);
    for (const g of config.initialAllowedGroups ?? []) this.sessionAllowedGroups.add(g);
    const lazyNote =
      !pureChat && config.lazyGroupNotes?.length && Object.keys(this.lazyTools).length
        ? `\n\nOptional tools — kept out of the normal request to stay lean. You can use them only after the user explicitly asks by name (for example, "use ${config.lazyGroupNotes[0].name}" or "with ${config.lazyGroupNotes[0].name}"). Available on request:\n` +
          config.lazyGroupNotes.map((g) => `- ${g.name}: ${g.hint}`).join("\n")
        : "";
    this.messages.push({
      role: "system",
      content: pureChat
        ? pureChatSystemPrompt()
        : systemPrompt({
            workspaceRoot: config.workspaceRoot ?? "",
            skills: config.skills,
            instructions: config.workspaceRoot ? loadWorkspaceInstructions(config.workspaceRoot) : "",
            lazyToolsNote: lazyNote,
            agentPrompt: config.agentPrompt,
            planMode: config.planMode,
            autonomousMode: config.autonomousMode,
            hasTodoTools: !pureChat && !!this.tools["todo_write"],
            verificationChecks: config.verificationCommands ?? config.verification?.commands.map((c) => c.name),
          }),
    });
  }

  /** Wrap the built-in run_command in the selected OS sandbox (default none).
   *  An unavailable backend is surfaced to the user, never silently faked. */
  private applySandboxToRunCommand(pureChat: boolean): void {
    const mode = normalizeSandboxMode(this.config.sandbox);
    if (pureChat || mode === "none") return;
    const base = this.tools["run_command"];
    if (!base) return;
    if (!sandboxAvailable(mode)) {
      // Defer the notice: the host's onEvent can't route to this agent until
      // after construction, so flush it on the first send().
      this.pendingNotices.push(sandboxFallbackNotice(mode));
      return;
    }
    this.tools["run_command"] = makeSandboxedRunCommand(base, mode, this.config.workspaceRoot ?? "");
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

  /** Run one user turn to completion. Attachments are files (images, PDFs,
   *  documents) sent as data URLs; images and PDFs go as media parts, plain
   *  text files are inlined so any model can read them. */
  async send(userText: string, attachments?: Attachment[]): Promise<void> {
    const { onEvent, requestApproval } = this.config;
    const maxIter = this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    // Flush any construction-time notices now that the host can route events.
    if (this.pendingNotices.length) {
      for (const text of this.pendingNotices) onEvent({ type: "notice", text });
      this.pendingNotices = [];
    }
    const content: ChatMessage["content"] = attachmentParts(userText, attachments);
    this.messages.push({ role: "user", content });
    this.abort = new AbortController();
    // Each send() is one undo unit: start capturing this turn's file states.
    this.journal.beginTurn();

    try {
      // Attach any on-demand tool group the user just asked for by name.
      this.activateLazyToolsFor(userText);
      // Verification bookkeeping for this turn: `dirty` is set only when a
      // mutating tool actually succeeded; `repairRound` bounds the auto-repair
      // feedback loop. Both are inert unless a verification config resolves.
      let dirty = false;
      let repairRound = 0;
      for (let iter = 0; iter < maxIter; iter++) {
        // Re-check the budget every few iterations: a long autonomous run can
        // push large tool results (production digests, command output) into the
        // history for hundreds of turns. Compacting only once before the loop
        // let the request — and the main-process heap — grow without bound.
        if (iter % 4 === 0) await this.maybeCompact();
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

        const turnImages: string[] = [];
        for (const call of message.tool_calls) {
          const { text, modelImages, mutated } = await this.executeToolCall(call, requestApproval);
          this.messages.push({ role: "tool", tool_call_id: call.id, content: text });
          if (modelImages?.length) turnImages.push(...modelImages);
          if (mutated) dirty = true;
        }
        // Tool images the model asked to see: attach them as ONE user turn
        // after all tool messages (keeps the tool messages contiguous, and a
        // user-message image part is the most widely supported shape). Gated on
        // visionEnabled so a non-vision model is never sent image parts.
        if (this.config.visionEnabled && turnImages.length) {
          this.messages.push({ role: "user", content: toolImageContent(turnImages) });
        }

        // Automated verification: after a mutation, run the configured checks
        // and feed failures back. Never runs on the terminal iteration (there
        // must be room to continue), never in pure chat, and never when the
        // plan gate blocked the mutation (those don't mark `dirty`).
        if (dirty && iter < maxIter - 1) {
          dirty = false;
          const verified = await this.verifyAfterMutation(repairRound);
          if (verified !== null) repairRound = verified;
        }
      }
      const msg = `Stopped after ${maxIter} turns without a final answer. This usually means the model kept calling tools instead of answering. Send "continue" to keep going, or raise the turn limit in Settings → Advanced → Agent.`;
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

  /** Fold old turns into a summary when the conversation gets large. Uses
   *  the provider's cheap background model (config.helperModel) so compaction
   *  never requests a model the active provider doesn't have. */
  private async maybeCompact(): Promise<void> {
    const plan = planCompaction(this.messages);
    if (!plan) return;
    try {
      const { text } = await this.client.completeOnce(this.config.helperModel || this.config.model, summaryPrompt(plan.toSummarize));
      if (text.trim()) {
        this.messages = [plan.keep[0], summaryMessage(text.trim()), ...plan.keep.slice(1)];
      }
    } catch {
      // Compaction is an optimization; on failure keep full history and let
      // the provider reject the request if it truly exceeds the window.
    }
  }

  /**
   * Resolve the verification config once per agent: a statically configured
   * `verification` wins, otherwise the host's `resolveVerification` is asked
   * (at most once) so it can detect checks and obtain consent. Returns null
   * when there's nothing to run.
   */
  private async resolveVerificationConfig(): Promise<VerificationConfig | null> {
    if (this.verificationResolved) return this.resolvedVerification;
    let v: VerificationConfig | null = this.config.verification ?? null;
    if (!v && this.config.resolveVerification) {
      try {
        v = await this.config.resolveVerification();
      } catch {
        v = null;
      }
    }
    this.resolvedVerification = v && Array.isArray(v.commands) && v.commands.length ? v : null;
    this.verificationResolved = true;
    return this.resolvedVerification;
  }

  /**
   * Run configured checks after a successful mutation and feed failures back
   * for a bounded number of repair rounds. Returns the (possibly incremented)
   * repair round, or null when no verification is configured.
   */
  private async verifyAfterMutation(repairRound: number): Promise<number | null> {
    const config = await this.resolveVerificationConfig();
    if (!config) return null;
    const ws = this.config.workspaceRoot ?? "";
    const { onEvent } = this.config;
    onEvent({ type: "verification-start", commands: config.commands.map((c) => c.name) });
    let results: VerifyResult[];
    try {
      const runner = this.config.verificationRunner ?? runVerification;
      results = await runner(config, ws);
    } catch (e) {
      results = [
        {
          name: "verification",
          argv: [],
          exitCode: null,
          timedOut: false,
          output: `ERROR: ${e instanceof Error ? e.message : String(e)}`,
        },
      ];
    }
    onEvent({ type: "verification-result", results });

    const failures = results.filter((r) => !passed(r));
    if (!failures.length) return repairRound;

    const max = maxRepairRounds(config);
    const feedback = formatVerificationFeedback(results);
    if (repairRound < max) {
      const round = repairRound + 1;
      onEvent({ type: "repair-round", round, max });
      this.messages.push({ role: "user", content: feedback });
      return round;
    }
    onEvent({ type: "verification-exhausted", rounds: repairRound });
    this.messages.push({
      role: "user",
      content:
        feedback +
        `\n\nAutomatic repair attempts are exhausted (${repairRound}/${max}). Summarize the remaining failures for the user and stop.`,
    });
    return repairRound;
  }

  private async executeToolCall(
    call: ToolCall,
    requestApproval: AgentConfig["requestApproval"]
  ): Promise<ToolExecution> {
    const { onEvent, workspaceRoot } = this.config;
    const ws = workspaceRoot ?? ""; // pure-chat agents never reach here (no tools)
    const spec = this.tools[call.function.name];
    if (!spec) return { text: `ERROR: unknown tool ${call.function.name}`, isError: true };

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return { text: `ERROR: tool arguments were not valid JSON`, isError: true };
    }

    onEvent({ type: "tool-start", call: { name: call.function.name, args } });

    // Plan mode gates the mutating tools regardless of approval: the user must
    // review and approve the written plan before the agent may change source
    // files. Plan artifacts under .cascade/specs/ are still writable.
    if (this.config.planMode) {
      const gate = planGate(call.function.name, args, ws);
      if (!gate.allowed) {
        onEvent({ type: "tool-result", name: call.function.name, result: gate.message, isError: true });
        return { text: gate.message, isError: true };
      }
    }

    const group = call.function.name.includes("__") ? call.function.name.split("__")[0] : null;
    const preApproved =
      this.sessionAllowed.has(call.function.name) || (group !== null && this.sessionAllowedGroups.has(group));

    if (spec.requiresApproval && !preApproved && !this.config.autonomousMode) {
      let req;
      try {
        req = spec.describe
          ? spec.describe(args, ws)
          : {
              tool: call.function.name,
              summary: `Call ${call.function.name}`,
              detail: JSON.stringify(args, null, 2).slice(0, 2000),
            };
      } catch (e) {
        return { text: `ERROR: ${e instanceof Error ? e.message : e}`, isError: true };
      }
      const decision = await requestApproval(req);
      if (decision === "deny") {
        const result = "DENIED: the user rejected this action.";
        onEvent({ type: "tool-result", name: call.function.name, result, isError: true });
        return { text: result, isError: true };
      }
      if (decision === "allow-session") {
        this.sessionAllowed.add(call.function.name);
        this.config.onApprovalGrant?.({ kind: "tool", value: call.function.name });
      }
      if (decision === "allow-group-session") {
        if (group) {
          this.sessionAllowedGroups.add(group);
          this.config.onApprovalGrant?.({ kind: "group", value: group });
        } else {
          this.sessionAllowed.add(call.function.name); // no group → same as allow-session
          this.config.onApprovalGrant?.({ kind: "tool", value: call.function.name });
        }
      }
    }

    // Snapshot the target file(s) before a mutating file tool runs, so the
    // turn can be undone. Reads (resolveSafe with mustExist) aren't journaled.
    if (call.function.name === "write_file" || call.function.name === "edit_file") {
      const rel = args.path;
      if (typeof rel === "string") {
        try {
          this.journal.snapshotFile(resolveSafe(ws, rel));
        } catch {
          // Path escapes/errors will surface from the tool run itself.
        }
      }
    }

    let result: string;
    let images: string[] | undefined;
    let modelImages: string[] | undefined;
    let isError = false;
    try {
      const out = await spec.run(args, ws);
      result = typeof out === "string" ? out : out.text;
      images = typeof out === "string" ? undefined : out.images;
      modelImages = typeof out === "string" ? undefined : out.modelImages;
      isError = result.startsWith("ERROR");
    } catch (e: unknown) {
      isError = true;
      result = e instanceof WorkspaceError ? `ERROR: ${e.message}` : `ERROR: ${String(e)}`;
    }
    onEvent({ type: "tool-result", name: call.function.name, result, isError, images });
    // A mutating tool that succeeded marks the workspace dirty so the loop can
    // verify; a failed/blocked/denied mutation never does.
    const mutated = spec.requiresApproval === true && !isError;
    return { text: result, modelImages, isError, mutated };
  }
}

/**
 * A `run_command` that transparently routes its argv through the selected
 * sandbox. `describe`/approval come from the base tool; only the spawn gains the
 * backend wrapper (parse + launchability checks are identical to the base).
 */
function makeSandboxedRunCommand(base: AgentTool, mode: SandboxMode, root: string): AgentTool {
  return {
    ...base,
    async run(args, ws) {
      const cmd = typeof args.command === "string" ? args.command : "";
      let argv: string[];
      try {
        argv = parseArgv(cmd);
        assertLaunchable(argv[0]);
      } catch {
        return base.run(args, ws); // base reports the parse/launch error
      }
      const wrapped = applySandbox(argv, mode, ws || root);
      const timeoutMs = Math.min(Number(args.timeout_seconds) || 0, 300) * 1000 || DEFAULT_CMD_TIMEOUT_MS;
      return runCommandArgv(wrapped.argv, ws || root, timeoutMs);
    },
  };
}

/** Escape a string for literal use inside a RegExp (for group-name matching). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);
}