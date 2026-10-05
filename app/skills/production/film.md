---
namespace: production
kind: sequential
triggers: make a short film, create a film, produce an animation, storyboard a script, animate a script, use cascade productions, production assistant
---
Produces a short film end-to-end inside a Cascade production using the cascade_* tools, so the script, frames, and clips are all written into the production folder.

# production:film

Purpose: when the user asks for a film, an animation, or a short, do the work
**through Cascade** instead of as loose files. The `cascade_*` tools register a
real production and run the app's own pipeline, so every asset lands in the
production folder where the Production Assistant, the animatic, and the export
expect to find it.

## Ground rules

- Use the `cascade_*` tools for **every** generation. They route to the
  production's configured media provider (OpenArt or Higgsfield) for you — you
  do not pick a vendor. Do **not** call raw `openart_*` MCP generation tools for
  a film, and never generate a file some other way and copy it into the
  production folder: those assets are not registered and won't feed later steps.
  (`openart_upload_reference` is only the desktop file-picker for the user's own
  media, not a generation path.) If a `cascade_*` tool fails, report it; do not
  route around it.
- **References attach only when a shot cites them.** A character sheet or
  reference image is uploaded to a frame's generation only if that shot's prompt
  contains an `@[Name]` tag. Creating a sheet is not enough — you must cite it
  (via `cascade_generate_magic_prompts`, or `@[Name]` in a shot prompt, or the
  `references` list on a video call). Do this for every character/prop that
  should appear.
- The production's **Style is applied automatically** to both frames and videos
  by the tools. Do not paste style language into prompts; a video `prompt` is
  motion only.
- **Videos must be generated with `cascade_generate_video`**, which attaches the
  shot's storyboard frame as the clip's source. Generate clips **one at a time**;
  after each call, confirm the shot reports `hasVideo: true` in the returned
  plan. If a clip didn't register (the vendor job outlived the call), call
  `cascade_recheck_video` for that shot before moving on.
- **Model ids come from `cascade_list_models`** (they are provider-namespaced —
  pass them verbatim). Before generating with a specific model, call
  `cascade_model_options` for it to read the durations and resolutions it
  accepts and its schema flags (including audio toggles). A video model
  **rejects** a `durationSec` it doesn't list — it is not coerced — and silently
  ignores an unsupported resolution, so read the options first. If
  `cascade_list_models` is empty, the provider isn't connected; for Higgsfield
  CLI that means installing the `higgsfield` binary and running
  `higgsfield auth login`.
- **Two different durations, don't conflate them.** `cascade_generate_video`'s
  `durationSec` is the generated *clip* length (must be a value the model
  supports); a shot's `durationSec` (set by `cascade_plan_animatic`) is its
  *animatic window*. Assembly trims/fits the clip to the shot window, so a
  longer clip than the window is fine.
- **Shot durations live on the shot (`durationSec`).** They are unset until you
  plan them; assembly then defaults to 3s per shot. If the user cares about the
  total runtime, call `cascade_plan_animatic` to assign per-shot durations from
  the script's timing, and pass the desired length as guidance. Assembly trims
  or fits each clip to its shot's `durationSec` — you do not need to trim clips
  yourself.
- **Before assembling, verify the timeline.** Every shot should have
  `hasVideo: true`, or be an intentional still. `cascade_assemble` warns loudly
  when a shot with a video generation has no registered clip; treat that warning
  as a blocker — reclaim or regenerate those shots, then assemble again. Never
  deliver a render that carries that warning.
- You cannot see or hear the generated media (frames/clips come back as bytes,
  not viewable images). Do not claim visual or audio quality — say what you
  generated and let the user review it in the Production Assistant.
- The active production is the default target. When you create one, keep the
  returned `id` and pass it as `productionId` on later calls.
- Generation costs credits and time. Agree the plan (shot count, style, clip
  lengths) with the user first, and use `maxShots` to cap an initial pass.

## Workflow

1. **Discover.** Call `cascade_list_productions`. If the user already has a
   production open, call it again with that `productionId` to get the full plan
   (style, characters, references, scenes, shots, durations) and reuse what
   exists. If there is none, or the user wants a new one, call
   `cascade_create_production` with a name and an agreed parent `folder`.
