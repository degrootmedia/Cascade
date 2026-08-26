# Reference Simplification

- [x] Inspect reference ingestion, custom reference, and storyboard prompt flows
- [x] Replace automatic ingest references with a script suggestions panel
- [x] Simplify custom references to image and name
- [x] Add storyboard prompt reference tags and autocomplete
- [x] Run typecheck/build and review the diff

## Review

Implemented and verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Follow-up Review

- Removed legacy custom descriptions from prompt generation and persistence normalization.
- Removed the storyboard refs menu and reference thumbnail strip.
- Frame drops now target the storyboard frame; tagged references provide assignment.
- Autocomplete is positioned near the caret and constrained to the viewport.
- The full-prompt button stays at the lower edge of the prompt field.

## Alias Removal Review

- Removed generated `Reference images by id` text from displayed and submitted prompts.
- Kept legacy-clause stripping so previously saved prompts are cleaned when read.
- Confirmed submission order: `shotReferences` orders artwork, each upload returns `visualReference`, its `id` (or fallback URL) is mapped from `@imageN`, and the mapped value is passed in `visualReferences` to MCP.
- Moved the expand control into the prompt header, opposite the shot number.

## Persistent Prompt And Categories

- Replaced the modal expand prompt with a permanently visible storyboard side panel.
- Kept storyboard content undimmed; clicking any prompt focuses that shot in the side panel.
- Kept ingest discoveries as unassigned suggestions and moved them above manual references in Design.
- Added user-created reference categories with drag-and-drop between category groups.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Layout And Prompt Review

- Expanded storyboard panel width to use the full workspace, keeping the editor on the right.
- Restored script visual/audio direction below the side-panel prompt.
- Removed the redundant prompt field below each frame.
- Replaced copy with a hover magnify control.
- Added persisted Include Brand Identity behavior for each shot.
- Removed duplicate custom-reference rendering and styled category panels with hover-only upper-right deletion.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Frame Controls And Drop Review

- Removed the over-frame magnify control; clicking a frame selects its prompt and clicking the image enlarges it.
- Added a frame-size slider below the storyboard grid.
- Tightened the side panel height and restyled the brand toggle as a switch.
- Added desktop image-file drops to category panels.
- Added spacing below the visual-style list.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Final Frame Interaction Review

- Fixed the frame-size slider to the bottom of the window.
- Removed magnify cursor and image enlargement from frame clicks; frame clicks now only select the prompt.
- Restored hover visibility for edit, regenerate, and import controls.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Prompt And Selection Review

- Removed the eight-reference autocomplete cap.
- Made the prompt textarea fill the flexible portion of the side panel while script direction fits below it.
- Added an accent outline to the selected storyboard frame.
- Restricted category-card dragging to the image itself and reduced reference-name text size.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Interaction Follow-up

- Restored a dedicated hover-only magnify button for frame enlargement.
- Added selected-prompt refresh after storyboard generation/regeneration.
- Incomplete `@` mentions are removed when the editor loses focus.
- Moved MCP logs below storyboard frames and the zoom control.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Style And Categories Review

- Style selection now refreshes the active prompt while preserving non-style text.
- Reference popup now includes all available artwork references.
- Added category renaming through the category header field.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Thumbnail And Category Review

- Style dropdown now updates the selected shot's Style section and refreshes the side panel.
- Added JPEG thumbnail IPC conversion at 480px/quality 72; original project files remain unchanged and full-resolution loading remains available for enlargement.
- Added category renaming in the category header.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Dropped Frame Tag Review

- Dropped storyboard frames now append their generated `@[Frame N]` tag to the destination prompt.
- Existing generated prompt content is preserved when adding the tag.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Duplicate And Model Review

- Dropped frames now reuse an existing matching `Frame N` reference and avoid duplicate tags.
- Storyboard model selection now exposes Auto and image-capable models only.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Storyboard Controls Review

- Removed Import Frames and Scan Import Folder controls from the storyboard page.
- Added hover-only lower-right deletion for the selected shot frame, deleting its current asset while retaining prompt/reference state.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Frame Action Review

- Restored per-frame import and magnify controls with fixed positions.
- Kept frame deletion lower-right and hover-only; empty frames keep the delete control hidden.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Explicit Reference Submission Review

- Kept human `@[name]` tags in the prompt display; transport-only conversion now occurs in the MCP generator.
- Added hover thumbnails for tagged-reference chips.
- Added a Submit frame button to the side panel.
- Restricted generation references to names explicitly tagged in the shot prompt, excluding legacy text matches and shot associations.
- Stabilized prompt refresh by returning the human prompt form from the display IPC path.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Brand Toggle Review

- Manual prompts now add/remove a generated `Brand identity:` section when toggled.
- The toggle is positioned in the prompt-panel header to the right of the shot name.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Manual Prompt Regression Review

- Style changes now replace only a `Style:` paragraph anywhere in a manually edited prompt.
- Turning brand identity off removes only the generated brand paragraph, preserving custom text and tags.
- Submit frame uses the standard reference-panel button styling.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Global Model And Prompt Stability Review

- Serialized prompt saves and made generation wait for the latest queued prompt.
- Prompt selection now reloads from the saved source instead of trusting a card's stale local copy.
- Added the existing model picker to the top navigation so it is available in Chat and Production Assistant.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Prompt Blank-State Review

- Added per-shot prompt caching so switching frames does not briefly show another shot's prompt.
- Added serialized-refresh retries after generation so transient null reads do not blank the side panel.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.

## Model Menu Review

- Top-navigation model menu now opens downward instead of using the chat-footer direction.
- Verified with `npm run typecheck`, `npm run build`, and `git diff --check`.
