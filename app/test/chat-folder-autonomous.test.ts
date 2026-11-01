/** Regression: default folder is only changed in Settings; autonomous toggle usable mid-response. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

describe("chat folder / autonomous regressions", () => {
  const main = read("src/main/index.ts");
  it("picking a chat folder never rewrites the default workspace", () => {
    const start = main.indexOf('handle("workspace:pickSession"');
    const end = main.indexOf('handle("workspace:setSessionProduction"');
    expect(start).toBeGreaterThan(-1);
    expect(main.slice(start, end)).not.toContain("settings.setWorkspace(");
  });
  it("autonomous toggle is not disabled while busy", () => {
    const app = read("src/renderer/src/App.tsx");
    const i = app.indexOf("plan-mode autonomous-mode");
    expect(app.slice(i, i + 700)).not.toContain("disabled={busy}");
  });
  it("toggling mid-run updates the live agent instead of dropping it", () => {
    expect(main).toContain("entry.agent.setAutonomousMode(");
  });
});
