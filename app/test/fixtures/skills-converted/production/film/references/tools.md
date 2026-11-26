# production:film — tool reference

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
