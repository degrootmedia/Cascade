import { describe, it, expect } from "vitest";
import { contentText, attachmentParts, type ChatMessage, type ContentPart } from "../src/types.js";
import { historySize, planCompaction } from "../src/compact.js";
import { systemPrompt } from "../src/prompts.js";
import { loadWorkspaceInstructions } from "../src/workspace.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const imageMsg: ChatMessage = {
  role: "user",
  content: [
    { type: "text", text: "what is this?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ] as ContentPart[],
};

describe("multimodal content", () => {
  it("contentText extracts text and marks images", () => {
    expect(contentText(imageMsg.content)).toBe("what is this? [image]");
    expect(contentText("plain")).toBe("plain");
    expect(contentText(null)).toBe("");
  });

  it("historySize counts array content", () => {
    expect(historySize([imageMsg])).toBeGreaterThan(50);
  });

  it("compaction handles image messages without crashing", () => {
    const msgs: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 20; i++) msgs.push({ ...imageMsg });
    const plan = planCompaction(msgs, 100);
    expect(plan).not.toBeNull();
  });
});

describe("attachmentParts", () => {
  it("returns plain text when there are no attachments", () => {
    expect(attachmentParts("hello")).toBe("hello");
    expect(attachmentParts("hello", [])).toBe("hello");
  });

  it("sends images as image_url media parts", () => {
    const content = attachmentParts("look", [
      { dataUrl: "data:image/png;base64,AAAA", name: "a.png", mime: "image/png" },
    ]);
    expect(content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  it("inlines plain-text files as a labeled text part", () => {
    const body = Buffer.from("To whom it may concern").toString("base64");
    const content = attachmentParts("read this", [
      { dataUrl: `data:text/plain;base64,${body}`, name: "letter.txt", mime: "text/plain" },
    ]);
    expect(content).toEqual([
      { type: "text", text: "read this" },
      { type: "text", text: "\n[Attached file: letter.txt]\nTo whom it may concern" },
    ]);
  });

  it("passes PDFs and office docs through as media parts", () => {
    const content = attachmentParts("review", [
      { dataUrl: "data:application/pdf;base64,JVBERi0=", name: "paper.pdf", mime: "application/pdf" },
      { dataUrl: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEs=", name: "draft.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    ]);
    expect(content).toHaveLength(3);
    const parts = content as ContentPart[];
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "data:application/pdf;base64,JVBERi0=" } });
    expect(parts[2]).toEqual({ type: "image_url", image_url: { url: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEs=" } });
  });
});

describe("skills in system prompt", () => {
  it("lists skills with descriptions", () => {
    const p = systemPrompt("/ws", [{ name: "weekly-report", description: "Formats weekly reports" }]);
    expect(p).toContain("weekly-report: Formats weekly reports");
    expect(p).toContain("read_skill");
  });

  it("omits section when no skills", () => {
    expect(systemPrompt("/ws")).not.toContain("read_skill");
    expect(systemPrompt("/ws", [])).not.toContain("read_skill");
  });
});

describe("per-directory instructions (CASCADE.md)", () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "cascade-instr-"));
  }

  it("loads CASCADE.md at the workspace root", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "CASCADE.md"), "Always use spaces, never tabs.\n\nPrefer TypeScript.\n");
    const text = loadWorkspaceInstructions(dir);
    expect(text).toContain("Always use spaces");
    expect(text.endsWith("\n")).toBe(false); // trailing whitespace stripped
  });

  it("prefers CASCADE.md but falls back to .cascade/instructions.md", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, ".cascade"));
    fs.writeFileSync(path.join(dir, ".cascade", "instructions.md"), "from dotfolder");
    fs.writeFileSync(path.join(dir, "CASCADE.md"), "from root");
    expect(loadWorkspaceInstructions(dir)).toBe("from root");
    fs.rmSync(path.join(dir, "CASCADE.md"));
    expect(loadWorkspaceInstructions(dir)).toBe("from dotfolder");
  });

  it("returns empty string when no instructions file exists", () => {
    const dir = tmpDir();
    expect(loadWorkspaceInstructions(dir)).toBe("");
  });

  it("injects instructions into the system prompt", () => {
    const p = systemPrompt("/ws", [], "Always use TypeScript.\nNever use any()).trim()");
    expect(p).toContain("Folder instructions");
    expect(p).toContain("Always use TypeScript.");
  });

  it("omits the instructions section when there are none", () => {
    expect(systemPrompt("/ws")).not.toContain("Folder instructions");
  });
});
