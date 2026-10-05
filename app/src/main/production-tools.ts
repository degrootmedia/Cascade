/**
 * Production agent tools: the chat side's door into the Production Assistant.
 *
 * The chat agent (`core/`) only has file tools + MCP tools, so before this it
 * could write a script and generate images but nothing was registered as a
 * Cascade production — assets landed outside the production folder and the
 * app never saw them. These tools wrap the app's own production operations
 * (the same handlers the Production UI calls) so an agent can create a
 * production, ingest a script, bring it to life, and assemble it, with every
 * asset written into the production folder by the app itself.
 *
 * The tools are pure definitions over a small `ProductionToolHost` seam — the
 * host runs the named operations and answers a few read queries. That seam IS
 * the test surface (see `app/test/production-tools.test.ts`); index.ts wires
 * it to the live IPC handlers. No Electron here.
 */
import type { AgentTool } from "@core";
import { addRefTag } from "../shared/prompt-grammar.js";
import type {
  CharacterSheetGenOptions,
  CliModelSchema,
  ImageModelOptions,
  Production,
  ProductionMeta,
  VideoGenOptions,
  VideoModelOptions,
} from "../shared/ipc.js";

/** The production operations an agent may drive. Each maps to exactly one
 *  app operation (an IPC handler in index.ts, except `setStyle`). */
export type ProductionOp =
  | "create"
  | "import"
  | "ingest"
  | "setStyle"
  | "setShotPrompt"
  | "generateMagicPrompts"
  | "generateStyleFrame"
  | "generateCharacterSheet"
  | "generateBoards"
  | "regenerateBoards"
  | "generateVideo"
  | "recheckVideo"
  | "listModels"
  | "modelOptions"
  | "videoModelOptions"
  | "imageModelOptions"
  | "planAnimatic"
  | "assemble"
  | "render";

/** The timeline report `cascade_assemble` surfaces so a missing clip can never
 *  pass silently as a frozen still. Mirrors `AssemblyPlan`'s diagnostics. */
export interface AssemblyReport {
  totalSec: number;
  stills: string[];
  blanks: string[];
  suspiciousStills: string[];
}

/** The host seam: index.ts supplies these from the live app; tests fake them. */
export interface ProductionToolHost {
  /** Run one named operation with the given positional arguments. */
  run(op: ProductionOp, ...args: unknown[]): Promise<unknown>;
  list(): ProductionMeta[];
  load(id: string): Production | null;
  activeId(): string | null;
  /** Parent directory new productions are created under when none is given. */
  defaultParentFolder(): string;
  /** Timeline diagnostics for a production (from the pure `assemblyPlan`). */
  assemblyReport(id: string): AssemblyReport;
}

// ---- arg coercion ---------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function bool(v: unknown): boolean {
  return v === true;
}
function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(str).filter((s): s is string => !!s);
  return out.length ? out : undefined;
}
function strMap(v: unknown): Record<string, string | number | boolean | string[]> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, string | number | boolean | string[]>)
    : undefined;
}

/** Resolve the target production: explicit id, else the active one. */
function requireId(host: ProductionToolHost, args: Record<string, unknown>): string {
  const id = str(args.productionId) ?? host.activeId() ?? undefined;
  if (!id) {
    throw new Error(
      "No production selected. Create one first (cascade_create_production) or open one, then pass its id."
    );
  }
  return id;
}

/** A compact, model-readable digest of a production — enough to plan the next
 *  call without dumping the whole (potentially huge) document. */
export function productionDigest(p: Production): Record<string, unknown> {
  const style = p.styles?.[0];
  return {
    id: p.meta.id,
    name: p.meta.name,
    folder: p.meta.folder,
    currentStep: p.currentStep,
    status: p.status ?? {},
    style: style
      ? { id: style.id, name: style.name, hasFrame: !!(style.imagePath || style.frameSource) }
      : null,
    characters: (p.characters ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      hasSheet: !!(c.imagePath ?? c.artwork),
    })),
    references: (p.references ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      categoryId: r.categoryId ?? null,
    })),
    scenes: p.scenes.map((sc) => ({ number: sc.number, title: sc.title, shotCount: sc.shots.length })),
    shots: p.scenes.flatMap((sc) =>
      sc.shots.map((s) => ({
        id: s.id,
        number: s.number,
        scene: sc.number,
        audio: s.audio,
        visual: s.visual,
        durationSec: s.durationSec ?? null,
        hasFrame: !!s.artwork,
        hasVideo: !!s.videoPath,
        pendingVideo: !!s.pendingVideoGen,
      }))
    ),
    assembly: p.assembly
      ? { exportDir: p.assembly.exportDir, renderPath: p.assembly.renderPath ?? null }
      : null,
  };
}

