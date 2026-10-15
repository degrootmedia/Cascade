/**
 * Markdown style presets: the parser is forgiving (frontmatter optional,
 * heading/filename fallbacks for the name) and never yields an empty
 * prompt; both bundled seeds parse into usable presets.
 */
import { describe, it, expect } from "vitest";
import { parseStylePreset, STYLE_PRESET_SEEDS } from "../src/shared/style-presets.js";

describe("parseStylePreset", () => {
  it("reads frontmatter name + body prompt", () => {
    const p = parseStylePreset('---\nname: Pencil sketch\n---\nGraphite on paper.\n', "pencil-sketch.md");
    expect(p).toEqual({ name: "Pencil sketch", prompt: "Graphite on paper.", file: "pencil-sketch.md" });
  });

  it("falls back to the first heading (dropped from the prompt), then the filename", () => {
    expect(parseStylePreset("# Ink wash\n\nWet ink, pooled edges.", "ink.md"))
      .toEqual({ name: "Ink wash", prompt: "Wet ink, pooled edges.", file: "ink.md" });
    expect(parseStylePreset("Just a prompt body.", "rough-crayon_look.md"))
      .toEqual({ name: "Rough crayon look", prompt: "Just a prompt body.", file: "rough-crayon_look.md" });
  });

  it("handles CRLF, quoted names, and rejects prompt-less files", () => {
    const p = parseStylePreset('---\r\nname: "Quoted Name"\r\n---\r\nBody.\r\n', "q.md");
    expect(p?.name).toBe("Quoted Name");
    expect(p?.prompt).toBe("Body.");
    expect(parseStylePreset("---\nname: Empty\n---\n", "e.md")).toBeNull();
    expect(parseStylePreset("", "e.md")).toBeNull();
    expect(parseStylePreset("# Only a title", "e.md")).toBeNull();
  });

  it("both bundled seeds parse to name + prompt", () => {
    expect(STYLE_PRESET_SEEDS.length).toBeGreaterThanOrEqual(2);
    for (const seed of STYLE_PRESET_SEEDS) {
      const p = parseStylePreset(seed.content, seed.file);
      expect(p, seed.file).toBeTruthy();
      expect(p!.name.length).toBeGreaterThan(0);
      expect(p!.prompt.length).toBeGreaterThan(40);
    }
    const names = STYLE_PRESET_SEEDS.map((s) => parseStylePreset(s.content, s.file)!.name);
    expect(names).toContain("Pencil sketch");
    expect(names).toContain("Loose marker sketch");
  });
});
