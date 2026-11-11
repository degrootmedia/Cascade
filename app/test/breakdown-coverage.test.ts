/**
 * Script-breakdown audio/visual pairing + coverage (Items 1–4).
 *
 * Scripts written as alternating VO / visual blocks used to come back
 * mis-paired or silently incomplete: the old breakdown prompt defined
 * scenes/shots but never said how visuals are matched to VO. These tests pin:
 *  - the shipped prompt carries the block-pairing rules and the worked
 *    example, immediately before the SCRIPT: placeholder;
 *  - ingest keeps a canned model reply's pairings exactly as returned and
 *    the deterministic coverage check passes on a complete breakdown;
 *  - a reply that drops a script sentence produces a coverage WARNING
 *    naming the dropped line (and one retry whose prompt calls it out),
 *    without blocking ingest.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Production } from "../src/shared/ipc.js";

const hoisted = vi.hoisted(() => ({
  scriptText: "",
  replies: [] as string[],
  prompts: [] as string[],
}));

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(async () => ({ text: hoisted.scriptText, format: "txt" })),
  isGoogleDocUrl: vi.fn(() => false),
}));

vi.mock("@core", () => ({
  ChatClient: class {
    async completeOnce(_model: string, messages: Array<{ role: string; content: string }>): Promise<{ text: string }> {
      hoisted.prompts.push(messages.find((m) => m.role === "user")?.content ?? "");
      const text = hoisted.replies.shift();
      if (text === undefined) throw new Error("no canned model reply queued");
      return { text };
    }
  },
}));

import {
  breakdownPrompt,
  checkBreakdownCoverage,
  ingestScript,
  normalizeScenes,
  parseBreakdownJson,
  splitScriptSentences,
} from "../src/main/pipeline.js";

// ---- fixture: the Item 2 worked example, extended with a third block ------

const FIXTURE_SCRIPT = [
  "VO: Every mile tells a story. The road tests you — your focus, your patience, your rig.",
  "VISUAL: A semi rolls down a two-lane highway at dawn. The driver's hands stay steady on the wheel as the truck takes a curve.",
  "VO: That's why every seat we build starts with one question.",
  "VISUAL: Close on the seat cushion as the driver settles in. The cab rocks gently over a bump; the driver stays level.",
  "VO: So we test every cushion on the roughest roads in the country.",
  "VISUAL: Engineers watch the seat absorb a jolt on a test rig. A gauge needle barely moves.",
].join("\n");

/** Correct pairing: block 1 splits 2-and-2; blocks 2 and 3 keep the whole
 *  VO sentence and take both visual beats (resolved inside the block). */
const CORRECT_SCENES = {
  scenes: [
    {
      title: "Opening",
      shots: [
        { audio: "Every mile tells a story.", visual: "A semi rolls down a two-lane highway at dawn." },
        { audio: "The road tests you — your focus, your patience, your rig.", visual: "The driver's hands stay steady on the wheel as the truck takes a curve." },
        { audio: "That's why every seat we build starts with one question.", visual: "Close on the seat cushion as the driver settles in. The cab rocks gently over a bump; the driver stays level." },
        { audio: "So we test every cushion on the roughest roads in the country.", visual: "Engineers watch the seat absorb a jolt on a test rig. A gauge needle barely moves." },
      ],
    },
  ],
  characters: [] as unknown[],
  products: [] as unknown[],
};

const DROPPED_LINE = "A gauge needle barely moves.";

/** Same reply with DROPPED_LINE silently omitted from the last visual. */
function droppedReply(): string {
  const copy = structuredClone(CORRECT_SCENES);
  copy.scenes[0].shots[3].visual = "Engineers watch the seat absorb a jolt on a test rig.";
  return JSON.stringify(copy);
}

// ---- helpers ---------------------------------------------------------------

const tmpDirs: string[] = [];

function makeProduction(folder: string): Production {
  return {
    meta: { id: "prod-coverage", name: "Coverage Test", folder, createdAt: "", updatedAt: "", stepDone: 0, shotCount: 0 },
    currentStep: 1,
    visualStyle: "",
    styles: [],
    scenes: [],
    characters: [],
    products: [],
    openArt: { model: "auto", resolution: "1k" },
    status: {},
    assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", videosDir: "videos", outDir: "out", referencesDir: "references", assemblyDir: "assembly", modelsDir: "models" },
  } as Production;
}