2. **Write and ingest the script (Step 1).** Write the screenplay to a file
   with `write_file` (plain text `.txt`/`.md` or Fountain). Then call
   `cascade_ingest_script` with that path (or a Google Docs share URL). This
   splits it into scenes and 4-digit-numbered shots and writes `script.md`.
   Re-read the shots with `cascade_list_productions`; fix errors by editing the
   source and re-ingesting.
3. **Design (Step 2).** `cascade_set_style` with a name and a full style prompt
   (medium, rendering, palette, lighting — no story content). Anchor it with
   `cascade_generate_style_frame`. For each character call
   `cascade_generate_character_sheet` with a concrete visual description; cite
   other references by name with `@[Name]` tags in the description.
4. **Wire references (Step 3, before the storyboard).** Call
   `cascade_generate_magic_prompts` to write a content prompt for every shot
   that cites the references each shot actually contains. This is what makes the
   character sheets and prop images upload during generation. If you need finer
   control, use `cascade_set_shot_prompt` per shot and include `@[Name]` for
   every reference that appears in that frame.
5. **Storyboard (Step 3).** Call `cascade_generate_storyboard`. With no
   `shotIds` it fills every missing frame; pass `shotIds` (from
   `cascade_list_productions`) to regenerate specific shots. Frames are saved in
   the production's `boards/` folder with the style frame and each cited
   reference attached.
6. **Plan timing (Step 4, optional).** If the user wants a specific runtime,
   call `cascade_plan_animatic` to assign each shot a `durationSec` from the
   script. Confirm the resulting per-shot durations in the returned plan.
7. **Animatic video (Step 4).** Pick a video model with `cascade_list_models`,
   read its accepted durations/resolutions with `cascade_model_options`, then for
   each shot, one at a time, call `cascade_generate_video` with its `shotId`, a
   motion prompt, a supported `durationSec`, and a `references` list naming any
   characters or props that move in the shot. Confirm `hasVideo: true` for the
   shot before the next one; if not, call `cascade_recheck_video` for it. The
   clip is generated from the shot's frame, carries the production style
   automatically, and drives the shot's animatic window.
8. **Export (Step 5).** Call `cascade_assemble` with `render: true` to gather
   frames/clips/audio into `out/assembly/`, write the EDL / After Effects
   script / manifest, and encode `out/assembly/render.mp4`. Read the returned
   warnings: if it flags suspicious stills or blanks, fix those shots and
   assemble again before reporting success.
9. **Report.** Tell the user the production name, its folder path, the runtime,
   what was generated, and what to review in the Production Assistant. Be honest
   that you could not see the frames/clips.

## Reference

| Tool | Stage | What it does |
|---|---|---|
| `cascade_list_productions` | any | List productions, or dump one production's full plan. |
| `cascade_list_models` | any | List the provider's real (namespaced) model ids; `includeOptions` also fetches durations/resolutions. |
| `cascade_model_options` | any | Read one model's accepted durations/resolutions and schema flags (incl. audio). |
| `cascade_create_production` | 1 | Create + register a production (script.md, references/, boards/, out/…). |
| `cascade_import_production` | 1 | Adopt an existing production folder. |
| `cascade_ingest_script` | 1 | Break a screenplay into scenes/shots. |
| `cascade_set_style` | 2 | Set the production's master visual style. |
| `cascade_generate_style_frame` | 2 | Generate the style look-anchor frame. |
| `cascade_generate_character_sheet` | 2 | Generate a character-sheet reference. |
| `cascade_generate_magic_prompts` | 3 | Write per-shot prompts that cite references as `@[Name]`. |
| `cascade_set_shot_prompt` | 3 | Set one shot's prompt (cite references with `@[Name]`). |
| `cascade_generate_storyboard` | 3 | Generate/regenerate storyboard frames (attaches cited refs + style). |
| `cascade_plan_animatic` | 4 | Assign per-shot durations (`durationSec`) for a target runtime. |
| `cascade_generate_video` | 4 | Generate a shot's clip from its frame (style applied; cite refs). |
| `cascade_recheck_video` | 4 | Reclaim a still-rendering clip so it registers. |
| `cascade_assemble` | 5 | Build the export package (and optionally render MP4); warns on missing clips. |

This skill builds the production. Editing the app's own source code is a
different task.
