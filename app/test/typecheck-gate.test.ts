import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("typecheck gate", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));

  it("the normal test command runs type checking", () => {
    expect(pkg.scripts.test).toContain("typecheck");
  });

  it("the typecheck script runs the TypeScript compiler without emitting", () => {
    expect(pkg.scripts.typecheck).toContain("tsc");
    expect(pkg.scripts.typecheck).toContain("--noEmit");
  });
});
