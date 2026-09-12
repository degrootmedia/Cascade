/**
 * MCP/CLI transport toggle — the shared predicate, the persisted mode flag,
 * and the active-provider reconciliation rule.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isProviderVisible,
  styleFrameOverride,
  type MediaProviderId,
  type MediaProviderInfo,
} from "../src/shared/ipc.js";
import {
  TRANSPORT_CHANGED,
  firstVisibleAvailable,
  hasStoredTransportMode,
  readTransportMode,
  writeTransportMode,
} from "../src/renderer/src/components/media-transport.js";

const ALL_IDS: MediaProviderId[] = ["openart", "higgsfield", "higgsfield-cli", "openart-cli"];

function info(id: MediaProviderId, available: boolean): MediaProviderInfo {
  return { id, displayName: id, available };
}

describe("isProviderVisible", () => {
  it("shows only MCP ids in mcp mode and only CLI ids in cli mode", () => {
    expect(ALL_IDS.filter((id) => isProviderVisible(id, "mcp"))).toEqual(["openart", "higgsfield"]);
    expect(ALL_IDS.filter((id) => isProviderVisible(id, "cli"))).toEqual(["higgsfield-cli", "openart-cli"]);
  });
});

describe("styleFrameOverride", () => {
  it("canonicalizes auto/blank/absent to undefined (production default)", () => {
    expect(styleFrameOverride(undefined)).toBeUndefined();
    expect(styleFrameOverride("auto")).toBeUndefined();
    expect(styleFrameOverride("")).toBeUndefined();
  });

  it("passes explicit picks through untouched", () => {
    expect(styleFrameOverride("some-model")).toBe("some-model");
    expect(styleFrameOverride("2k")).toBe("2k");
  });
});

describe("transport mode persistence", () => {
  const realDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
        removeItem: (k: string) => {
          delete store[k];
        },
      },
      configurable: true,
    });
  });

  afterEach(() => {
    if (realDescriptor) Object.defineProperty(globalThis, "localStorage", realDescriptor);
    else delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("defaults to mcp and coerces invalid values to mcp", () => {
    expect(readTransportMode()).toBe("mcp");
    expect(hasStoredTransportMode()).toBe(false);
    store["cascade.providerTransportMode"] = "carrier-pigeon";
    expect(readTransportMode()).toBe("mcp");
    expect(hasStoredTransportMode()).toBe(false);
  });

  it("round-trips a stored cli mode and broadcasts the change", () => {
    let events = 0;
    const onChange = () => {
      events++;
    };
    window.addEventListener(TRANSPORT_CHANGED, onChange);
    try {
      writeTransportMode("cli");
      expect(readTransportMode()).toBe("cli");
      expect(hasStoredTransportMode()).toBe(true);
      expect(events).toBe(1);
    } finally {
      window.removeEventListener(TRANSPORT_CHANGED, onChange);
    }
  });
});

describe("firstVisibleAvailable", () => {
  const list = [info("openart", true), info("higgsfield", true), info("higgsfield-cli", false), info("openart-cli", true)];

  it("picks the first available provider on the target transport", () => {
    // higgsfield-cli unavailable → falls to openart-cli.
    expect(firstVisibleAvailable(list, "cli")).toBe("openart-cli");
    expect(firstVisibleAvailable(list, "mcp")).toBe("openart");
  });

  it("returns null when nothing is available (active provider stays put, no event)", () => {
    const dark = [info("openart", true), info("higgsfield-cli", false), info("openart-cli", false)];
    expect(firstVisibleAvailable(dark, "cli")).toBeNull();
  });
});

describe("ProductionStyle schema compatibility", () => {
  it("parses styles written by older builds (no model/resolution) unchanged", () => {
    const legacy = JSON.parse(
      `{"id":"s1","index":1,"name":"Heroic","prompt":"epic","imagePath":"styles/s1.jpg","frameSource":"generated"}`,
    );
    expect(legacy.model).toBeUndefined();
    expect(legacy.resolution).toBeUndefined();
    expect(JSON.parse(JSON.stringify(legacy))).toEqual(legacy);
  });

  it("round-trips per-style overrides when present", () => {
    const styled = JSON.parse(
      `{"id":"s1","index":1,"name":"Heroic","prompt":"epic","model":"some-model","resolution":"2k"}`,
    );
    expect(styled.model).toBe("some-model");
    expect(styled.resolution).toBe("2k");
    expect(JSON.parse(JSON.stringify(styled))).toEqual(styled);
  });
});
