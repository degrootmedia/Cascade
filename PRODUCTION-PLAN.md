# Cascade Production Assistant — Implementation Plan

Feature: a second top-level view ("Production Assistant") that manages an animation
pipeline inside Cascade: script ingestion, character/visual design, shot breakdown,
and final assembly. It complements the existing chat (Home) view rather than replacing it.

This plan mirrors the existing Cascade architecture so each piece slots into the
codebase with minimal churn. Read it alongside `CASCADE-PLAN.md` and `app/src/main/index.ts`.

---

## 0. Current architecture (what we build on)

| Layer | Existing files | Role in the new feature |
|---|---|---|
| Main process | `app/src/main/index.ts` | All privileged work + IPC wiring. New production handlers go here. |
| Persistence patterns | `app/src/main/sessions.ts`, `settings.ts` | JSON-in-userData model; reuse for productions. |
| Agent loop | `core/src/agent.ts` | Tool-calling loop, approval gate, undo journal. We do NOT reuse the chat loop for the pipeline — the pipeline is guided, multi-step orchestration with explicit step objects. |
| LLM client | `core/src/gab.ts` | OpenAI-compatible chat. We add an **image-generation** method here for Step 2. |
| IPC contracts | `app/src/shared/ipc.ts` | Add new `CascadeApi` methods + shared types. |
| UI | `app/src/renderer/src/App.tsx` + `components/` | Add the top-level tab switch + Production Workspace component. |
| Media in/out | `app/src/main/mcp.ts` | Image results already saved to the workspace (`cascade-images/`). Rely on this for rendering generated images. |

**Key design decision:** the Production Assistant is *guided orchestration* (fixed 5-step
pipeline with per-step generators + user review), NOT a free-form agent loop. This keeps it
deterministic and cheap on credits. The existing agent loop is a tool the pipeline can invoke
for script transcription/scene parsing, but the pipeline itself is a dedicated controller.

---

## 1. Top-level view: Home ↔ Production Assistant

**Current** `App.tsx` always renders `Sidebar + resizer + chat`. We introduce a tab strip above
all views and swap the whole body.

### 1.1 Renderer (`app.tsx`)
```tsx
const [view, setView] = useState<"home" | "prod">(initial view from persisted pref);
...
return (
  <div className="app">
    <ViewTabs value={view} onChange={setView} />        // new: Home | Production
    {view === "home" ? (
      <div className="app-home">{/* existing sidebar + chat + modals */}</div>
    ) : (
      <ProductionWorkspace config={{ recents, onSwitchHome: () => setView("home") }} />
    )}
  </div>
);
```
- The chat **Sidebar, resizer, composer, ApprovalModal** are Home-only. Selecting Production
  Assistant hides them (full-bleed workspace).
- Persist the active view in `localStorage` (`cascade.view`), same pattern as `sidebarWidth`.
- `ViewTabs` is a slim, always-on top bar; CSS in `styles.css`. Active tab gets `accent` color.

### 1.2 Main process
No change to `index.ts` for the switch itself — it's purely renderer state. Productions are
loaded on first mount.

---

## 2. Project management (saved productions, not folder-only)

### 2.1 New module `app/src/main/productions.ts`
Mirrors `sessions.ts` but with a production-metadata schema. Storage under
`userData/productions/<id>.json`, plus `userData/productions-index.json` holding the recency list.

```ts
interface ProductionMeta {
  id: string; name: string; folder: string /* abs path */;
  createdAt: string; updatedAt: string;
}
interface ScriptScene {
  number: number;            // scene ordinal 1..N
  title: string;
  shots: Shot[];             // ordered shot list
}
interface Shot {
  id: string;                // stable id (uuid) for reorder/insert
  number: string;            // 4-digit, e.g. "0100"
  audio: string;             // dialogue/sfx line (column A)
  visual: string;            // visual description (column B)
  artwork?: string;          // relative path to storyboard/design asset
}
interface ProductionFile {
  meta: ProductionMeta;
  currentStep: 1|2|3|4|5;
  visualStyle?: string;      // master style descriptor used by generation
  scenes: ScriptScene[];     // populated by Step 1
  characters: CharacterSheet[]; // populated by Step 2
  status: Record<number, "todo"|"running"|"done"|"error">;
  assets: { scriptMd: string; designDir: string; storyDir: string; out: string };
  recentFolders: string[];    // last 10 (also mirrored in settings)
}
```

