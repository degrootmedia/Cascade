import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "../src/renderer/src/components/production/animatic.tsx"), "utf8");

describe("timeline preview stills and pooled videos", () => {
  it("renders a held still directly from its media rel", () => {
    expect(src).toMatch(/if \(explicitRel\) return <img className="prod-timeline-thumb"/);
    expect(src).toContain("cascade-media://${prodId}/${encodeURIComponent(explicitRel)}");
  });
  it("plays video clips through the mounted pool, not still-frame thumbs", () => {
    expect(src).toContain("prod-animatic-video");
    expect(src).not.toContain("videoStillSrc");
    expect(src).not.toContain("videoRel");
  });
});
