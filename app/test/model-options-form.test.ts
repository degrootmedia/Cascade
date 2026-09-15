/**
 * <ModelOptionsForm> — renders a CliModelSchema as grouped controls and
 * reports schema-shaped params. Pure renderer; no Electron.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ModelOptionsForm, pruneModelOptionValues } from "../src/renderer/src/components/ModelOptionsForm.js";
import type { CliModelSchema } from "../src/shared/ipc.js";

const schema: CliModelSchema = {
  jobType: "gpt_image_2_5",
  cliVersion: null,
  fetchedAt: 0,
  aspectRatios: ["auto", "16:9"],
  durations: [],
  roles: ["imagereferences"],
  raw: null,
  fields: [
    { name: "quality", flag: "quality", aliases: [], kind: "enum", group: "core", values: ["low", "high"], default: "low", emit: "value", source: "parameters" },
    { name: "resolution", flag: "resolution", aliases: [], kind: "enum", group: "core", values: ["1k", "2k"], default: "1k", emit: "value", source: "parameters" },
    { name: "variant", flag: "variant", aliases: [], kind: "enum", group: "core", values: ["flare", "sunburst"], default: "flare", emit: "value", source: "parameters" },
    { name: "background", flag: "background", aliases: [], kind: "enum", group: "control", values: ["auto", "transparent"], default: "auto", emit: "value", source: "parameters" },
    { name: "seed", flag: "seed", aliases: [], kind: "integer", group: "advanced", min: 0, max: 1000000, emit: "value", source: "parameters" },
    { name: "imagereferences", flag: "image_references", aliases: [], kind: "array", group: "reference", mediaRole: "image_references", emit: "repeat", source: "parameters" },
  ],
};

function mount(node: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, root };
}

describe("ModelOptionsForm", () => {
  it("renders nothing for a null schema", () => {
    const { container } = mount(createElement(ModelOptionsForm, { schema: null, value: {}, onChange: () => {} }));
    expect(container.innerHTML).toBe("");
  });

  it("renders exposed controls and hides advanced ones behind a persisted shelf", () => {
    const changes: Record<string, unknown>[] = [];
    const { container } = mount(
      createElement(ModelOptionsForm, { schema, value: {}, onChange: (n) => changes.push(n), exclude: ["resolution"], persistKey: "test.modelOptions.advanced" })
    );
    const labels = () => Array.from(container.querySelectorAll("label")).map((l) => l.textContent ?? "");
    // Exposed: quality + variant (resolution excluded; reference skipped).
    expect(container.querySelectorAll("select").length).toBe(2);
    expect(labels().some((t) => t.includes("Variant"))).toBe(true);
    expect(labels().some((t) => t.includes("Resolution"))).toBe(false);
    expect(labels().some((t) => t.includes("Image references"))).toBe(false);
    // Advanced starts collapsed; background/seed live there.
    const toggle = container.querySelector(".prod-model-options-advanced-head") as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(labels().some((t) => t.includes("Background"))).toBe(false);
    act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(labels().some((t) => t.includes("Background"))).toBe(true);
    // Switch variant to sunburst.
    const variantSelect = Array.from(container.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === "sunburst")
    )!;
    act(() => {
      variantSelect.value = "sunburst";
      variantSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(changes.at(-1)).toMatchObject({ variant: "sunburst" });
  });

  it("honors exclude for fields a dedicated control owns", () => {
    const { container } = mount(
      createElement(ModelOptionsForm, { schema, value: {}, onChange: () => {}, exclude: ["variant"] })
    );
    const opts = Array.from(container.querySelectorAll("option")).map((o) => o.value);
    expect(opts).not.toContain("sunburst");
  });
});

describe("pruneModelOptionValues", () => {
  it("drops keys the schema doesn't declare and keeps known ones", () => {
    const out = pruneModelOptionValues(schema, { variant: "flare", bogus: "x", quality: "high" });
    expect(out).toEqual({ variant: "flare", quality: "high" });
  });

  it("passes values through when the schema is null", () => {
    expect(pruneModelOptionValues(null, { x: 1 })).toEqual({ x: 1 });
  });
});