### 2.2 Recency list (last 10 folders)
- Reuse `settings.ts` `addRecentWorkspace`-style list but under a `recentProductions` key (or
  store in `productions-index.json`). The UI dropdown shows the last 10 in MRU order.
- "New production": native folder dialog (`dialog.showOpenDialog` with `createDirectory`) →
  `production.create(path)` → prompts for a name → writes the JSON to `userData/productions/`.
- "Open previous": pick from MRU list; `production.load(id)` restores the full pipeline state.
- Reopening is safe even if the folder was moved: store the abs path and re-resolve guards in
  Step ingestion (see §3 safety).

### 2.3 IPC surface (add to `CascadeApi` in `shared/ipc.ts` + handlers in `index.ts`)
```
production:list       → ProductionMeta[]
production:create     (name, folder) → ProductionMeta           // dialog handled in main
production:load       (id) → Production
production:save       (prod) → void                             // renderer persists its state
production:recent     → string[]                                  // last 10 folders
production:pickFolder () → string | null                          // native folder dialog
production:pickScript (id) → runs Step 1, returns updated Production
production:runStep    (id, step) → streams progress (see piped:run events)
production:connectFront  (id, mcpName?) → image/audio tool hooks   // Step 2/5
```
All mutating handlers go through the existing approval gate philosophy — but because these are
first-party guided actions on the user's own production folder (not arbitrary model tool calls),
they run with a lighter per-action confirmation rather than a per-tool modal.

---

## 3. Workflow: the five steps

### Step 1 — Script Ingestion (PDF / DOC / DOCX / Google Doc)
Goal: source script → clean text → two-column A/V markdown, scene + shot structure preserved.

**Parsing (deterministic, no LLM):**
- **PDF** → `pdf-parse` (pure-JS PDF text extractor; no external binary, agent-friendly).
  Extract per page; keep paragraph breaks as scene-break heuristics.
- **DOCX** → `mammoth` (npm) to HTML/markdown. Good fidelity for styling (bold = character
  speech emphasis, headings = scene markers).
- **DOC** (legacy binary) → `mammoth` cannot. Two options:
    (a) instruct the user to open/re-save as `.docx` (99% path), or
    (b) optional `libreoffice --headless --convert-to docx` if LibreOffice is installed.
  Choose **(a)** for v1; add (b) as a follow-up. Note this in the UI as the "DOC→DOCX" hint.
- **Google Doc** → read the share link, derive the export URL
  `https://docs.google.com/document/d/<docid>/export?format=docx`, fetch it (must be
  "Anyone with the link" or embed permission), then treat as DOCX. Also offer `format=txt` to
  bypass mammoth. This is the lightest path and needs no Google SDK.

**Step 1b — Scene/shot structure (LLM-guided, using the existing agent):**
Run a **guided sub-task** (not a free agent): pass the extracted text + a fixed prompt that
returns strict JSON `{ scenes: [{ title, shots: [{audio, visual}] }] }`. Enforce scene = paragraph-grouping, and shot = smallest Audio/Visual unit. Write result to
`<folder>/script.md` (two-column markdown for humans) and to the Production `scenes` field.

**Shot numbering.** Implement `app/src/main/shotter.ts`:
```
nextNumber(prev: "0100") → "0200"        // default increment by 100
insertMid(a: "0100", b: "0200") → "0150" // future edit step
renumber(scenes)                          // reindex all shots after insert
validate(s) // 4-digit, strictly increasing, ≥ "0100"
```
Each shot stores its **own stable id** (uuid-ish from `crypto.randomUUID`) so reorder/insert
never depends on the displayed number. The number is derived, not stored as the identity.

