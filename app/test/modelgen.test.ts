/**
 * ModelgenClient tests — the module's interface IS the test surface.
 *
 * The HTTP fetch is injected, so a fake substitutes for the live 3D AI Studio
 * REST API: canned responses drive the submit → poll → download flow exactly
 * as the real endpoint would. No Electron, no network.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ModelGenClient,
  ModelGenError,
  ModelGenPendingError,
  bytePreview,
  isGlbBytes,
  modelFileName,
  toProductionModel,
  type HttpFetch,
} from "../src/main/modelgen.js";

/** Minimal-but-valid GLB bytes: 12-byte header with the "glTF" magic. */
function glbBytes(tag = 1): Uint8Array {
  const b = new Uint8Array(12);
  b[0] = 0x67; b[1] = 0x6c; b[2] = 0x54; b[3] = 0x46; // "glTF"
  b[4] = 2; // version 2
  b[8] = tag; // marker for equality checks
  return b;
}

/** Canned route handlers for the fake fetch, keyed by URL path. */
type Route = (body: string | null, headers: Record<string, string>) => {
  status: number;
  json?: unknown;
  bytes?: Uint8Array;
  contentType?: string;
};

function fakeFetch(routes: Record<string, Route>): HttpFetch {
  return async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const path = new URL(url).pathname;
    const route =
      routes[path] ??
      routes["*"] ??
      Object.entries(routes).find(([k]) => path.includes(k))?.[1];
    if (!route) throw new Error(`No fake route for ${url}`);
    const res = route(init?.body ?? null, init?.headers ?? {});
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      contentType: res.contentType,
      json: async () => res.json ?? {},
      arrayBuffer: async () => {
        const b = res.bytes ?? new Uint8Array(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
    };
  };
}

/** A default successful-flow fake. The asset route rejects the authenticated
 *  attempt (400, like the real storage host) then serves GLB bytes to the
 *  anonymous fallback. */
function successRoutes(): Record<string, Route> {
  return {
    "/account/user/wallet/": () => ({ status: 200, json: { balance: "150.00" } }),
    "/v1/3d-models/tencent/generate/pro/": () => ({
      status: 200,
      json: { task_id: "abc-123" },
    }),
    "abc-123": () => ({
      status: 200,
      json: {
        status: "FINISHED",
        progress: 100,
        failure_reason: null,
        results: [{ asset: "https://storage.3daistudio.com/assets/abc123.glb", asset_type: "3D_MODEL" }],
      },
    }),
    "asset": (b, h) => {
      if (h.Authorization) return { status: 400, contentType: "text/plain" };
      return { status: 200, bytes: glbBytes(), contentType: "model/gltf-binary" };
    },
  };
}

const OPTS = {
  prompt: "a red chair",
  version: "3.0" as const,
  enablePbr: true,
  generateType: "Normal" as const,
  faceCount: 500000,
};

function client(routes: Record<string, Route> = successRoutes()): ModelGenClient {
  return new ModelGenClient(() => "test-key", fakeFetch(routes), 1, 10_000);
}

describe("ModelGenClient.getCredits", () => {
  it("reads the wallet balance", async () => {
    const c = client();
    await expect(c.getCredits()).resolves.toBe(150);
  });

  it("returns null when the key is missing", async () => {
    const c = new ModelGenClient(() => null, fakeFetch(successRoutes()));
    await expect(c.getCredits()).resolves.toBeNull();
  });
});

