# Cascade — Build Plan

A desktop agent app (Cowork-style) that chats with AI, creates/edits local files, runs shell commands, and connects to MCP servers — powered by the Gab.ai API.

Each phase below is written so it can be handed to a coding agent (Claude Code, etc.) as a self-contained work order. Build phases in order; each ends with something you can run and test.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Shell | **Electron** + TypeScript | Best-documented desktop framework; coding agents know it deeply. (Tauri is lighter but Rust makes AI-assisted iteration slower.) |
| UI | React + Vite + Tailwind | Standard, agent-friendly |
| AI client | `openai` npm SDK pointed at `https://gab.ai/v1` | Gab is OpenAI-compatible; zero custom HTTP code |
| MCP (Phase 4) | `@modelcontextprotocol/sdk` | Official MCP client library |
| Storage | JSON files in app data dir (sessions, settings); no database | Simplest thing that works |

**Architecture:** Electron **main process** owns everything privileged — the agent loop, file tools, shell execution, API key. The **renderer** is a dumb chat UI talking to main over IPC. Never expose Node APIs or the API key to the renderer.

```
┌─────────────── Renderer (React) ───────────────┐
│  Chat view · streaming output · approval modals │
└──────────────────── IPC ───────────────────────┘
┌─────────────── Main process ───────────────────┐
│  Agent loop → Gab.ai API (tool-calling)         │
│  Tool registry: fs tools · shell · (MCP later)  │
│  Permission gate · session store · settings     │
└────────────────────────────────────────────────┘
```

---

## Phase 0 — API spike (do this first, ~half a day)

The whole product depends on one question: **which Gab models do reliable multi-turn tool calling?** Gab aggregates many models (GPT-5.x, Claude, Gemini, DeepSeek, etc.) and the docs don't state per-model tool support.

1. Get a Gab **Plus** subscription and an API key (`/v1/api-keys`).
2. Call `GET /v1/models` — save the full response; note context windows and credit costs.
3. Write a ~50-line Node script: define 2 fake tools (`read_file`, `write_file`), send a prompt requiring both, verify the model emits well-formed `tool_calls` and handles the tool-result round trip over 3+ turns.
4. Test with streaming (`stream: true`) — tool-call deltas must parse correctly.
5. Rank the top 2–3 models by tool-calling reliability and cost. Pick a default.

**Exit criteria:** a script that completes a 3-turn tool loop against Gab, and a chosen default model. If chat/completions tool calling is flaky, test `/v1/responses` (Codex-style function-call loops) and `/v1/messages` (Anthropic format) as fallbacks before proceeding.

### ✅ Phase 0 results (2026-08-04)

All six candidates passed both the multi-turn tool loop and streaming tool-call assembly. Cost per identical 3-turn loop:

| Model | Credits/loop |
|---|---|
| arya | 3 |
| gemini-36-flash | 24 |
| kimi-k3 | 24 |
| claude-sonnet-5 | 45 |
| gpt-5-6-terra | 54 |
| claude-fable-5 | 138 |

**Follow-up finding (probe, same day):** streaming responses carry NO usage object (`stream_options.include_usage` is ignored), and billing lags the request — so live cost display must come from polling `/v1/credits`, not from response usage. Non-streaming responses do report `credits_used`.

Account: 2,000 credits/month (Plus) + purchased top-ups. **Implication:** real agent sessions (10–30+ turns, growing context) make the premium models impractical as defaults — cost management is a first-class product concern. Use `arya` during development to preserve credits. Test script: `phase0/test-tool-calling.mjs`; raw data: `phase0/results.json`, `phase0/models.json`.

---

## Phase 1 — Agent core (no UI yet)

A Node/TypeScript package (`packages/core`) implementing the agent loop as a library, testable from a CLI harness.

- **Agent loop:** send messages + tool schemas → if response has `tool_calls`, execute them, append results, repeat until a plain text answer or max-iterations (~25).
- **Tools (v1 set):**
  - `read_file(path, offset?, limit?)`
  - `write_file(path, content)`
  - `edit_file(path, old_string, new_string)` — exact-match replace
  - `list_directory(path)`, `glob(pattern)`, `grep(pattern, path)`
  - `bash(command, timeout?)` — via `child_process`, cwd = workspace folder
