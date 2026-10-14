import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { MEDIA_MENU_LABELS, MEDIA_MENU_ORDER } from "../src/shared/menu-labels.js";

describe("canonical media menu", () => {
  it("keeps the canonical action order", () => {
    expect([...MEDIA_MENU_ORDER]).toEqual([
      "save", "copy", "editExternal", "openFolder",
      "saveAsReference", "editInSuite", "refresh", "delete",
    ]);
  });

  it("dialog-opening actions carry an ellipsis, immediate ones do not", () => {
    expect(MEDIA_MENU_LABELS.saveImageAs.endsWith("…")).toBe(true);
    expect(MEDIA_MENU_LABELS.deleteGeneration.endsWith("…")).toBe(true);
    expect(MEDIA_MENU_LABELS.copyImage.endsWith("…")).toBe(false);
    expect(MEDIA_MENU_LABELS.editInSuite.endsWith("…")).toBe(false);
  });

  it("renderer menus use the shared labels and never hardcode the editor fallback", () => {
    for (const rel of ["src/renderer/src/components/generation-menu.tsx", "src/renderer/src/components/production/boards.tsx"]) {
      const src = fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
      expect(src, rel).toContain("MEDIA_MENU_LABELS");
      expect(src, rel).toContain("editorLabel");
      expect(src, rel).not.toMatch(/>\s*Edit externally\s*</);
    }
  });
});
