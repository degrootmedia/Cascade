import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { planGate, PLAN_SPECS_DIR } from "../src/planmode.js";
import { PLAN_GATED_TOOLS } from "../src/types.js";

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-planmode-"));

describe("planGate", () => {
  it("gates every known mutating tool", () => {
    for (const t of PLAN_GATED_TOOLS) {
      const g = planGate(t, {}, WS);
      expect(g.allowed).toBe(false);
      if (!g.allowed) expect(g.message).toMatch(/Plan mode is on/);
    }
  });

  it("allows read-only and search tools through", () => {
    for (const t of ["read_file", "list_directory", "glob", "grep", "openart__generate_image"]) {
      expect(planGate(t, {}, WS).allowed).toBe(true);
    }
  });

  it("allows write/edit of plan artifacts under .cascade/specs/", () => {
    expect(planGate("write_file", { path: `${PLAN_SPECS_DIR}/auth/spec.md` }, WS).allowed).toBe(true);
    expect(planGate("write_file", { path: `${PLAN_SPECS_DIR}/auth/plan.json` }, WS).allowed).toBe(true);
    expect(planGate("edit_file", { path: `${PLAN_SPECS_DIR}/auth/spec.md` }, WS).allowed).toBe(true);
    // absolute paths inside the workspace also work
    expect(planGate("write_file", { path: path.join(WS, PLAN_SPECS_DIR, "x/spec.md") }, WS).allowed).toBe(true);
  });

  it("blocks writes outside the plan specs dir (source code)", () => {
    expect(planGate("write_file", { path: "src/main.ts" }, WS).allowed).toBe(false);
    expect(planGate("write_file", { path: "package.json" }, WS).allowed).toBe(false);
    expect(planGate("edit_file", { path: ".cascade/other.md" }, WS).allowed).toBe(false);
  });

  it("blocks run_command always", () => {
    expect(planGate("run_command", { command: "npm test" }, WS).allowed).toBe(false);
  });

  it("blocks when no workspace is bound", () => {
    expect(planGate("write_file", { path: "x" }).allowed).toBe(false);
  });
});