- **Workspace confinement:** every path is resolved and must stay inside the user-selected workspace folder. Reject `..` escapes and symlink escapes.
- **Streaming:** surface text deltas and tool-call events via an EventEmitter/callback interface the UI can subscribe to later.
- **Resilience:** 120–210s read timeouts, retry 504s with backoff (per Gab docs), track `usage.credits_used` per request.
- **System prompt:** Cascade identity, tool usage guidance, workspace path.

**Exit criteria:** from a CLI harness, "create hello.py that prints hello and run it" works end to end. Unit tests for path confinement and the edit tool.

---

## Phase 2 — Desktop UI

Electron app wrapping the core.

- Chat window: markdown rendering, streamed responses, collapsible tool-call cards (show command/diff, then result).
- Workspace picker (native folder dialog) — required before the agent can act.
- **Permission gate:** file writes/edits and every shell command require explicit user approval via modal, with "always allow for this session" option. Reads can be auto-allowed inside the workspace.
- Settings screen: API key (stored with Electron `safeStorage`, never in plain text), model picker (populated from `/v1/models`), credit balance display (`/v1/credits`).
- Session persistence: save/restore conversations as JSON; sidebar to switch sessions.
- Stop button that aborts the in-flight request/loop.

**Exit criteria:** a non-developer can install the app, paste an API key, pick a folder, and have Cascade create and edit files with approval prompts.

---

## Phase 3 — Hardening & context management ✅ (core items done 2026-08-04; packaging/auto-update deferred)

- **Context window management:** track token usage; when nearing the model limit, summarize older turns (cheap model) and continue.
- Shell safety: command timeout, output truncation (~10k chars), block obviously destructive patterns unless explicitly approved (`rm -rf /`, format, etc.).
- Error UX: credit exhaustion, rate limits (10k req/day — read `X-RateLimit-*` headers), network loss mid-stream.
- Cost display: running credits-used counter per session.
- Auto-updates (electron-updater) + code signing; packaging for Windows (NSIS) first, macOS later.

---

## Phase 4 — MCP support ✅ (2026-08-04; verified live against @modelcontextprotocol/server-everything)

- MCP client manager in main process using `@modelcontextprotocol/sdk`: launch/connect stdio servers and streamable-HTTP servers from a user-editable config (same JSON shape as Claude Desktop's `mcpServers` for easy copy-paste).
- On connect: `tools/list` each server, namespace as `servername__toolname`, merge into the agent's tool schema.
- Route MCP tool calls through the same permission gate.
- Settings UI: add/remove servers, connection status, per-server enable toggle.

**Exit criteria:** connect a filesystem or Slack MCP server from a pasted config and use its tools in chat.

---

## Phase 5 — Cowork-style extras (skills ✅, image input ✅, model picker w/ cost pips ✅, MCP OAuth ✅, per-chat folders ✅ — 2026-08-04)

- Skills: markdown instruction files in `~/.cascade/skills/` auto-offered to the agent.
- Sub-tasks/plans: agent-maintained todo list rendered in the UI.
- Image support: Gab vision input (base64 to vision-capable models) and image generation (`/v1/images/generations`).
- Scheduled/recurring tasks; artifact/preview pane for HTML output.

---

## Risks & realities

- **Tool-calling fidelity is the #1 risk.** Aggregator APIs sometimes degrade tool schemas or streaming tool-call chunks. Phase 0 exists to catch this before you invest in UI. Keep the `/v1/messages` (Anthropic-format) path as a fallback design.
- **No prompt caching** is mentioned in Gab's docs — long agent sessions resend the full conversation every turn, so credits scale with conversation length. Context summarization (Phase 3) matters more than usual.
- **Security:** an agent that writes files and runs shell commands is dangerous by design. The permission gate and workspace confinement are not optional polish — build them in Phase 1–2, not later.
- **Requires Gab Plus** for every user; there's no free API tier. Factor that into who Cascade is for.

## Suggested order of effort

Phase 0: 0.5 day · Phase 1: 3–5 days · Phase 2: 5–8 days · Phase 3: 3–4 days · Phase 4: 3–5 days — roughly 3–4 working weeks of AI-assisted building to a solid MCP-capable v1.
