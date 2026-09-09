import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("packaging hardening", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
  const builder = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../electron-builder.json"), "utf8")
  );

  it("package.json has no duplicate build key", () => {
    expect(pkg.build).toBeUndefined();
  });

  it("electron-builder.json is the single config with afterPack", () => {
    expect(builder.afterPack).toBe("build/afterPack.js");
    expect(fs.existsSync(path.resolve(__dirname, "../build/afterPack.js"))).toBe(true);
    expect(builder.asar).toBe(true);
  });

  it("mac hardened runtime + windows timestamp configured", () => {
    expect(builder.mac?.hardenedRuntime).toBe(true);
    expect(builder.win?.timeStampServer).toBeTruthy();
  });

  it("afterPack flips the hardening fuses", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../build/afterPack.js"), "utf8");
    expect(src).toContain("[FuseV1Options.RunAsNode]: false");
    expect(src).toContain("[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false");
    expect(src).toContain("[FuseV1Options.OnlyLoadAppFromAsar]: true");
    expect(src).toContain("[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true");
  });
});
