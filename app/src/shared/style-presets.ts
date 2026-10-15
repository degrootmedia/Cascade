/**
 * Markdown style presets: one `.md` file per preset in the app-level
 * `style-presets/` folder (userData, seeded on first run — see main), so
 * users can add and edit presets with any text editor. The format is
 * deliberately forgiving:
 *
 *   ---
 *   name: Pencil sketch
 *   ---
 *   <prompt body…>
 *
 * The frontmatter is optional: without it, the first `# Heading` is the
 * name (and is dropped from the prompt), and without that the filename is.
 * A file with an empty prompt body is not a preset.
 */
export interface StylePreset {
  name: string;
  prompt: string;
  /** Bare filename the preset came from (e.g. "pencil-sketch.md"). */
  file: string;
}

function prettifyFileName(file: string): string {
  const base = file.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
  return base ? base[0].toUpperCase() + base.slice(1) : "Untitled style";
}

export function parseStylePreset(text: string, file: string): StylePreset | null {
  const normalized = (text ?? "").replace(/\r\n?/g, "\n");
  let name = "";
  let body = normalized;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (fm) {
    body = normalized.slice(fm[0].length);
    for (const line of fm[1].split("\n")) {
      const m = /^\s*name\s*:\s*(.+?)\s*$/.exec(line);
      if (m) name = m[1].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim();
    }
  }
  if (!name) {
    const heading = /^#\s+(.+?)\s*$/m.exec(body);
    if (heading) {
      name = heading[1].trim();
      body = body.replace(heading[0], "");
    }
  }
  const prompt = body.trim().replace(/\n{3,}/g, "\n\n");
  if (!prompt) return null;
  return { name: name || prettifyFileName(file), prompt, file };
}

/** Presets written into the presets folder on first use. Users can edit or
 *  delete the files afterwards — seeding never overwrites an existing file. */
export const STYLE_PRESET_SEEDS: { file: string; content: string }[] = [
  {
    file: "pencil-sketch.md",
    content: `---
name: Pencil sketch
---
Hand-drawn graphite pencil sketch on warm off-white paper. Visible construction lines and light hatching, soft smudged shading, slightly rough paper grain showing through. Storyboard-panel feel: clear silhouettes and readable poses over fine detail, monochrome with the full range from pale gray to deep charcoal black. No color, no ink outlines, no digital smoothness.
`,
  },
  {
    file: "loose-marker-sketch.md",
    content: `---
name: Loose marker sketch
---
Loose storyboard marker sketch: bold black marker linework with energetic, searching strokes, filled with flat gray marker tones in three values (light, mid, dark). Quick thumbnail energy — gesture and staging read first, details suggested with a few confident lines, white paper highlights left unmarked. Slight marker bleed and overlapping stroke ends. No color, no pencil texture, no photorealism.
`,
  },
];