function digestText(prefix: string, value: unknown): string {
  const p = value as Production;
  if (p && p.meta && Array.isArray(p.scenes)) {
    return `${prefix}\n${JSON.stringify(productionDigest(p), null, 2)}`;
  }
  return prefix;
}

// ---- tool definitions -----------------------------------------------------

/** Build the `cascade_*` agent tools over the host seam. */
export function makeProductionAgentTools(host: ProductionToolHost): Record<string, AgentTool> {
  const tools: Record<string, AgentTool> = {};

  tools.cascade_list_productions = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "cascade_list_productions",
        description:
          "List the user's Cascade productions (id, name, folder, active) OR, when `productionId` is given, return the full plan for that production: its style, characters, references, scenes, and every shot (with id, number, and whether it already has a frame/video). Call this first when asked to make a film, to see what already exists.",
        parameters: {
          type: "object",
          properties: {
            productionId: {
              type: "string",
              description: "When set, return detail for this production instead of the list.",
            },
          },
        },
      },
    },
    run: async (args) => {
      const id = str(args.productionId);
      if (id) {
        const p = host.load(id);
        if (!p) return `ERROR: production "${id}" not found.`;
        return JSON.stringify(productionDigest(p), null, 2);
      }
      const active = host.activeId();
      return JSON.stringify(
        {
          activeProductionId: active,
          productions: host.list().map((m) => ({ ...m, active: m.id === active })),
        },
        null,
        2
      );
    },
  };

  tools.cascade_list_models = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "cascade_list_models",
        description:
          "List the media models the configured provider actually offers, with their exact (namespaced) ids and whether each is an image or video model. Call this before generating when a specific model is wanted — model ids are provider-specific and a wrong id is rejected. Omit `kind` to list everything. Set `includeOptions: true` to also fetch each model's valid durations/resolutions/qualities (slower — the provider is queried per model); otherwise call cascade_model_options for the one model you pick.",
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["image", "video"],
              description: "Filter to image-generating or video-generating models.",
            },
            includeOptions: {
              type: "boolean",
              description: "Also fetch each model's valid durations/resolutions (slower).",
            },
          },
        },
      },
    },
    run: async (args) => {
      const raw = (await host.run("listModels")) as Array<Record<string, unknown>>;
      const kind = str(args.kind);
      const includeOptions = bool(args.includeOptions);
      const base = (Array.isArray(raw) ? raw : [])
        .map((m) => ({
          id: String(m.id ?? ""),
          name: String(m.displayName ?? m.name ?? m.id ?? ""),
          kind: (m.videoInput ? "video" : "image") as "video" | "image",
          cost: m.cost ?? null,
        }))
        .filter((m) => m.id && (!kind || m.kind === kind));
      if (!base.length) {
        return "No models returned — the media provider may not be connected. Check Settings → Media generation (Higgsfield CLI also needs the `higgsfield` binary installed and `higgsfield auth login`).";
      }
      if (!includeOptions) {
        return JSON.stringify({ count: base.length, models: base }, null, 2);
      }
      const models = await Promise.all(
        base.map(async (m) => {
          try {
            if (m.kind === "video") {
              const o = (await host.run("videoModelOptions", m.id)) as VideoModelOptions | null;
              return { ...m, durations: o?.durations ?? [], resolutions: o?.resolutions ?? [] };
            }
            const o = (await host.run("imageModelOptions", m.id)) as ImageModelOptions | null;
            return {
              ...m,
              resolutions: o?.resolutions ?? [],
              qualities: o?.qualities ?? [],
              aspectRatios: o?.aspectRatios ?? [],
            };
          } catch {
            return m;
          }
        })
      );
      return JSON.stringify({ count: models.length, models }, null, 2);
    },
  };

  tools.cascade_model_options = {
    requiresApproval: false,
    definition: {
      type: "function",
      function: {
        name: "cascade_model_options",
        description:
          "Read one media model's full option schema (dependency-free, read-only): the exact durations and aspect ratios it accepts, and every schema flag with its allowed values and default — including toggles such as audio. Call this after picking a model id. Important: video models REJECT a `durationSec` they don't list (it's not coerced), so read the durations here before calling cascade_generate_video; an unsupported resolution is silently ignored.",
        parameters: {
          type: "object",
          properties: {
            modelId: {
              type: "string",
              description: "The namespaced model id exactly as returned by cascade_list_models.",
            },
          },
          required: ["modelId"],
        },
      },
    },
    run: async (args) => {
      const modelId = str(args.modelId);
      if (!modelId) throw new Error("cascade_model_options: `modelId` is required.");
      const schema = (await host.run("modelOptions", modelId)) as CliModelSchema | null;
      if (!schema) {
        return `No option schema for "${modelId}" — it may be a model the active provider doesn't expose, or the provider isn't connected. Call cascade_list_models for valid ids.`;
      }
      const fields = (schema.fields ?? []).map((f) => ({
        name: f.name,
        group: f.group,
        kind: f.kind,
        ...(f.values?.length ? { values: f.values } : {}),
        ...(f.default !== undefined && f.default !== null ? { default: f.default } : {}),
        ...(f.required ? { required: f.required } : {}),
      }));
      return JSON.stringify(
        {
          modelId,
          jobType: schema.jobType,
          durations: schema.durations ?? [],
          aspectRatios: schema.aspectRatios ?? [],
          fields,
        },
        null,
        2
      );
    },
  };

  tools.cascade_create_production = {
    requiresApproval: true,
    definition: {
      type: "function",
      function: {
        name: "cascade_create_production",
        description:
          "Create a new Cascade production (a project folder with script.md, references/, boards/, out/, …) and register it in the Production Assistant. Every later asset this agent generates is written inside that folder. Returns the new production id — pass it to the other cascade_* tools.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Production name (also the folder name)." },
            folder: {
              type: "string",
              description:
                "Absolute parent directory to create the production under. A subfolder named after the production is created inside it. Defaults to the user's Documents folder.",
            },
          },
          required: ["name"],
        },
      },
    },
    describe: (args) => ({
      tool: "cascade_create_production",
      summary: `Create production “${str(args.name) ?? "?"}”`,
      detail: `Folder: ${str(args.folder) ?? host.defaultParentFolder()}`,
    }),
    run: async (args) => {
      const name = str(args.name);
      if (!name) throw new Error("cascade_create_production: `name` is required.");
      const p = (await host.run(
        "create",
        name,
        str(args.folder) ?? host.defaultParentFolder()
      )) as Production;
      return digestText("Created production.", p);
    },
  };

  tools.cascade_import_production = {
    requiresApproval: true,
    definition: {
      type: "function",
      function: {
        name: "cascade_import_production",
        description:
          "Adopt an existing folder as a Cascade production (e.g. one a previous session built). Missing asset folders are scaffolded; existing files are kept. Returns the production id.",
        parameters: {
          type: "object",
          properties: {
            folder: { type: "string", description: "Absolute path of the production folder to adopt." },
          },
          required: ["folder"],
        },
      },
    },
    describe: (args) => ({
      tool: "cascade_import_production",
      summary: `Adopt production folder ${str(args.folder) ?? "?"}`,
      detail: "Registers the folder in the Production Assistant without moving or deleting anything.",
    }),
    run: async (args) => {
      const folder = str(args.folder);
      if (!folder) throw new Error("cascade_import_production: `folder` is required.");
      const p = (await host.run("import", folder)) as Production;
      return digestText("Imported production.", p);
    },
  };

  tools.cascade_ingest_script = {
    requiresApproval: true,
    definition: {
      type: "function",
      function: {
        name: "cascade_ingest_script",
        description:
          "Step 1: ingest a script into a production. `source` is an absolute path to a .txt/.md/.fountain/.pdf/.docx file OR a Google Docs share URL. The app breaks it into scenes and shots (with 4-digit numbers) and writes script.md into the production folder. Write your screenplay to a file first (write_file), then ingest that path.",
        parameters: {
          type: "object",
          properties: {
            productionId: { type: "string", description: "Target production (defaults to the active one)." },
            source: { type: "string", description: "Script file path or Google Docs URL." },
          },
          required: ["source"],
        },
      },
    },
    describe: (args) => ({
      tool: "cascade_ingest_script",
      summary: "Ingest the script and break it into scenes/shots",
      detail: `Source: ${str(args.source) ?? "?"}`,
    }),
    run: async (args) => {
      const source = str(args.source);
      if (!source) throw new Error("cascade_ingest_script: `source` is required.");
      const p = (await host.run("ingest", requireId(host, args), source)) as Production;
      return digestText("Script ingested.", p);
    },
  };

  tools.cascade_set_style = {
    requiresApproval: true,
    definition: {
      type: "function",
      function: {
        name: "cascade_set_style",
        description:
          "Step 2: set the production's master visual style (the look shared by every generated frame). Provide a short name and the full style prompt. Creates the style when none exists, otherwise updates the master (styles[0]) or `styleId` when given. Call cascade_generate_style_frame next to anchor the look with a reference frame.",
        parameters: {
          type: "object",
          properties: {
            productionId: { type: "string", description: "Target production (defaults to the active one)." },
            name: { type: "string", description: "Short style label, e.g. “Soft 3D graphite”." },
            prompt: {
              type: "string",
              description:
                "The full style prompt describing medium, rendering, palette, and lighting — no story content.",
            },
            styleId: { type: "string", description: "Update this style instead of the master." },
          },
          required: ["name", "prompt"],
        },
      },
    },
    describe: (args) => ({
      tool: "cascade_set_style",
      summary: `Set master style “${str(args.name) ?? "?"}”`,
      detail: (str(args.prompt) ?? "").slice(0, 400),
    }),
    run: async (args) => {
      const name = str(args.name);
      const prompt = str(args.prompt);
      if (!name || !prompt) throw new Error("cascade_set_style: `name` and `prompt` are required.");
      const p = (await host.run("setStyle", requireId(host, args), {
        name,
        prompt,
        styleId: str(args.styleId),
      })) as Production;
      return digestText("Style set.", p);
    },
  };

  tools.cascade_generate_style_frame = {
    requiresApproval: true,
    definition: {
      type: "function",
      function: {
        name: "cascade_generate_style_frame",
        description:
          "Step 2: generate the style's look-anchor frame (a neutral subject rendered in the style). The frame is uploaded at reference index 0 on every shot that resolves to the style, which keeps the whole storyboard cohesive. Run this after cascade_set_style and before the storyboard. Returns the production with the style's hasFrame set.",
        parameters: {
          type: "object",
          properties: {
            productionId: { type: "string", description: "Target production (defaults to the active one)." },
            styleId: { type: "string", description: "Style to anchor (defaults to the master style)." },
            model: { type: "string", description: "Image model id, or omit for the house default." },
            resolution: { type: "string", description: "Resolution bucket, e.g. “1k”." },
            params: { type: "object", description: "Schema-driven model options (variant, seed, …)." },
          },
        },
      },
    },
    describe: () => ({
      tool: "cascade_generate_style_frame",
      summary: "Generate the style look-anchor frame",
      detail: "Renders a neutral-subject look plate and attaches it to the style.",
    }),
    run: async (args) => {
      const id = requireId(host, args);
      const styleId = str(args.styleId) ?? host.load(id)?.styles?.[0]?.id;
      if (!styleId) throw new Error("cascade_generate_style_frame: no style on this production — call cascade_set_style first.");
      const p = (await host.run(
        "generateStyleFrame",
        id,
        styleId,
        str(args.model),
        str(args.resolution),
        strMap(args.params)
      )) as Production;
      return digestText("Style frame generated.", p);
    },
  };

  tools.cascade_generate_character_sheet = {
    requiresApproval: true,
    definition: {
      type: "function",
      function: {
        name: "cascade_generate_character_sheet",
        description:
          "Step 2: generate a character sheet (full body + face closeup inset, neutral pose on gray) as a reference the agent can cite later. The sheet is saved in the production's references folder and mirrored into the Characters category. Cite other references by name in `description` with @[Name] tags.",
        parameters: {
          type: "object",
          properties: {
            productionId: { type: "string", description: "Target production (defaults to the active one)." },
            name: { type: "string", description: "Character name (becomes the citable reference name)." },
            description: { type: "string", description: "Concrete visual description of the character." },
            view: { type: "string", enum: ["front", "front-back"], description: "Front only, or front + back. Defaults to front." },
            model: { type: "string", description: "Image model id, or omit for the house default." },
            resolution: { type: "string", description: "Resolution bucket, e.g. “1k”." },
            params: { type: "object", description: "Schema-driven model options." },
          },
          required: ["name", "description"],
        },
      },
    },
    describe: (args) => ({
      tool: "cascade_generate_character_sheet",
      summary: `Generate character sheet “${str(args.name) ?? "?"}”`,
      detail: (str(args.description) ?? "").slice(0, 400),
    }),
    run: async (args) => {
      const name = str(args.name);
      const description = str(args.description);
      if (!name || !description) {
        throw new Error("cascade_generate_character_sheet: `name` and `description` are required.");
      }
      const view = args.view === "front-back" ? "front-back" : "front";
      const opts: CharacterSheetGenOptions = {
        model: str(args.model) ?? "auto",
        resolution: str(args.resolution) ?? "1k",
        name,
        description,
        view,
        ...(strMap(args.params) ? { params: strMap(args.params) } : {}),
      };
      const p = (await host.run("generateCharacterSheet", requireId(host, args), opts)) as Production;
      return digestText("Character sheet generated.", p);
    },
  };

  tools.cascade_generate_storyboard = {
    requiresApproval: true,
    definition: {
      type: "function",
      function: {
        name: "cascade_generate_storyboard",
        description:
          "Step 3: generate storyboard frames for a production's shots via the active media provider. Frames are saved into the production's boards folder. Without `shotIds`, generates frames for every shot still missing one (or all shots when `regenerateAll` is true). With `shotIds`, regenerates exactly those shots. Requires the script to be ingested first.",
        parameters: {
          type: "object",
          properties: {
            productionId: { type: "string", description: "Target production (defaults to the active one)." },
            shotIds: {
              type: "array",
              items: { type: "string" },
              description: "Specific shot ids to (re)generate. Omit to fill missing frames across the board.",
            },
            regenerateAll: { type: "boolean", description: "Regenerate every shot's frame, not just missing ones." },
            maxShots: { type: "number", description: "Cap how many shots this run generates (credit control)." },
          },
        },
      },
    },
    describe: (args) => {
      const ids = strArray(args.shotIds);
      return {
        tool: "cascade_generate_storyboard",
        summary: ids ? `Regenerate ${ids.length} storyboard frame(s)` : `Generate storyboard frames`,
        detail: ids ? ids.join(", ") : "Fills every missing frame (unless regenerateAll).",
      };
    },
    run: async (args) => {
      const id = requireId(host, args);
      const shotIds = strArray(args.shotIds);
      const p = (shotIds
        ? await host.run("regenerateBoards", id, shotIds)
        : await host.run("generateBoards", id, {
            maxShots: num(args.maxShots),
            regenerateAll: bool(args.regenerateAll),
          })) as Production;
      return digestText("Storyboard generation finished.", p);
    },
  };

  tools.cascade_generate_magic_prompts = {
    requiresApproval: true,
    definition: {
      type: "function",
      function: {
        name: "cascade_generate_magic_prompts",
        description:
          "Step 3: write a content-only storyboard prompt for every shot from the script (one bounded LLM pass). Crucially, this is how references get attached: the pass is told the available reference names and cites the ones that appear in each shot as @[Name] tags, which is what makes cascade_generate_storyboard upload the matching character sheets/prop images. Run this after the script is ingested and the design (style + character sheets) exists, and before the storyboard. It also switches the production into Magic Prompt mode.",
        parameters: {
          type: "object",
          properties: {
            productionId: { type: "string", description: "Target production (defaults to the active one)." },
          },
        },
      },
    },
    describe: () => ({
      tool: "cascade_generate_magic_prompts",
      summary: "Write storyboard prompts (cites references as @[Name])",
      detail: "One LLM pass over all shots; enables Magic Prompt mode.",
    }),
    run: async (args) => {
      const p = (await host.run("generateMagicPrompts", requireId(host, args))) as Production;
      return digestText("Magic Prompts generated (references cited for the storyboard).", p);
    },
  };

  tools.cascade_set_shot_prompt = {
    requiresApproval: true,
    definition: {
      type: "function",
      function: {
        name: "cascade_set_shot_prompt",
        description:
          "Step 3: set one shot's storyboard prompt explicitly (content only — the Style paragraph is added automatically). Use this to author or fix a frame's prompt, and to attach references by citing them: include @[Name] (e.g. \"Ada walks past the @[Gondola] at dawn\"). A reference image is only uploaded for a shot whose prompt cites it. Prefer cascade_generate_magic_prompts to do this for every shot at once.",
        parameters: {
          type: "object",
          properties: {
            productionId: { type: "string", description: "Target production (defaults to the active one)." },
            shotId: { type: "string", description: "The shot id (from cascade_list_productions)." },
            prompt: {
              type: "string",
              description: "The content prompt for this shot; cite references with @[Name] tags.",
            },
          },
          required: ["shotId", "prompt"],
        },
      },
    },
    describe: (args) => ({
      tool: "cascade_set_shot_prompt",
      summary: `Set the prompt for shot ${str(args.shotId) ?? "?"}`,
      detail: (str(args.prompt) ?? "").slice(0, 400),
    }),
    run: async (args) => {
      const id = requireId(host, args);
      const shotId = str(args.shotId);
      const prompt = str(args.prompt);
      if (!shotId || prompt === undefined) {
        throw new Error("cascade_set_shot_prompt: `shotId` and `prompt` are required.");
      }
      const p = (await host.run("setShotPrompt", id, shotId, prompt)) as Production;
      return digestText("Shot prompt set.", p);
    },
  };

  tools.cascade_generate_video = {
    requiresApproval: true,
    definition: {
      type: "function",
      function: {
        name: "cascade_generate_video",
        description:
          "Step 4: generate a video clip for one shot from its storyboard frame (the frame is the video's source and must exist). The clip is saved in the production folder and drives the shot's animatic window. `prompt` is the motion only — the production's Style is rendered in automatically. Cite reference images by name in `references` (e.g. [\"Ada\"]) so the clip keeps character/prop consistency; they are appended as @[Name] tags and uploaded.",
        parameters: {
          type: "object",
          properties: {
            productionId: { type: "string", description: "Target production (defaults to the active one)." },
            shotId: { type: "string", description: "The shot id (from cascade_list_productions)." },
            prompt: { type: "string", description: "Motion/camera prompt, e.g. “slow dolly in, steam rises”." },
            references: {
              type: "array",
              items: { type: "string" },
              description:
                "Reference names to attach (characters/props). Appended as @[Name] tags and uploaded with the frame.",
            },
            model: { type: "string", description: "Video model id, or omit for the house default." },
            resolution: { type: "string", description: "Output resolution label, e.g. “1080p”." },
            durationSec: { type: "number", description: "Clip length in seconds (default 5)." },
            params: { type: "object", description: "Schema-driven model options." },
          },
          required: ["shotId", "prompt"],
        },
      },
    },
    describe: (args) => ({
      tool: "cascade_generate_video",
      summary: `Generate a ${num(args.durationSec) ?? 5}s video for shot ${str(args.shotId) ?? "?"}`,
      detail: (str(args.prompt) ?? "").slice(0, 400),
    }),
    run: async (args) => {
      const id = requireId(host, args);
      const shotId = str(args.shotId);
      const prompt = str(args.prompt);
      if (!shotId || !prompt) throw new Error("cascade_generate_video: `shotId` and `prompt` are required.");
      const refs = strArray(args.references) ?? [];
      const withRefs = refs.reduce((text, name) => addRefTag(text, name), prompt);
      const opts: VideoGenOptions = {
        model: str(args.model) ?? "auto",
        resolution: str(args.resolution) ?? "1080p",
        durationSec: num(args.durationSec) ?? 5,
        prompt: withRefs,
        ...(strMap(args.params) ? { params: strMap(args.params) } : {}),
      };
      const p = (await host.run("generateVideo", id, shotId, opts)) as Production;
      const shot = p.scenes.flatMap((s) => s.shots).find((s) => s.id === shotId);
      const base = digestText("Video generated.", p);
      if (shot && !shot.videoPath) {
        return `${base}\n\nWARNING: shot ${shot.number} has no registered clip (the vendor job may still be rendering). Call cascade_recheck_video for it, or regenerate it, before assembling.`;
      }
      return base;
    },
  };

  tools.cascade_recheck_video = {
    requiresApproval: true,
    definition: {
      type: "function",
      function: {
        name: "cascade_recheck_video",
        description:
          "Step 4 repair: re-poll a shot's still-rendering video job and register the clip when it's ready (the async vendor job outlived the generating call). Use this when cascade_generate_video reported no registered clip, or when a shot shows pendingVideo: true in cascade_list_productions, before assembling.",
        parameters: {
          type: "object",
          properties: {
            productionId: { type: "string", description: "Target production (defaults to the active one)." },
            shotId: { type: "string", description: "The shot id (from cascade_list_productions)." },
          },
          required: ["shotId"],
        },
      },
    },
    describe: (args) => ({
      tool: "cascade_recheck_video",
      summary: `Reclaim the pending video for shot ${str(args.shotId) ?? "?"}`,
      detail: "Re-polls the vendor job and registers the clip when ready.",
    }),
    run: async (args) => {
      const shotId = str(args.shotId);
      if (!shotId) throw new Error("cascade_recheck_video: `shotId` is required.");
      const p = (await host.run("recheckVideo", requireId(host, args), shotId)) as Production;
      return digestText("Video recheck finished.", p);
    },
  };

  tools.cascade_plan_animatic = {
    requiresApproval: true,
    definition: {
      type: "function",
      function: {
        name: "cascade_plan_animatic",
        description:
          "Step 4: assign each shot a planned screen time (`durationSec`) from the script's timing cues and set transitions, so the production has a real target runtime. Frames/clips are then trimmed/fit to these durations at assembly. Run this before assembling if the user cares about the total length; the defaults are 3s per shot when unset.",
        parameters: {
          type: "object",
          properties: {
            productionId: { type: "string", description: "Target production (defaults to the active one)." },
          },
        },
      },
    },
    describe: () => ({
      tool: "cascade_plan_animatic",
      summary: "Plan per-shot durations (animatic timing)",
      detail: "One LLM pass assigning durationSec + transitions from the script.",
    }),
    run: async (args) => {
      const p = (await host.run("planAnimatic", requireId(host, args))) as Production;
      return digestText("Animatic timing planned.", p);
    },
  };

  tools.cascade_assemble = {
    requiresApproval: true,
    definition: {
      type: "function",
      function: {
        name: "cascade_assemble",
        description:
          "Step 5: build the export package (gathers frames, clips, and audio into out/assembly/, writes the EDL, After Effects script, and manifest). Set `render: true` to also encode out/assembly/render.mp4 via ffmpeg. Run after frames/clips exist.",
        parameters: {
          type: "object",
          properties: {
            productionId: { type: "string", description: "Target production (defaults to the active one)." },
            render: { type: "boolean", description: "Also render the animatic to MP4. Defaults to false." },
            fps: { type: "number", description: "Export frame rate (default 24)." },
            width: { type: "number", description: "Export width (default 1920)." },
            height: { type: "number", description: "Export height (default 1080)." },
          },
        },
      },
    },
    describe: (args) => ({
      tool: "cascade_assemble",
      summary: bool(args.render) ? "Build assembly package and render MP4" : "Build assembly package",
      detail: "Writes EDL / AE script / manifest into out/assembly/.",
    }),
    run: async (args) => {
      const id = requireId(host, args);
      const cfg: { fps?: number; width?: number; height?: number } = {};
      const fps = num(args.fps);
      const width = num(args.width);
      const height = num(args.height);
      if (fps) cfg.fps = fps;
      if (width) cfg.width = width;
      if (height) cfg.height = height;
      const built = (await host.run("assemble", id, cfg)) as Production;
      const report = host.assemblyReport(id);
      const lines = [digestText("Assembly package built.", built)];
      if (report.suspiciousStills.length) {
        lines.push(
          `WARNING: shot(s) ${report.suspiciousStills.join(", ")} have a video generation but no registered clip — they render as frozen stills. Reclaim each with cascade_recheck_video (or regenerate it), then assemble again. Do not deliver the render as-is.`
        );
      }
      if (report.blanks.length) {
        lines.push(`WARNING: blank slot(s) with no frame or clip: ${report.blanks.join(", ")}.`);
      }
      lines.push(`Runtime: ${report.totalSec.toFixed(1)}s.`);
      if (!bool(args.render)) return lines.join("\n");
      const rendered = (await host.run("render", id)) as Production;
      lines.push(digestText("Rendered to MP4.", rendered));
      return lines.join("\n");
    },
  };

  return tools;
}
