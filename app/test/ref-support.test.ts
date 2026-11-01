import { describe, it, expect } from "vitest";
import { unusableRefsMessage } from "../src/shared/ipc/media.js";

describe("unusableRefsMessage", () => {
  it("warns about video/audio refs on the OpenArt CLI", () => {
    const m = unusableRefsMessage("openart-cli", [{ name: "Clip", media: "video" }, { name: "Img" }, { name: "Song", media: "audio" }]);
    expect(m).toContain("OpenArt CLI");
    expect(m).toContain('"Clip" (video)');
    expect(m).toContain('"Song" (audio)');
    expect(m).not.toContain("Img");
  });
  it("is null when all refs are usable", () => {
    expect(unusableRefsMessage("openart", [{ name: "Clip", media: "video" }])).toBeNull();
    expect(unusableRefsMessage("openart-cli", [{ name: "Img" }])).toBeNull();
  });
});
