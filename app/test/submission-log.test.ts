/**
 * submission-log tests — Dev Mode human-readable log + dry-run guard.
 * Credit-free: writes to a tmp dir, no network.
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

import {
  DryRunError,
  logSubmission,
  redactParams,
  renderSubmissionMarkdown,
} from "../src/main/submission-log.js";
import { prepareSubmission } from "../src/main/providers/submit-wrapper.js";

describe("submission-log", () => {
  it("renders a deterministic human-readable block", () => {
    const md = renderSubmissionMarkdown({
      ts: "2026-01-01T00:00:00.000Z",
      providerId: "higgsfield-cli",
      transport: "cli",
      kind: "video",
      modelId: "seedance_2_5",
      prompt: "a gondola at dusk",
      resolution: "720p",
      durationSec: 5,
      startFrame: "start",
      endFrame: "end",
      refs: [{ name: "Hero", role: "character", media: "image", source: "disk:boards/0100/x.jpg", bytes: 10 }],
      params: { model: "seedance_2_5", api_key: "secret" },
    });
    expect(md).toContain("higgsfield-cli / seedance_2_5 (video)");
    expect(md).toContain("a gondola at dusk");
    expect(md).toContain("[redacted]");
    expect(md).not.toContain("secret");
  });

  it("redacts secret-looking params", () => {
    expect(redactParams({ apiKey: "x", model: "m" })).toEqual({ apiKey: "[redacted]", model: "m" });
  });

  it("appends .md + .jsonl only in dev mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-sublog-"));
    const record = {
      ts: "2026-01-01T00:00:00.000Z",
      providerId: "openart",
      transport: "mcp",
      kind: "image" as const,
      modelId: "m",
      prompt: "p",
      refs: [],
      params: {},
    };
    logSubmission({ logsDir: () => dir, devMode: () => false }, record);
    expect(fs.existsSync(path.join(dir, "submissions.md"))).toBe(false);
    logSubmission({ logsDir: () => dir, devMode: () => true }, record);
    expect(fs.readFileSync(path.join(dir, "submissions.md"), "utf8")).toContain("openart / m (image)");
    expect(fs.readFileSync(path.join(dir, "submissions.jsonl"), "utf8")).toContain('"modelId":"m"');
  });

  it("dry-run builds the real request then throws before spend", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-sublog-"));
    await expect(
      prepareSubmission(
        { logsDir: () => dir, devMode: () => true, dryRun: () => true },
        {
          providerId: "higgsfield-cli",
          transport: "cli",
          kind: "video",
          modelId: "seedance_2_5",
          prompt: "do a thing @image1",
          durationSec: 5,
          refs: [{ name: "Hero", dataUrl: "data:image/png;base64,AAAA" }],
          params: { model: "seedance_2_5" },
        }
      )
    ).rejects.toBeInstanceOf(DryRunError);
    // The full request was still logged.
    expect(fs.readFileSync(path.join(dir, "submissions.md"), "utf8")).toContain("seedance_2_5");
  });
});
