import { describe, it, expect } from "vitest";
import { isSeedance25Model, isDraftOnlyModel, providerSupportsDraftUpgrade } from "../src/shared/ipc.js";

describe("isSeedance25Model", () => {
  it("matches Seedance 2.5 under any namespace, but not its siblings", () => {
    expect(isSeedance25Model("higgsfield-cli:seedance_2_5")).toBe(true);
    expect(isSeedance25Model("seedance-2.5")).toBe(true);
    expect(isSeedance25Model("openart:seedance_2.5")).toBe(true);
    expect(isSeedance25Model("seedance_2_0")).toBe(false);
    expect(isSeedance25Model("seedance_2_5_draft")).toBe(false);
    expect(isSeedance25Model("auto")).toBe(false);
    expect(isSeedance25Model("")).toBe(false);
  });
});

describe("isDraftOnlyModel", () => {
  it("detects a separate draft model from its id or display name", () => {
    expect(isDraftOnlyModel({ id: "seedance_2_5_draft", displayName: "Seedance 2.5 Draft" })).toBe(true);
    expect(isDraftOnlyModel({ id: "openart:x", displayName: "Seedance 2.5 Draft" })).toBe(true);
    expect(isDraftOnlyModel({ id: "higgsfield-cli:seedance_2_5", displayName: "Seedance 2.5" })).toBe(false);
  });
});

describe("providerSupportsDraftUpgrade", () => {
  it("is Higgsfield CLI only", () => {
    expect(providerSupportsDraftUpgrade("higgsfield-cli")).toBe(true);
    expect(providerSupportsDraftUpgrade("openart")).toBe(false);
    expect(providerSupportsDraftUpgrade("openart-cli")).toBe(false);
  });
});
