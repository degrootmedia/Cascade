/**
 * DurationField: a dropdown in every shape. Closed-enum models offer
 * their list verbatim; open-integer models (e.g. Seedance — any whole
 * seconds) expand their range into one option per second. Regression:
 * open models reported no closed durations, so every video surface fell
 * back to a hardcoded [5,10,15,20] select and snapped saved off-ladder
 * values back to 5s.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import {
  DurationField,
  clampDurationSec,
  durationOptionsOf,
  expandDurationRange,
  isOpenDuration,
  snapDurationSec,
} from "../src/renderer/src/components/production/duration-field.js";
import type { VideoModelOptions } from "../src/shared/ipc.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const OPEN: VideoModelOptions = { resolutions: ["720p"], durations: [], durationRange: {} };
const BOUNDED: VideoModelOptions = { resolutions: ["720p"], durations: [], durationRange: { min: 3, max: 12 } };
const CLOSED: VideoModelOptions = { resolutions: ["720p"], durations: [4, 6, 8] };

describe("duration helpers", () => {
  it("classifies open vs closed options and falls back only when unknown", () => {
    expect(isOpenDuration(OPEN)).toBe(true);
    expect(isOpenDuration(CLOSED)).toBe(false);
    expect(isOpenDuration(null)).toBe(false);
    expect(durationOptionsOf(CLOSED)).toEqual([4, 6, 8]);
    expect(durationOptionsOf(null)).toEqual([5, 10, 15, 20]);
  });

  it("expands an open range into one option per second", () => {
    expect(durationOptionsOf(BOUNDED)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const open = durationOptionsOf(OPEN);
    expect(open[0]).toBe(1);
    expect(open).toContain(7);
    expect(open).toContain(23);
    expect(open[open.length - 1]).toBe(30);
    expect(expandDurationRange({ min: 2, max: 10, step: 2 })).toEqual([2, 4, 6, 8, 10]);
    expect(expandDurationRange({ max: 5 })).toEqual([1, 2, 3, 4, 5]);
  });

  it("clamps only into published bounds", () => {
    expect(clampDurationSec(7, OPEN)).toBe(7);
    expect(clampDurationSec(23, OPEN)).toBe(23);
    expect(clampDurationSec(2, BOUNDED)).toBe(3);
    expect(clampDurationSec(30, BOUNDED)).toBe(12);
    expect(clampDurationSec(0, BOUNDED)).toBe(0); // Auto sentinel passes
    expect(clampDurationSec(7.6, OPEN)).toBe(8);
  });

  it("snaps closed off-list values but never resets open values to the fallback ladder", () => {
    expect(snapDurationSec(5, CLOSED)).toBe(4);
    expect(snapDurationSec(6, CLOSED)).toBe(6);
    expect(snapDurationSec(7, OPEN)).toBe(7);
    expect(snapDurationSec(23, OPEN)).toBe(23);
    expect(snapDurationSec(30, BOUNDED)).toBe(12);
    expect(snapDurationSec(7, null)).toBe(7);
    expect(snapDurationSec(0, CLOSED, true)).toBe(0);
    expect(snapDurationSec(0, OPEN, true)).toBe(0);
  });
});

let root: Root | null = null;
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount(); }); root = null; }
  document.body.innerHTML = "";
});

async function renderField(props: { opts: VideoModelOptions | null; value: number; auto?: boolean }) {
  const seen: number[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(DurationField, { ...props, onChange: (n: number) => seen.push(n) }));
  });
  return { container, seen };
}

describe("DurationField rendering", () => {
  it("renders a per-second dropdown for an open model and emits the pick", async () => {
    const { container, seen } = await renderField({ opts: OPEN, value: 5 });
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(container.querySelector("input")).toBeNull();
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain("7s");
    expect(labels).toContain("23s");
    expect(labels[labels.length - 1]).toBe("30s");
    await act(async () => {
      select.value = "23";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(seen).toContain(23);
  });

  it("renders bounded options for a bounded open model", async () => {
    const { container } = await renderField({ opts: BOUNDED, value: 5 });
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(
      [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `${n}s`)
    );
  });

  it("renders the closed select for an enum model", async () => {
    const { container } = await renderField({ opts: CLOSED, value: 6 });
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["4s", "6s", "8s"]);
  });

  it("keeps a saved off-list value as an option instead of dropping it", async () => {
    const { container } = await renderField({ opts: BOUNDED, value: 45 });
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toContain("45s");
    expect(select.value).toBe("45");
  });

  it("keeps the Auto choice for edit-video in both shapes", async () => {
    const closed = await renderField({ opts: CLOSED, value: 0, auto: true });
    expect((closed.container.querySelector("select") as HTMLSelectElement).options[0].textContent).toBe("Auto");
    const open = await renderField({ opts: OPEN, value: 0, auto: true });
    const select = open.container.querySelector("select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.options[0].textContent).toBe("Auto");
    expect(select.options[1].textContent).toBe("1s");
  });
});
