import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { stepLightbox } from "../src/renderer/src/components/graph/lightbox-nav.js";

const items = [{ url: "u0", path: "p0" }, { url: "u1", path: "p1" }, { url: "u2", path: "p2" }];

describe("node lightbox history stepping", () => {
  it("steps right/left through generations and wraps", () => {
    let lb = { artwork: "u1", rel: "p1", nav: { items, index: 1 } };
    lb = stepLightbox(lb, 1);
    expect([lb.artwork, lb.rel]).toEqual(["u2", "p2"]);
    lb = stepLightbox(lb, 1);
    expect(lb.artwork).toBe("u0");
    lb = stepLightbox(lb, -1);
    expect(lb.artwork).toBe("u2");
  });
  it("is a no-op without history", () => {
    const lb = { artwork: "x" };
    expect(stepLightbox(lb, 1)).toBe(lb);
  });
  it("image and edit-image nodes pass their history and the modal wires onNavigate", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../src/renderer/src/components/NodeGraphModal.tsx"), "utf8");
    expect(src.match(/index: data\.selected \}\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src).toContain("onNavigate={lightbox.nav");
  });
});