**Output markdown shape (two-column A/V):**
```
## Scene 1 — Morning in the apartment

| Shot | Audio | Visual |
|------|-------|--------|
| 0100 | ADA: "Another morning."  | Wide interior; kitchen, dawn light |
| 0150 | (SFX) kettle boils       | Push-in on the kettle |
| 0200 | ADA: "I need the city." | She looks out the window |
```

### Step 2 — Character / Visual design
Goal: **consistency keys** + **character-sheet images** in one master visual style.

1. **Master style** (one field on the `Production`): “soft-3D / graphite pencil” etc. Chosen once,
   applied to every generation. Saves for reuse.
2. **Consistency keys**: for each character the LLM derives a canonical descriptor
   token (e.g. `ADA = "thirty-something woman, gray-green eyes, black bob, mustard cardigan"`).
   Stored in `characters[]`. This string is **prepended** to every later prompt referencing that
   character, giving cross-shot / plate consistency (the consistency-key pattern).
3. **Character sheets**: generate the full-body character sheet (front/side/3/4 turnaround) via
   image generation. **First choice is the OpenArt MCP server** (`openart_generate_image` via
   `McpManager.callRawFull`). If it isn't connected, prompts are exported and the user generates
   images externally, then imports them back. Parallel generation per-key; save PNGs to
   `<folder>/design/<key>.png`. Backend selection lives in the pipeline — the pipeline switches backend by provider config.

### Step 3 — Shot breakdown / storyboards (proposed fill)
Proposed, needs user sign-off (steps 3 & 4 were implicitly missing):
- For each `shot`, prompt the LLM to expand `visual` into a full storyboard caption (subject,
  composition, camera, lighting) + feeding the character consistency keys.
- Generate a storyboard frame per shot (**remote image generation**), saved to `<out>/boards/shot-<number>.png`.
- Show frames in a contact sheet in the Production UI; allow shot-selective reordering (which
  triggers `shotter.resize` mid-step numbering — exactly the "0150" use case).

### Step 4 — Animatic / timed pre-viz (proposed fill)
- Order shots into a timeline; the LLM assigns per-shot duration + transition.
- Assemble an **animatic draft**: sequence the storyboard frames + on-screen title cards, paced
  to the audio cues. Room for a shot audio list per line (the A/V columns feed = read-out pacing).
- Output a scan/contact-sheet review (or, with a TTS + MMCP audio backend, an `.mp4` animatic —
  see Step 5).

### Step 5 — Final assembly / generation
- **Audio**: attach dialogue/SFX via a TTS MCP server (e.g. an `ai-voice` MCP) called by name; or
  import user audio per-line.
- **Video**: if short, render via `ffmpeg` (slideshow of storyboard frames + audio + timing) →
  `<out>/render.mp4`. Implementation guard: require explicit user go-ahead before rendering
  (file writes already are the mainstream model's file tools — the pipeline can reuse the agent
  `bash` tool with a wrapped ffmpeg helper).
- **Package**: write a `MANIFEST.md` and a folder manifest (script.md, design/, storyboard/,
  out/) for handoff to a real editor.

---

## 4. Dependency & library choices (summary to confirm)

| Need | Choice | Why |
|---|---|---|
| PDF text extraction | `pdf-parse` | Pure JS, no native deps, agent-friendly |
| DOCX → markdown | `mammoth` | Clean HTML/md, optional — Google Doc txt path can skip it |
| DOC (legacy) | “open, Save As → .docx” | Zero deps in v1; add `libreoffice` later |
| Google Doc | export `?format=docx` / `?format=txt` | No Google SDK; works for Anyone-with-link docs |
| Images (step 2/3) | OpenArt MCP `openart_generate_image` | In-app generation; fallback = exported prompts + manual import |
| Audio (step 5) | MCP TTS server | Already wired in mcp.ts |

---

## 5. Where each change lands (file checklist)