async function runIngest(replies: string[]) {
  hoisted.scriptText = FIXTURE_SCRIPT;
  hoisted.replies = [...replies];
  hoisted.prompts = [];
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-breakdown-"));
  tmpDirs.push(folder);
  const emitted: Array<{ message: string; level?: string }> = [];
  const p = makeProduction(folder);
  const result = await ingestScript(p, "fixture.txt", "test-key", "test-model", (message, level) => emitted.push({ message, level }));
  return { p: result, emitted, prompts: hoisted.prompts };
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// ---- tests -----------------------------------------------------------------

describe("breakdownPrompt (Items 1–2)", () => {
  const content = breakdownPrompt("SCRIPT BODY").content;

  it("carries the explicit audio/visual alignment procedure", () => {
    expect(content).toContain("FIRST, segment by the script's own structure");
    expect(content).toContain("those labels are authoritative");
    expect(content).toContain("PAIR WITHIN BLOCKS, AND RE-SYNC AT EVERY BLOCK BOUNDARY");
    expect(content).toContain("never let a pairing drift into the next block");
    expect(content).toContain("SEMANTIC CHECK");
    expect(content).toContain("TIMING SANITY: spoken VO runs about 2.5 words per second");
    expect(content).toContain("COVERAGE AND ORDER: use every sentence of the script exactly once");
    expect(content).toContain("BEFORE REPLYING, self-check");
    // Character/product rules and the JSON shape are unchanged.
    expect(content).toContain('List every named CHARACTER that appears ("key": a one-line visual descriptor from the script, "" if none given).');
    expect(content).toContain("List any named PRODUCTS (branded items, packaging, hero objects) that must look consistent.");
    expect(content).toContain('{ "title": "Scene heading or short name", "shots": [ { "audio": "…", "visual": "…" } ] }');
  });

  it("includes the worked example verbatim, immediately before SCRIPT:", () => {
    expect(content).toContain("EXAMPLE — a script in alternating VO/visual blocks, and its correct breakdown:");
    expect(content).toContain('"VO: Every mile tells a story. The road tests you — your focus, your patience, your rig.');
    expect(content).toContain('{ "audio": "That\'s why every seat we build starts with one question.", "visual": "Close on the seat cushion as the driver settles in. The cab rocks gently over a bump; the driver stays level." }');
    expect(content).toContain("Note how the third shot keeps the whole VO sentence and takes both visual beats");
    const exampleAt = content.indexOf("EXAMPLE —");
    const scriptAt = content.indexOf("SCRIPT:\nSCRIPT BODY");
    expect(exampleAt).toBeGreaterThan(-1);
    expect(scriptAt).toBeGreaterThan(exampleAt);
  });

  it("retry variant calls out the missing lines by name", () => {
    const retry = breakdownPrompt("SCRIPT BODY", [DROPPED_LINE]).content;
    expect(retry).toContain("COVERAGE FIX REQUIRED");
    expect(retry).toContain(DROPPED_LINE);
  });
});

describe("splitScriptSentences / checkBreakdownCoverage (Item 3)", () => {
  it("splits the fixture into its 10 sentences, labels stripped, semicolon intact", () => {
    const sentences = splitScriptSentences(FIXTURE_SCRIPT);
    expect(sentences).toHaveLength(10);
    expect(sentences[0]).toBe("Every mile tells a story.");
    expect(sentences).toContain("The cab rocks gently over a bump; the driver stays level.");
    expect(sentences.some((s) => /^(VO|VISUAL):/.test(s))).toBe(false);
  });

  it("passes on the correct pairing, tolerating punctuation/whitespace drift", () => {
    const scenes = normalizeScenes(parseBreakdownJson(JSON.stringify(CORRECT_SCENES)));
    // Curly apostrophe + double spaces + plain hyphen for the em dash.
    scenes[0].shots[1].audio = "The road tests you - your focus,  your patience, your rig.";
    scenes[0].shots[1].visual = "The driver’s hands stay steady on the wheel as the truck takes a curve.";
    expect(checkBreakdownCoverage(FIXTURE_SCRIPT, scenes).missing).toEqual([]);
  });

  it("names a dropped sentence", () => {
    const scenes = normalizeScenes(parseBreakdownJson(droppedReply()));
    expect(checkBreakdownCoverage(FIXTURE_SCRIPT, scenes).missing).toEqual([DROPPED_LINE]);
  });
});

describe("ingestScript with canned model replies (Item 4)", () => {
  it("(a) keeps the returned pairings exactly and passes coverage with no retry", async () => {
    const { p, emitted, prompts } = await runIngest([JSON.stringify(CORRECT_SCENES)]);
    expect(prompts).toHaveLength(1); // coverage passed — no retry call
    const shots = p.scenes.flatMap((s) => s.shots);
    expect(shots.map((s) => [s.audio, s.visual])).toEqual(
      CORRECT_SCENES.scenes[0].shots.map((s) => [s.audio, s.visual]),
    );
    expect(shots.map((s) => s.number)).toEqual(["0100", "0200", "0300", "0400"]);
    expect(emitted.some((e) => /coverage/i.test(e.message))).toBe(false);
    expect(p.status[1]).toBe("done");
  });

  it("(b) warns by name when a sentence is dropped, retries once, and does not block ingest", async () => {
    const { p, emitted, prompts } = await runIngest([droppedReply(), droppedReply()]);
    expect(prompts).toHaveLength(2); // initial + one retry, never more
    expect(prompts[1]).toContain(DROPPED_LINE); // retry prompt calls the line out
    const warning = emitted.find((e) => /coverage warning/i.test(e.message));
    expect(warning).toBeDefined();
    expect(warning!.message).toContain(DROPPED_LINE);
    expect(warning!.level).toBe("error");
    // Not blocked: the (still incomplete) breakdown is ingested.
    expect(p.scenes.flatMap((s) => s.shots)).toHaveLength(4);
    expect(p.status[1]).toBe("done");
  });

  it("(b2) adopts the retry when it restores the dropped line — no warning", async () => {
    const { p, emitted, prompts } = await runIngest([droppedReply(), JSON.stringify(CORRECT_SCENES)]);
    expect(prompts).toHaveLength(2);
    expect(emitted.some((e) => /coverage warning/i.test(e.message))).toBe(false);
    const last = p.scenes.flatMap((s) => s.shots).at(-1)!;
    expect(last.visual).toContain(DROPPED_LINE);
  });
});
