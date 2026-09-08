# Plan — Cascade Internal-Tool Pitch Deck (Canva-editable PPTX)

## Goal
Produce an aesthetically designed, colorful presentation pitching **Cascade** as an internal
tool for the production company, delivered as a **16:9 PowerPoint file (.pptx)** — the one
format Canva imports cleanly (Canva → *Create a design → Import file*), so it can be edited
there later and screenshots dropped into placeholders.

## Hard content rules (from the user)
- **Never mention Gab AI.** The story is: **Bring Your Own API Key** — the studio pays
  providers directly, no platform markup, no new subscriptions.
- Supported generation providers: **OpenArt and Higgsfield** (image; Higgsfield also video).
- **Part 1 — Operations:** centralizing AI use, replacing the Boords subscription, expense tracking.
- **Part 2 — Artistic tools & process unification:** the guided 5-step pipeline, consistency
  tooling, motion tools, animatic + editor handoff.
- Colorful, designed look; dashed **screenshot placeholder boxes** the user replaces later.

## Grounding (verified in source, `D:\Cascade\app\src`)
- **Ledger** (`src/main/ledger.ts`): every in-app generation auto-priced via studio pricing
  rules (image & video, model/resolution/duration), manual "purchased asset" rows, running
  totals, CSV export, price-rule templates + CSV import/export.
- **Storyboard** (`src/main/storyboard-pdf.ts`, `shotter.ts`): board grid, 4-digit 100-grid shot
  numbering (slots for inserts), printable storyboard PDF export.
- **Pipeline** (`src/main/pipeline.ts`): script → scenes/shots breakdown, character & product
  reference sheets, up-to-5 named style set + style-from-image, Magic Prompt (content-only
  per-shot prompts), parallel board generation, per-shot retries/imports, reference tags `@[name]`.
- **Motion** (`NodeGraphModal.tsx`, `TweenTimelineModal.tsx`, `assembly.ts`): node-graph
  generation with tween/in-between blocks; video shots mix with stills on the animatic timeline.
- **Assembly** (`src/main/assembly.ts`): CMX3600 EDL, After Effects JSX rebuild script,
  manifest, media folder, in-app ffmpeg 3-pass animatic render with VO + music mix.
- Desktop Windows app (Electron) — one install per workstation; agent chat, skills, custom agents.

## Existing draft
`build_deck.py` (root) is a prior 14-slide draft of this same pitch using python-pptx with the
right design system (ink/cream alternating slides; coral/amber/teal/violet/pink accents;
Trebuchet MS — a font Canva carries). No `.pptx` exists yet. **Plan: rewrite this script in
place** as v2 (improved structure + 2 new slides), run it, and deliver the deck.

## Deliverable
`Cascade_Pitch.pptx` — 15 slides, 13.33×7.5 in (16:9):

| # | Slide | Look |
|---|-------|------|
| 1 | **Title** — "Cascade · The studio's AI production desk" + chips: Bring Your Own API Key · OpenArt · Higgsfield · No new subscriptions | dark ink, color blobs |
| 2 | **The problem** — 4 cards: scattered accounts, zero cost visibility, subscription sprawl, broken handoffs | cream |
| 3 | **Meet Cascade** — one desktop app; feature chips + main-window placeholder | dark |
| 4 | **Divider — Part 01 Operations** (Centralize / Consolidate / Track spend) | dark, giant "01" |
| 5 | **Centralize AI use** — one app, studio-owned API keys (governance, no personal accounts), shared agents/skills/presets, one folder per production + placeholder | cream |
| 6 | **Replace Boords** — TODAY vs WITH CASCADE comparison + board/PDF placeholder | dark |
| 7 | **Expense tracking** — auto-priced generations, pricing rules, per-production totals, manual rows, CSV for finance + Expenses placeholder | cream |
| 8 | **Ops recap** — ONE tool / ZERO new subscriptions / 100% of spend visible | dark, stat cards |
| 9 | **Divider — Part 02 The Creative Toolkit** | dark, giant "02" |
| 10 | **The pipeline** — 5 numbered step cards: Script→Shots, Characters & Style, Boards, Timing, Handoff | dark |
| 11 | **Steps 1–2** — script ingestion/auto breakdown, 4-digit numbering, character sheets, style sets + placeholder | cream |
| 12 | **Step 3: boards** — parallel generation, OpenArt/Higgsfield per shot, retries, consistency context + placeholder | dark |
| 13 | **Motion & generation tools** *(new)* — node-graph editing, tween/in-between blocks, video shots mixed with stills + placeholder | cream |
| 14 | **Steps 4–5: animatic & handoff** — durations, ffmpeg render, EDL + AE script + manifest, VO/music mix + placeholder | cream→dark |
| 15 | **The ask** — pilot one production, provision studio keys, cancel Boords at renewal, review ledger in 30 days | dark, closing |

Design system (reused from draft): alternating dark-ink `#1B1740` / cream `#FDF8EF` slides;
accents coral `#FF6B5E`, amber `#FFC145`, teal `#2EC4B6`, violet `#7C5CFF`, pink `#FF5D8F`;
rounded cards with colored top bars, pill chips, colored bullet dots, decorative color-blob
ovals; dashed placeholder boxes labeled "SCREENSHOT — <what to capture>".

## Steps
1. **Rewrite `build_deck.py`** (in place) with the 15-slide structure above, keeping the
   existing helper/design system and improving copy (no Gab AI anywhere — the ChatClient
   vendor is never named; framed purely as BYO-key).
2. **Check tooling** — `py -c "import pptx"`; if missing, `pip install python-pptx`
   (or `py -m pip install python-pptx`).
3. **Run** `py build_deck.py` → generates `Cascade_Pitch.pptx` in the workspace root.
4. **Verify**:
   - Slide count = 15; file opens without corruption (re-open with python-pptx).
   - Extract all text from the pptx and grep for "Gab" / "gab.ai" — must be zero hits.
   - Spot-check that every placeholder names which screenshot goes there.
5. Report to user with the file path + Canva import instructions
   (canva.com → Create a design → Import file → drop the .pptx).

## Notes / risks
- Canva imports PPTX shapes/text cleanly but remaps unsupported fonts; Trebuchet MS is in
  Canva's library, so it survives. Shadows are disabled on shapes for clean import.
- Numbers like "no seat fees / pay only for generations" stay qualitative — no invented pricing.
- The old draft script is overwritten (its content is fully superseded by v2).
