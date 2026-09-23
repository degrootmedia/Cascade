/**
 * The Settings registry: the single source of truth for the rail, for search,
 * and for the `SettingsView` key coverage test. Every section is presentation
 * only — persistence still flows through `main/settings.ts`'s existing IPC
 * methods, and no stored key is renamed, dropped, or re-nested here.
 */
import type { SettingsCategory, SettingsSection } from "./types.js";
import { AppearanceSection, resetAppearance } from "./sections/AppearanceSection.js";
import { WorkspaceSection, resetWorkspace } from "./sections/WorkspaceSection.js";
import { MediaStorageSection } from "./sections/MediaStorageSection.js";
import { ProvidersSection, resetProviders } from "./sections/ProvidersSection.js";
import { ModelsSection } from "./sections/ModelsSection.js";
import { ModelExposureSection } from "./sections/ModelExposureSection.js";
import { CliToolsSection } from "./sections/CliToolsSection.js";
import { ExternalEditorSection, resetExternalEditor } from "./sections/ExternalEditorSection.js";
import { ThreeDSection, resetThreeD } from "./sections/ThreeDSection.js";
import { McpServersSection } from "./sections/McpServersSection.js";
import { PromptsSection } from "./sections/PromptsSection.js";
import { DataSection } from "./sections/DataSection.js";
import { DeveloperSection } from "./sections/DeveloperSection.js";
import { DiagnosticsSection } from "./sections/DiagnosticsSection.js";

export function buildSettingsRegistry(): SettingsCategory[] {
  return [
    {
      id: "general",
      title: "General",
      sections: [
        {
          id: "appearance",
          title: "Appearance",
          category: "general",
          description: "Theme, color, and look.",
          keywords: ["accent", "color", "colour", "theme", "highlight", "appearance"],
          owns: ["accent"],
          render: () => <AppearanceSection />,
          onReset: resetAppearance,
        },
        {
          id: "workspace",
          title: "Workspace",
          category: "general",
          description: "Default folders, agents, and skills.",
          keywords: ["workspace", "folder", "directory", "chat", "agents", "personas", "skills", "default", "path"],
          owns: ["workspace"],
          render: () => <WorkspaceSection />,
          onReset: resetWorkspace,
        },
        {
          id: "media-storage",
          title: "Media & Storage",
          category: "general",
          description: "Generation vendor and on-disk cache.",
          keywords: ["media", "provider", "vendor", "transport", "mcp", "cli", "thumbnails", "cache", "storage", "openart", "higgsfield", "generation"],
          owns: [],
          render: () => <MediaStorageSection />,
        },
      ],
    },
    {
      id: "models",
      title: "Models & Providers",
      sections: [
        {
          id: "providers",
          title: "Providers",
          category: "models",
          description: "LLM vendor, API keys, and connection tests.",
          keywords: ["provider", "api key", "apikey", "key", "secret", "token", "endpoint", "connection", "llm", "gab", "openai", "cheaper inference", "test"],
          owns: ["provider", "hasApiKey"],
          render: () => <ProvidersSection />,
          onReset: resetProviders,
        },
        {
          id: "models",
          title: "Models",
          category: "models",
          description: "Default chat and pipeline model.",
          keywords: ["model", "models", "default", "chat", "pipeline", "cost", "cheapest"],
          owns: ["model"],
          render: () => <ModelsSection />,
        },
        {
          id: "model-exposure",
          title: "Model Exposure",
          category: "models",
          description: "Which models and parameters show in generators.",
          keywords: ["model", "exposure", "hidden", "hide", "parameters", "advanced", "surfaces", "customizer", "dropdown"],
          owns: [],
          render: () => <ModelExposureSection />,
        },
      ],
    },
    {
      id: "tools",
      title: "Tools & Integrations",
      sections: [
        {
          id: "cli-tools",
          title: "CLI Tools",
          category: "tools",
          description: "Local CLI binary paths and status.",
          keywords: ["cli", "binary", "path", "higgsfield", "openart", "command", "terminal", "tools", "login"],
          owns: [],
          render: () => <CliToolsSection />,
        },
        {
          id: "external-editor",
          title: "External Editor",
          category: "tools",
          description: "App opened by “Edit externally”.",
          keywords: ["external", "editor", "photoshop", "affinity", "edit", "image", "app", "exe"],
          owns: ["externalEditor"],
          render: () => <ExternalEditorSection />,
          onReset: resetExternalEditor,
        },
        {
          id: "three-d",
          title: "3D",
          category: "tools",
          description: "3D AI Studio key for Hunyuan Pro.",
          keywords: ["3d", "3d ai studio", "hunyuan", "model", "glb", "tencent", "api key"],
          owns: ["has3daiApiKey"],
          render: () => <ThreeDSection />,
          onReset: resetThreeD,
        },
        {
          id: "mcp",
          title: "MCP Servers",
          category: "tools",
          description: "Connect Model Context Protocol tool servers.",
          keywords: ["mcp", "server", "servers", "tools", "model context protocol", "connect", "on demand"],
          owns: [],
          render: () => <McpServersSection />,
        },
      ],
    },
    {
      id: "advanced",
      title: "Advanced",
      sections: [
        {
          id: "prompts",
          title: "Prompts",
          category: "advanced",
          description: "Editable creative prompt templates.",
          keywords: ["prompt", "prompts", "template", "templates", "wording", "camera grid", "video", "edit", "character sheet", "style frame", "look"],
          owns: [],
          render: () => <PromptsSection />,
        },
        {
          id: "data",
          title: "Data & Folders",
          category: "advanced",
          description: "On-disk folders and files.",
          keywords: ["data", "folder", "file", "logs", "skills", "user data", "submission", "open"],
          owns: [],
          render: () => <DataSection />,
        },
        {
          id: "developer",
          title: "Developer",
          category: "advanced",
          description: "Dev Mode, dry runs, and model customization.",
          keywords: ["developer", "dev mode", "dry run", "logging", "submission", "customizer", "debug"],
          owns: [],
          render: () => <DeveloperSection />,
        },
        {
          id: "diagnostics",
          title: "Diagnostics",
          category: "advanced",
          description: "Versions and environment info.",
          keywords: ["diagnostics", "version", "about", "environment", "electron", "chrome", "copy", "support", "report"],
          owns: [],
          render: () => <DiagnosticsSection />,
        },
      ],
    },
  ];
}

/** Flatten all sections in rail order. */
export function allSections(registry: SettingsCategory[]): SettingsSection[] {
  return registry.flatMap((c) => c.sections);
}

/** The section with `id`, if any. */
export function findSection(registry: SettingsCategory[], id: string): SettingsSection | undefined {
  return allSections(registry).find((s) => s.id === id);
}

/** The id of the first section in the rail (used as the default pane). */
export function firstSectionId(registry: SettingsCategory[]): string {
  return allSections(registry)[0]?.id ?? "";
}
