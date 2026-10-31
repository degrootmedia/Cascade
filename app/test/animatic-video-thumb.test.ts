import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "../src/renderer/src/components/production/animatic.tsx"), "utf8");

describe("animatic video thumbnails", () => {
  it("builds a still-frame media url", () => {
    const m = /export function videoStillSrc[\s\S]*?\n\}/.exec(src)![0];
    expect(m).toContain("#t=");
  });
  it("timeline blocks pass the shot's videoPath so a video frame is rendered", () => {
    expect(src).toContain("videoRel={s.videoPath || undefined}");
    expect(src).toMatch(/if \(videoRel\) return <video/);
  });
});
