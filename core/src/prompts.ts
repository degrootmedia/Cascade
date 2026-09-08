import type { SkillMeta } from "./types.js";

/** Minimal prompt for pure-chat mode (no tools, no workspace). */
export function pureChatSystemPrompt(): string {
  return `You are Cascade, a helpful AI assistant. Answer the user's questions directly and conversationally. You do not have access to the user's files, folders, or computer — this is a plain chat, so just respond to what the user asks.
The operating system is ${process.platform === "win32" ? "Windows" : process.platform}.`;
}

const SKILL_KIND_ORDER: Array<NonNullable<SkillMeta["kind"]>> = ["sequential", "advisory", "utility"];

const SKILL_KIND_LABEL: Record<NonNullable<SkillMeta["kind"]>, string> = {
  sequential: "Sequential — follow closely and produce its artifact",
  advisory: "Advisory — adapt to context, don't follow rigidly",
  utility: "Utility — reach for on demand",
};

/** Human label for a skill's name in the prompt: `ns:name` when namespaced. */
function skillLabel(s: SkillMeta): string {
  return s.namespace ? `${s.namespace}:${s.name}` : s.name;
}

/**
 * Build the skills section of the system prompt, grouped by kind
 * (sequential / advisory / utility) so the model knows how to treat each
 * namespace. Each entry is a `- label: description` line; the full content
 * is fetched via read_skill on demand.
 */
export function skillsPrompt(skills?: SkillMeta[]): string {
  if (!skills?.length) return "";
  const grouped = new Map<NonNullable<SkillMeta["kind"]>, SkillMeta[]>();
  for (const s of skills) {
    const kind = s.kind ?? "utility";
    const list = grouped.get(kind) ?? [];
    list.push(s);
    grouped.set(kind, list);
  }
  const sections = SKILL_KIND_ORDER.flatMap((kind) => {
    const list = grouped.get(kind);
    if (!list?.length) return [];
    const triggers = (s: SkillMeta) =>
      s.triggers?.length ? ` — e.g. when the user asks to: ${s.triggers.join("; ")}` : "";
    const lines = list.map((s) => `- ${skillLabel(s)}: ${s.description}${triggers(s)}`).join("\n");
    return [
      `### ${SKILL_KIND_LABEL[kind]}`,
      lines,
    ];
  });
  if (!sections.length) return "";
  return (
    `\n\nSkills — call read_skill with a skill's exact name to get its full instructions when relevant:\n` +
    sections.join("\n\n")
  );
}

/** The plan-mode directive appended to the system prompt when enabled. */
export function planModePrompt(): string {
  return (
    `\n\nPLAN MODE is ON. Do NOT write or edit source files, and do NOT run commands, until the user has reviewed and approved your written plan. ` +
    `First research the workspace and the request, then write your plan into a file under .cascade/specs/ and present it. ` +
    `You may keep updating that plan file as the user annotates it. ` +
    `Wait for explicit approval before mutating anything else.`
  );
}

export function systemPrompt(
  workspaceRoot: string,
  skills?: SkillMeta[],
  instructions?: string,
  lazyToolsNote?: string,
  agentPrompt?: string,
  planMode?: boolean
): string {
  const agentSection = agentPrompt?.trim()
    ? `${agentPrompt.trim()}\n\n---\n\n`
    : "";
  const skillsSection = skillsPrompt(skills);
  const instructionsSection = instructions?.trim()
    ? `\n\nFolder instructions — the user set these for this folder, always follow them:\n${instructions.trim()}`
    : "";
  const lazySection = lazyToolsNote?.trim() ? lazyToolsNote : "";
  const planSection = planMode ? planModePrompt() : "";
  return `${agentSection}You are Cascade, a desktop AI assistant that helps the user work with files on their computer.

You have tools to read, write, edit, and search files, and to run shell commands. All paths are relative to the user's workspace folder: ${workspaceRoot}

Guidelines:
- Use tools to complete tasks; don't just describe what you would do.
- Read a file before editing it.
- Prefer edit_file for small changes; write_file for new files or full rewrites.
- Keep responses concise. After completing a task, summarize what you did in a sentence or two.
- If a task is ambiguous, ask a clarifying question before acting.
- Mutating actions require user approval; if the user denies an action, respect that and ask how they'd like to proceed.
- When a tool result contains an image URL, show it to the user with a markdown image: ![description](url). When it reports a saved file path, state that exact path — never invent placeholders like "[image shown]".
- The operating system is ${process.platform === "win32" ? "Windows (shell commands run in cmd.exe)" : process.platform}.${skillsSection}${planSection}${instructionsSection}${lazySection}`;
}
