/**
 * No-music video instruction (Settings → Media & Storage, ON by default):
 * when enabled, every video generation prompt gets the no-music line
 * appended at submission time. The append is pure — stored project prompts
 * are never rewritten — and idempotent, so a prompt that already carries
 * the instruction is submitted unchanged. Image prompts never pass through
 * here; the wiring pins at the bottom keep it that way.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  NO_MUSIC_INSTRUCTION,
  appendNoMusicInstruction,
  hasNoMusicInstruction,
} from "../src/shared/no-music.js";

const EXPECTED =
  "No music. Do not add any music or musical score. Audio: diegetic sound only — in-scene sound effects, ambience, and dialogue.";

describe("NO_MUSIC_INSTRUCTION", () => {
  it("is the exact approved wording (dialogue stays allowed)", () => {
    expect(NO_MUSIC_INSTRUCTION).toBe(EXPECTED);
    expect(NO_MUSIC_INSTRUCTION).toContain("dialogue");
  });
});

describe("appendNoMusicInstruction", () => {
  it("appends the instruction as its own paragraph when enabled", () => {
    expect(appendNoMusicInstruction("camera pans left", true)).toBe(
      `camera pans left\n\n${EXPECTED}`
    );
  });

  it("preserves the prompt's own text verbatim ahead of the instruction", () => {
    const prompt = "Style: noir\n\n@[Hero] turns. She says: \"Run.\"";
    expect(appendNoMusicInstruction(prompt, true)).toBe(`${prompt}\n\n${EXPECTED}`);
  });

  it("normalizes trailing whitespace before the separator", () => {
    expect(appendNoMusicInstruction("leaves drift  \n\n", true)).toBe(
      `leaves drift\n\n${EXPECTED}`
    );
  });

  it("returns the prompt unchanged when disabled", () => {
    expect(appendNoMusicInstruction("camera pans left", false)).toBe("camera pans left");
  });

  it("never appends twice (already-present instruction wins)", () => {
    const once = appendNoMusicInstruction("camera pans left", true);
    expect(appendNoMusicInstruction(once, true)).toBe(once);
    expect(once.split(EXPECTED)).toHaveLength(2); // exactly one occurrence
  });

  it("recognizes a hand-pasted copy of the instruction", () => {
    const pasted = `a quiet street. ${EXPECTED}`;
    expect(hasNoMusicInstruction(pasted)).toBe(true);
    expect(appendNoMusicInstruction(pasted, true)).toBe(pasted);
  });

  it("leaves empty prompts empty (optional-prompt submits stay prompt-less)", () => {
    expect(appendNoMusicInstruction("", true)).toBe("");
    expect(appendNoMusicInstruction("   \n ", true)).toBe("   \n ");
  });

  it("hasNoMusicInstruction is false for ordinary prompts, even music-flavored ones", () => {
    expect(hasNoMusicInstruction("a jazz band performs on stage")).toBe(false);
    expect(hasNoMusicInstruction("no music please")).toBe(false);
  });
});

describe("no-music wiring (submit-time only, video only)", () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");

  it("the setting defaults ON in main settings", () => {
    const src = read("../src/main/settings.ts");
    expect(src).toContain("appendNoMusicToVideoPrompts: true");
    // Absent in an older settings.json must also read as ON.
    expect(src).toContain("load().appendNoMusicToVideoPrompts !== false");
  });

  it("every video submit handler in index.ts runs the prompt through the helper", () => {
    const src = read("../src/main/index.ts");
    // classic, video node, sequence, sequence edit, edit-video node, tween.
    const applications = src.match(/clean\.prompt = withNoMusicInstruction\(clean\.prompt\)/g) ?? [];
    expect(applications).toHaveLength(6);
    // The draft-finalize submit sends no prompt (the vendor reuses the
    // draft job's inputs) — it must not gain one from this feature.
    const draft = src.slice(src.indexOf("production:upgradeDraftVideo"), src.indexOf("production:generateSequenceVideo"));
    expect(draft).not.toContain("withNoMusicInstruction");
    expect(draft).toContain('prompt: ""');
  });

  it("no image submit path references the helper", () => {
    const src = read("../src/main/index.ts");
    for (const imageChannel of ["production:generateFrameNode", "production:generateUpscaleNode", "cameraGrid:generate"]) {
      const start = src.indexOf(imageChannel);
      if (start === -1) continue;
      const block = src.slice(start, start + 4000);
      expect(block).not.toContain("NoMusic");
    }
    // Providers stay prompt-pure: the append lives at the submit call
    // sites, so a direct provider call (tests, tools) is never rewritten.
    for (const rel of ["../src/main/providers/openart.ts", "../src/main/providers/openart-cli.ts", "../src/main/providers/higgsfield-cli.ts"]) {
      expect(read(rel)).not.toContain("NoMusic");
    }
  });

  it("the Settings toggle is offered with the approved label", () => {
    const section = read("../src/renderer/src/components/settings/sections/MediaStorageSection.tsx");
    expect(section).toContain("Append no-music instruction to video prompts");
    expect(section).toContain("getAppendNoMusicToVideoPrompts");
    expect(section).toContain("setAppendNoMusicToVideoPrompts");
  });
});