describe("ModelGenClient.generate", () => {
  it("submits, polls, and downloads the finished GLB", async () => {
    const calls: string[] = [];
    const c = new ModelGenClient(
      () => "test-key",
      fakeFetch({
        "/v1/3d-models/tencent/generate/pro/": (_b, h) => {
          calls.push("submit");
          expect(h.Authorization).toBe("Bearer test-key");
          expect(h["Content-Type"]).toBe("application/json");
          return { status: 200, json: { task_id: "abc-123" } };
        },
        "abc-123": () => {
          calls.push("poll");
          return {
            status: 200,
            json: { status: "FINISHED", progress: 100, results: [{ asset: "https://storage.3daistudio.com/assets/abc123.glb" }] },
          };
        },
        "asset": (_b, h) => {
          calls.push("download:" + (h.Authorization ? "auth" : "anon"));
          // The storage host rejects the API Bearer token (400) but serves the
          // GLB to the anonymous fallback.
          if (h.Authorization) return { status: 400, contentType: "text/plain" };
          return { status: 200, bytes: glbBytes(7), contentType: "model/gltf-binary" };
        },
      })
    );
    const bytes = await c.generate(OPTS);
    expect(bytes).toEqual(glbBytes(7));
    expect(calls).toEqual(["submit", "poll", "download:auth", "download:anon"]);
  });

  it("sends a prompt-only body for text-to-3D", async () => {
    let sent: string | null = null;
    const c = new ModelGenClient(
      () => "test-key",
      fakeFetch({
        "/v1/3d-models/tencent/generate/pro/": (body) => {
          sent = body;
          return { status: 200, json: { task_id: "t-txt" } };
        },
        "t-txt": () => ({ status: 200, json: { status: "FINISHED", results: [{ asset: "https://storage.3daistudio.com/assets/x.glb" }] } }),
        "asset": () => ({ status: 200, bytes: glbBytes() }),
      })
    );
    await c.generate(OPTS);
    const b = JSON.parse(sent ?? "{}") as Record<string, unknown>;
    expect(b.prompt).toBe("a red chair");
    expect(b.image).toBeUndefined();
    expect(b.multi_view_images).toBeUndefined();
  });

  it("omits prompt for Normal image-to-3D (the API rejects prompt+image outside Sketch)", async () => {
    let sent: string | null = null;
    const c = new ModelGenClient(
      () => "test-key",
      fakeFetch({
        "/v1/3d-models/tencent/generate/pro/": (body) => {
          sent = body;
          return { status: 200, json: { task_id: "t-img" } };
        },
        "t-img": () => ({ status: 200, json: { status: "FINISHED", results: [{ asset: "https://storage.3daistudio.com/assets/x.glb" }] } }),
        "asset": () => ({ status: 200, bytes: glbBytes() }),
      })
    );
    await c.generate({ ...OPTS, prompt: "", imageDataUrl: "data:image/png;base64,AAA" });
    const b = JSON.parse(sent ?? "{}") as Record<string, unknown>;
    expect(b.image).toBe("data:image/png;base64,AAA");
    expect(b.prompt).toBeUndefined();
  });

  it("sends prompt + image together only for Sketch mode", async () => {
    let sent: string | null = null;
    const c = new ModelGenClient(
      () => "test-key",
      fakeFetch({
        "/v1/3d-models/tencent/generate/pro/": (body) => {
          sent = body;
          return { status: 200, json: { task_id: "t-sk" } };
        },
        "t-sk": () => ({ status: 200, json: { status: "FINISHED", results: [{ asset: "https://storage.3daistudio.com/assets/x.glb" }] } }),
        "asset": () => ({ status: 200, bytes: glbBytes() }),
      })
    );
    await c.generate({ ...OPTS, generateType: "Sketch", imageDataUrl: "data:image/png;base64,AAA" });
    const b = JSON.parse(sent ?? "{}") as Record<string, unknown>;
    expect(b.image).toBe("data:image/png;base64,AAA");
    expect(b.prompt).toBe("a red chair");
    expect(b.generate_type).toBe("Sketch");
  });

  it("sends multi-view images as multi_view_images (no image/prompt)", async () => {
    let sent: string | null = null;
    const c = new ModelGenClient(
      () => "test-key",
      fakeFetch({
        "/v1/3d-models/tencent/generate/pro/": (body) => {
          sent = body;
          return { status: 200, json: { task_id: "t-mv" } };
        },
        "t-mv": () => ({ status: 200, json: { status: "FINISHED", results: [{ asset: "https://storage.3daistudio.com/assets/x.glb" }] } }),
        "asset": () => ({ status: 200, bytes: glbBytes() }),
      })
    );
    await c.generate({
      ...OPTS,
      prompt: "",
      multiViewImages: [
        { viewType: "front", dataUrl: "data:image/png;base64,AAA" },
        { viewType: "left", dataUrl: "data:image/png;base64,BBB" },
      ],
    });
    const b = JSON.parse(sent ?? "{}") as Record<string, unknown>;
    expect(b.image).toBeUndefined();
    expect(b.prompt).toBeUndefined();
    expect(b.multi_view_images).toEqual([
      { view_type: "front", view_image: "data:image/png;base64,AAA" },
      { view_type: "left", view_image: "data:image/png;base64,BBB" },
    ]);
  });

  it("polls IN_PROGRESS until FINISHED", async () => {
    let pollCount = 0;
    const c = new ModelGenClient(
      () => "test-key",
      fakeFetch({
        "/v1/3d-models/tencent/generate/pro/": () => ({ status: 200, json: { task_id: "t1" } }),
        "t1": () => {
          pollCount++;
          return {
            status: 200,
            json:
              pollCount < 2
                ? { status: "IN_PROGRESS", progress: 50 }
                : { status: "FINISHED", results: [{ asset: "https://storage.3daistudio.com/assets/y.glb" }] },
          };
        },
        "asset": () => ({ status: 200, bytes: glbBytes() }),
      }),
      1,
      10_000
    );
    const polls: string[] = [];
    await c.generate(OPTS, (s) => polls.push(s));
    expect(pollCount).toBe(2);
    expect(polls).toEqual(["IN_PROGRESS", "FINISHED"]);
  });

  it("throws ModelGenError on a FAILED status", async () => {
    const c = new ModelGenClient(
      () => "test-key",
      fakeFetch({
        "/v1/3d-models/tencent/generate/pro/": () => ({ status: 200, json: { task_id: "t2" } }),
        "t2": () => ({ status: 200, json: { status: "FAILED", failure_reason: "bad prompt" } }),
      })
    );
    await expect(c.generate(OPTS)).rejects.toThrow(/bad prompt/);
  });

  it("throws ModelGenPendingError when the deadline passes", async () => {
    const c = new ModelGenClient(
      () => "test-key",
      fakeFetch({
        "/v1/3d-models/tencent/generate/pro/": () => ({ status: 200, json: { task_id: "t3" } }),
        "t3": () => ({ status: 200, json: { status: "IN_PROGRESS", progress: 1 } }),
      }),
      1,
      5
    );
    await expect(c.generate(OPTS)).rejects.toBeInstanceOf(ModelGenPendingError);
  });

  it("refuses to save a non-GLB download (surfaces the server body instead)", async () => {
    const c = new ModelGenClient(
      () => "test-key",
      fakeFetch({
        "/v1/3d-models/tencent/generate/pro/": () => ({ status: 200, json: { task_id: "t4" } }),
        "t4": () => ({ status: 200, json: { status: "FINISHED", results: [{ asset: "https://storage.3daistudio.com/assets/bad.glb" }] } }),
        "asset": () => ({ status: 200, bytes: new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]), contentType: "text/html" }),
      })
    );
    await expect(c.generate(OPTS)).rejects.toThrow(/not a GLB model/);
  });

  it("requires a stored API key", async () => {
    const c = new ModelGenClient(() => null, fakeFetch(successRoutes()));
    await expect(c.generate(OPTS)).rejects.toThrow(/API key/);
  });

  it("surfaces HTTP errors from the API", async () => {
    const c = new ModelGenClient(
      () => "test-key",
      fakeFetch({
        "/v1/3d-models/tencent/generate/pro/": () => ({ status: 402, json: { detail: "insufficient_credits" } }),
      })
    );
    await expect(c.generate(OPTS)).rejects.toThrow(/insufficient_credits/);
  });
});

