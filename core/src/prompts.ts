import type { SkillMeta } from "./types.js";

export function systemPrompt(
  workspaceRoot: string,
  skills?: SkillMeta[],
  instructions?: string,
  lazyToolsNote?: string,
  agentPrompt?: string
): string {
  const agentSection = agentPrompt?.trim()
    ? `${agentPrompt.trim()}\n\n---\n\n`
    : "";
  const skillsSection = skills?.length
    ? `\n\nSkills available (call read_skill with the skill name to get its full instructions when relevant):\n` +
      skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
    : "";
  const instructionsSection = instructions?.trim()
    ? `\n\nFolder instructions — the user set these for this folder, always follow them:\n${instructions.trim()}`
    : "";
  const lazySection = lazyToolsNote?.trim() ? lazyToolsNote : "";
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
- The operating system is ${process.platform === "win32" ? "Windows (shell commands run in cmd.exe)" : process.platform}.${skillsSection}${instructionsSection}${lazySection}`;
}