| File | Change |
|---|---|
| `app/src/main/mcp.ts` | `callRawFull` — raw MCP results incl. binary images (board generation backend) |
| `app/src/main/productions.ts` | *new* — persistence + schema |
| `app/src/main/shotter.ts` | *new* — 4-digit shot numbering/insertion + validation |
| `app/src/main/scripting.ts` | *new* — PDF/DOC/DOCX/Google Doc → extracted text |
| `app/src/main/pipeline.ts` | *new* — orchestrated Steps 1–5 (guided, per-step) |
| `app/src/main/index.ts` | Register `production:*` IPC; create the store dir |
| `app/src/main/settings.ts` | Add `recentProductions` MRU list reading/writing |
| `app/src/shared/ipc.ts` | New `Production*` types + `CascadeApi` methods |
| `app/src/preload` (if needed) | Expose new bridge methods |
| `app/src/renderer/src/App.tsx` | Top-level `view` switch |
| `app/src/renderer/src/components/ViewTabs.tsx` | *new* — Home / Production tab bar |
| `app/src/renderer/src/components/ProductionWorkspace.tsx` | *new* — the production UI |
| `app/src/renderer/src/components/ProductionProject.tsx`, `StepEditor.tsx`, `ShotTable.tsx`, `CharacterGrid.tsx` | field/step panels |
| `app/src/renderer/src/styles.css` | Workspace layout, step cards, contact sheets |

**Fail-safe convention:** the pipeline never writes code to the codebase it doesn't own — it
writes *only* inside the chosen production folder (a dedicated per-project folder), always
resolution-check-confined to `<folder>/`. Uses the existing agent `WorkspaceError` guard.

---

## 6. Build order (each is a testable milestone)

1. **View switch** — tabs render; Production shows an empty "create/open" screen. *(renderer-only)*
2. **Project CRUD + MRU** — create/open/list/delete a production; persist to `userData/`.
3. **Step 1 ingestion** — `scripting.ts` + `shotter.ts` + Step editor; import a PDF/Google Doc
   into the A/V two-column `scenes`.
4. **Step 2 design** — style descriptor + consistency keys + character-sheet generation;
   proof of /v1/images/generations round-trip.
5. **Steps 3–4** (once defined) — storyboards + animatic.
6. **Step 5 assembly** — final timings + ffmpeg/audio path + MANIFEST.

Milestones 3 – 5 are each self-contained enough to hand to a codifier agent as a work order,
following the same "ends with something I can run and test" rule as `CASCADE-PLAN.md`.

---

## 7. Open questions to resolve before building

1. **Steps 3 & 4 fill** — the spec lists 1, 2, and 5 with 3/4 "implicit". My proposal:
   3 = shot/storyboard breakdown with generated frames, 4 = animatic/pre-video timeline.
   Confirm or replace.
2. **Image backend** — confirm Gab `/v1/images/generations` is the intended source (vs. an MCP
   image provider like OpenART, already present).
3. **Audio** — for Step 5 do we need a TTS MCP dependency, or is a silent animatic (contact sheets
   + FFmpeg stills-only) acceptable for v1.
4. **DOC (legacy 2003)** — OK to require Save-As DOCX, or must we bundle LibreOffice conversion.
5. **Numbering granularity** — is the 4-digit system per-scene (0100, 0200) with shots numbered
   within a scene, or a single global monotonic counter across all scenes? The plan assumes
   **global** (each shot gets its own 4-digit number; scenes grow by scene break). Confirm pre-build
   — it lives by conversion parse.

---

## 8. Risks & mitigations

- **Image generation cost/limits** — generation is expensive; cap by default (e.g. draft up to
  `maxFrames` per run, with a UI slider) and always render at preview resolution.
- **Scene/scene-separator parse wrong** — the LLM JSON step can hallucinate; run a validation
  pass from the `shotter` + provide a connect-to-editor surface allowing manual changes.
- **PDF/DOC fidelity** — tables/scans won't be clean; state clearly in the Step 1 import that
  a best-effort「text layer」is produced and the human can correct the shots first.
- **Credits drift** — the pipeline is *guided*, not a free-form loop; each run step executes a
  bounded set of LLM calls (one per scene-shot) — exposes a live per-step cost in the Step
  editor.

---

That's the full plan. Once you confirm the open items in §7, I'll proceed to draft the concrete
code for the files in §5 (starting with project CRUD + Step 1 ingestion, the highest-leverage
milestone).