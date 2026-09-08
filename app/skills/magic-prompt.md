# Magic Prompt — AI assisted storyboard content prompts

Generates content-only image prompts for the full storyboard by analyzing the script and its visual direction. The style system stays separate — these prompts must NOT include any style language.

## Purpose
Turn the entire shot list (audio + visual direction + references) into cohesive, production-ready **content** prompts. Each prompt describes *what* is in the frame, not *how* it should be rendered.

## When to use
- User clicks "Magic Prompt" in Storyboard (Step 3) to generate/enable content prompts for all shots at once.
- User clicks refresh to regenerate the set.

## Generation parameters

### Model
- Use the production's configured chat model (`settings.getModel()` via ChatClient) — a fast, JSON-capable model (e.g. `arya`/`gpt-4o-mini` class). No image input needed.
- Temperature: default (0.7). Max tokens: ~8000 for full storyboard (scale with shot count).

### System message
You are a cinematic storyboard prompt engineer for an animation pipeline.
You reply with JSON only — no prose, no markdown fences.
You write CONTENT prompts only — never style language.

### User prompt template
```
You are a storyboard image-prompt generator. Analyze the full script and visual direction and produce a CONTENT-ONLY prompt for each shot.

Rules:
- CONTENT ONLY: Describe subject, framing, action, camera (wide/medium/closeup), composition, key props and characters, setting, time of day, mood conveyed by content. 
- NEVER include style words: no medium, palette, lighting style, line treatment, rendering, brush, painterly, photorealistic, 3D, anime, etc. The style system will handle that.
- Keep each prompt to 1-3 sentences, concrete and visual, suitable to append after a "Style:" paragraph.
- Understand flow: track continuity across shots — maintain character presence, location progression, action continuity, and shot-to-shot rhythm. Adjacent shots should read as a visual sequence, not isolated images.
- Include ALL elements needed in each frame: foreground/background elements, character count and placement, key objects from references when tagged, and any text-implied visuals (e.g. SFX sources).
- Respect @[Name] reference tags if present — keep them verbatim when that reference should appear in the frame; omit when not needed for this shot's content.
- Do NOT invent dialogue or off-screen elements. If audio is provided, use it only to infer what should be visible (speaker, mouth, context) — don't quote it.

Shots (in order):
{{SHOT_LIST}}

References available (name — will be inserted as @[Name] where needed):
{{REF_LIST}}

Reply with JSON only: { "prompts": [ { "number": "0100", "prompt": "..." }, ... ] }
Order must match the shot numbers given, one entry per shot.
```

Where `{{SHOT_LIST}}` is each shot as `number | audio: ... | visual: ... | currentContent: ...` (currentContent is the auto-derived or manually edited content paragraph, stripped of Style/Brand).
Where `{{REF_LIST}}` is the union of characters/products/references names.

### Post-processing
- Validate JSON via parseJsonLooseObject. Expect { prompts: [] }.
- Trim each prompt to ≤ 600 chars, strip leading "Style:" or "Brand identity:" if model leaked them.
- Missing shots: fall back to the shot's visual text.
- Return Record<shotId, contentPrompt> by matching number→shot.id.

### Example (abridged)
Input shot 0100: audio "Hello there." visual "Wide shot of a market at dawn, stalls opening."
Output 0100 content: "Wide establishing shot of a dawn market, stalls half-open, early light, a single figure at center mid-distance, crates and canvas awnings in midground, quiet street depth behind."

## Notes for maintainers
- To tweak tone, length, or camera vocabulary, edit this file only — pipeline.ts loads it at runtime (fallback embedded).
- Keep prompts content-only; any style leakage will be stripped, but costs tokens.
