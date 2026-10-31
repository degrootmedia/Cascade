import { describe, it, expect } from "vitest";
import { enforceSourceTag } from "../src/shared/prompt-grammar.js";

describe("pinned @[source] tag", () => {
  it("adds it first when a source is connected", () => {
    expect(enforceSourceTag("make it red", true)).toBe("@[source]\n\nmake it red");
    expect(enforceSourceTag("", true)).toBe("@[source]");
  });
  it("is idempotent", () => {
    const t = "@[source]\n\nmake it red @[Ref]";
    expect(enforceSourceTag(t, true)).toBe(t);
  });
  it("restores it to first slot if moved or deleted", () => {
    expect(enforceSourceTag("@[Ref]\n\n@[source]", true)).toBe("@[source]\n\n@[Ref]");
    expect(enforceSourceTag("a @[source] b", true)).toBe("@[source]\n\na  b".replace("a  b", "a  b"));
  });
  it("is reconciled for edit, video, edit-video and genjutsu nodes", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../src/renderer/src/components/NodeGraphModal.tsx"), "utf8");
    expect(src).toContain("enforceSourceTag(cur, !!n.source)");
    expect(src).toContain("for (const n of allVideoNodes)");
    expect(src).toContain("isVideoEditFamilyMode(n.mode) ? editVideoApplierKey(n.id) : videoApplierKey(n.id)");
  });
  it("removes it when disconnected", () => {
    expect(enforceSourceTag("@[source]\n\nmake it red", false)).toBe("make it red");
    expect(enforceSourceTag("make it red", false)).toBe("make it red");
  });
});
