# Magic Prompt — story-aware storyboard content prompts

Generates content-only image prompts for the full storyboard by reading the
WHOLE script first. The style system stays separate — these prompts must NOT
include any style language.

Two identical copies of this file ship (`app/src/main/magic-prompt.md` and
`app/skills/magic-prompt.md`); edit both or neither. `pipeline.ts` sends the
file in full (bounded to 12k chars) as instruction context for every pass.

## How it runs (pipeline.ts owns the structure; this file is the craft)

1. **Story Bible pass** (`buildMagicBibleMessages` / `generateMagicBible`):
   one call over the entire breakdown + reference roster produces a synopsis,
   canonical entities, recorded assumptions, and a per-shot plan (purpose,
   framing, must-cite references). Stored on the production and written to
   `out/magic-bible.md`. Refreshed only when the script/roster changes.
2. **Writing pass** (`buildMagicPromptMessages`): one call per scene chunk
   (≤8 shots), grounded in the bible. Each shot's own script audio/visual is
   AUTHORITATIVE for what it depicts; the bible and flanking shots are
   continuity context only — never depict another shot's beat.
3. **Post-processing** (deterministic, in code): replies are matched to shots
   by number (never positionally), style leakage is stripped, alias tags are
   canonicalized to the user's reference names, user-excluded references are
   removed, and unmatched `@[Name]` citations are reported to the storyboard
   reconciliation queue instead of failing silently.
4. **Per-shot regeneration** reuses the stored bible with the shot's scene
   and neighbours as context; it never rebuilds the bible.

## Content rules (both passes)

- CONTENT ONLY: subject, framing, action, camera (wide/medium/closeup),
  composition, key props and characters, setting, time of day, mood conveyed
  by content. NEVER style words (medium, palette, lighting style, rendering,
  painterly, photorealistic, 3D, anime, …) — the style system handles that.
- One continuous story: track character presence, location progression,
  props, screen direction, and action continuity across cuts. Framing should
  progress with rhythm (establish → medium → close), not repeat one size.
- Reuse the bible's canonical entity descriptors verbatim so the same
  person/place/prop reads identically in every frame.
- Cite ONLY roster references, in canonical `@[Name]` form, exactly when the
  subject is visible. A script name that matches a reference's alias means
  that reference. Never invent a `@[Name]`; unreferenced subjects are plain
  nouns. Style-only references are never cited in content.
- Honour each shot's MUST cite / MUST NOT cite constraints absolutely.
- Where the script is silent, choose sensibly and (in the bible pass) record
  the choice under `assumptions` so later shots agree with it.
- Do NOT invent dialogue or off-screen elements. Audio implies what should
  be visible (speaker, mouth, context) — never quote it.
- Writing pass: 1–3 concrete, visual sentences per shot, suitable to append
  after a "Style:" paragraph. Include foreground/background elements,
  character count and placement, and text-implied visuals (SFX sources).

## Model + reply contracts

- Model: the production's configured chat model (`settings.getModel()`).
  Bible call ≤8000 output tokens; writing calls scale with chunk size.
- Bible reply JSON: `{ synopsis, assumptions[], scenes[{number,title,
  location,timeOfDay,beat}], entities[{name,kind,descriptor,refName?,
  aliases[]}], shotPlans[{number,purpose,framing,present[],mustCite[]}] }`.
  `refName`/`mustCite` entries that don't resolve to the roster are dropped.
- Writing reply JSON: `{ "prompts": [ { "number": "0100", "prompt": "…" } ] }`,
  one entry per shot to write, keyed by exact shot number.

## Notes for maintainers

- Tune craft guidance here; JSON shapes, chunking, and safeguards live in
  `pipeline.ts` (`buildMagicBibleMessages`, `parseMagicBibleReply`,
  `buildMagicPromptMessages`, `applyMagicModelReply`) with tests in
  `app/test/magic-bible.test.ts` and `app/test/magic-regen.test.ts`.
- Safeguards that must not regress: a target shot's stale magic prose is
  never sent (tag names only), gaps fill from the script visual, and a
  failed shot keeps its previous prompt.