describe("modelFileName / toProductionModel", () => {
  it("derives a safe, timestamped .glb filename", () => {
    const name = modelFileName({ ...OPTS, prompt: "Red  Chair!" }, 1000);
    expect(name).toMatch(/^model-red-chair-[a-z0-9]+\.glb$/);
  });

  it("falls back for a blank prompt", () => {
    expect(modelFileName({ ...OPTS, prompt: "" }, 1000)).toMatch(/^model-[a-z0-9]+\.glb$/);
  });

  it("builds the persisted production record", () => {
    const m = toProductionModel("models/model-x.glb", { ...OPTS, imageDataUrl: "data:image/png;base64,AAA" }, 1000);
    expect(m.glbPath).toBe("models/model-x.glb");
    expect(m.pbr).toBe(true);
    expect(m.fromImage).toBe(true);
    expect(m.edition).toBe("pro");
    expect(m.id).toMatch(/^model3d-/);
  });
});

describe("isGlbBytes / bytePreview", () => {
  it("recognizes the glTF magic prefix", () => {
    expect(isGlbBytes(glbBytes())).toBe(true);
  });

  it("rejects short / non-GLB buffers", () => {
    expect(isGlbBytes(new Uint8Array(4))).toBe(false);
    expect(isGlbBytes(new TextEncoder().encode("<html>error</html>"))).toBe(false);
  });

  it("renders a readable preview of arbitrary bytes", () => {
    const preview = bytePreview(new TextEncoder().encode("<html>"));
    expect(preview).toContain("<html>");
  });
});