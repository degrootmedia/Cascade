import { describe, it, expect } from "vitest";
import { externalEditorLabel } from "../src/shared/editor-label.js";

describe("externalEditorLabel", () => {
  it("falls back when unset or blank", () => {
    expect(externalEditorLabel(null)).toBe("Edit externally");
    expect(externalEditorLabel(undefined)).toBe("Edit externally");
    expect(externalEditorLabel("   ")).toBe("Edit externally");
  });

  it("names the app from a Windows path", () => {
    expect(externalEditorLabel("C:\\Program Files\\Affinity\\Affinity Photo 2.exe")).toBe("Edit in Affinity Photo 2");
  });

  it("names the app from a mac .app bundle path", () => {
    expect(externalEditorLabel("/Applications/Affinity Photo.app")).toBe("Edit in Affinity Photo");
  });

  it("keeps a no-extension executable name", () => {
    expect(externalEditorLabel("/usr/local/bin/gimp")).toBe("Edit in gimp");
  });
});
