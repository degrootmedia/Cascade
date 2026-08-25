#!/usr/bin/env node
/**
 * Cascade Phase 0 — Gab.ai tool-calling capability test
 *
 * Usage:
 *   node test-tool-calling.mjs                     -> lists available models
 *   node test-tool-calling.mjs arya gpt-5-5 ...    -> tests tool calling on those models
 *
 * Requires: Node 18+ (built-in fetch). API key via GAB_API_KEY env var.
 * Each model test costs a few credits. Results saved to results.json.
 */

const BASE = "https://gab.ai/v1";
const KEY = process.env.GAB_API_KEY;

if (!KEY) {
  console.error("Set your API key first:");
  console.error("  PowerShell:  $env:GAB_API_KEY = \"your-key-here\"");
  console.error("  cmd.exe:     set GAB_API_KEY=your-key-here");
  process.exit(1);
}

const HEADERS = { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` };

// ---------- fake filesystem the tools operate on ----------
function makeFakeFs() {
  return {
    "notes.txt":
      "Meeting notes 2026-08-04:\n- Cascade MVP targets Windows first.\n- Default model TBD pending tool-call tests.\n- Budget: 3-4 weeks.",
  };
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file by path.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path to read" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file, overwriting if it exists.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
];

function runTool(fs, name, args) {
  if (name === "read_file") {
    return fs[args.path] !== undefined ? fs[args.path] : `ERROR: file not found: ${args.path}`;
  }
  if (name === "write_file") {
    fs[args.path] = args.content;
    return `OK: wrote ${args.content.length} chars to ${args.path}`;
  }
  return `ERROR: unknown tool ${name}`;
}

// ---------- API helpers ----------
async function api(path, body, { stream = false } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(BASE + path, {
      method: body ? "POST" : "GET",
      headers: HEADERS,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(210_000),
    });
    if (res.status === 504) {
      console.log(`    (504 timeout, retry ${attempt}/3)`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return stream ? res : res.json();
  }
  throw new Error("gave up after 3 retries (504s)");
}

// ---------- Test 1: multi-turn non-streaming tool loop ----------
async function testLoop(model) {
  const fs = makeFakeFs();
  const messages = [
    {
      role: "system",
      content: "You are a file assistant. Use the provided tools to complete tasks. Always actually call the tools.",
    },
    {
      role: "user",
      content:
        "Read notes.txt, then write a one-sentence summary of it to summary.txt. Then tell me you're done.",
    },
  ];

  let credits = 0;
  let toolCallCount = 0;
  const toolsUsed = new Set();

  for (let turn = 1; turn <= 6; turn++) {
    const resp = await api("/chat/completions", {
      model,
      messages,
      tools: TOOLS,
      max_tokens: 2000,
    });
    credits += resp.usage?.credits_used ?? 0;
    const msg = resp.choices?.[0]?.message;
    if (!msg) throw new Error("no message in response");
    messages.push(msg);

    const calls = msg.tool_calls;
    if (!calls || calls.length === 0) {
      // final answer
      return {
        ok: toolsUsed.has("read_file") && toolsUsed.has("write_file") && fs["summary.txt"] !== undefined,
        turns: turn,
        toolCallCount,
        toolsUsed: [...toolsUsed],
        wroteSummary: fs["summary.txt"] !== undefined,
        summaryContent: fs["summary.txt"]?.slice(0, 120) ?? null,
        finalText: (msg.content || "").slice(0, 120),
        credits,
      };
    }

    for (const call of calls) {
      toolCallCount++;
      let args;
      try {
        args = JSON.parse(call.function.arguments);
      } catch (e) {
        return { ok: false, error: `malformed tool arguments JSON: ${call.function.arguments?.slice(0, 200)}`, credits };
      }
      toolsUsed.add(call.function.name);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: runTool(fs, call.function.name, args),
      });
    }
  }
  return { ok: false, error: "did not finish within 6 turns", toolCallCount, credits };
}

// ---------- Test 2: streaming tool-call deltas ----------
async function testStreaming(model) {
  const res = await api(
    "/chat/completions",
    {
      model,
      messages: [
        { role: "system", content: "Use tools when asked." },
        { role: "user", content: "Read the file notes.txt using the read_file tool." },
      ],
      tools: TOOLS,
      max_tokens: 1000,
      stream: true,
    },
    { stream: true }
  );

  const calls = {}; // index -> {name, args}
  let sawContent = false;
  const decoder = new TextDecoder();
  let buf = "";

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        return { ok: false, error: `unparseable SSE chunk: ${data.slice(0, 150)}` };
      }
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) sawContent = true;
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        calls[i] ??= { name: "", args: "" };
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
      }
    }
  }

  const assembled = Object.values(calls);
  if (assembled.length === 0) {
    return { ok: false, error: "no tool_calls in stream" + (sawContent ? " (model answered in text instead)" : "") };
  }
  for (const c of assembled) {
    try {
      const args = JSON.parse(c.args);
      if (c.name !== "read_file" || !args.path) return { ok: false, error: `unexpected call: ${c.name}(${c.args})` };
    } catch {
      return { ok: false, error: `streamed arguments did not assemble to valid JSON: ${c.args.slice(0, 150)}` };
    }
  }
  return { ok: true, calls: assembled.length };
}

// ---------- main ----------
const candidates = process.argv.slice(2);

const modelsResp = await api("/models");
const models = modelsResp.data ?? modelsResp.models ?? [];

if (candidates.length === 0) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(new URL("./models.json", import.meta.url), JSON.stringify(modelsResp, null, 2));

  const fmt = (v) => {
    if (v == null) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  };
  console.log(`\nAvailable models (${models.length}):\n`);
  for (const m of models) {
    const bits = [m.id, m.provider, m.type, m.capabilities, m.credits_per_request ?? m.cost]
      .map(fmt)
      .filter(Boolean)
      .join("  |  ");
    console.log("  " + bits);
  }
  console.log("\nFull raw response saved to models.json");
  console.log("\nNow pick 3-6 chat models and run, e.g.:");
  console.log("  node test-tool-calling.mjs arya gpt-5-5 claude-opus-5 gemini-3-1-pro deepseek-v4\n");
  console.log("(Use the exact model IDs from the list above.)");
  process.exit(0);
}

const known = new Set(models.map((m) => m.id));
const results = {};

for (const model of candidates) {
  console.log(`\n=== ${model} ${known.has(model) ? "" : "(warning: not in /v1/models list)"} ===`);
  results[model] = {};
  try {
    process.stdout.write("  multi-turn tool loop... ");
    const loop = await testLoop(model);
    results[model].loop = loop;
    console.log(loop.ok ? `PASS (${loop.turns} turns, ${loop.toolCallCount} calls, ${loop.credits} credits)` : `FAIL — ${loop.error ?? JSON.stringify(loop)}`);
  } catch (e) {
    results[model].loop = { ok: false, error: String(e) };
    console.log("ERROR — " + e.message);
  }
  try {
    process.stdout.write("  streaming tool calls...  ");
    const s = await testStreaming(model);
    results[model].streaming = s;
    console.log(s.ok ? "PASS" : `FAIL — ${s.error}`);
  } catch (e) {
    results[model].streaming = { ok: false, error: String(e) };
    console.log("ERROR — " + e.message);
  }
}

// summary
console.log("\n========== SUMMARY ==========");
for (const [model, r] of Object.entries(results)) {
  const verdict = r.loop?.ok && r.streaming?.ok ? "FULL PASS" : r.loop?.ok ? "loop only (stream failed)" : "FAIL";
  const credits = r.loop?.credits != null ? ` — ${r.loop.credits} credits/loop` : "";
  console.log(`  ${model.padEnd(28)} ${verdict}${credits}`);
}

const { writeFileSync } = await import("node:fs");
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(results, null, 2));
console.log("\nDetailed results saved to results.json — share that file back with Claude.");

try {
  const credits = await api("/credits");
  console.log(`Remaining credits: ${JSON.stringify(credits)}`);
} catch {}
