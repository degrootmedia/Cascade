/**
 * ref-watch tests — the reference external-edit watcher. Directory watchers,
 * file signatures, production loading, and ref collection are all injected, so
 * these exercise change detection and watcher reconciliation with no disk.
 */
import { describe, it, expect, vi } from "vitest";
import { createRefWatcher, type RefStat, type WatchHandle } from "../src/main/ref-watch.js";
import type { Production } from "../src/shared/ipc.js";

function makeProduction(id: string, refs: Array<{ id: string; rel: string }>): Production {
  return {
    meta: { id, name: id, folder: `/prod/${id}` },
    references: refs.map((r) => ({ id: r.id, name: r.id, imagePath: r.rel })),
  } as unknown as Production;
}

interface Harness {
  watcher: ReturnType<typeof createRefWatcher>;
  onChanged: ReturnType<typeof vi.fn>;
  fire(dir: string): void;
  stats: Map<string, RefStat>;
  closed: string[];
}

function makeHarness(productions: Map<string, Production>): Harness {
  const stats = new Map<string, RefStat>();
  const watchers = new Map<string, () => void>();
  const closed: string[] = [];
  const onChanged = vi.fn();
  const watcher = createRefWatcher(
    {
      loadProduction: (id) => productions.get(id) ?? null,
      collectRefs: (p) =>
        (p.references ?? []).flatMap((r) => [
          ...(r.imagePath ? [{ id: r.id, rel: r.imagePath }] : []),
          ...(r.mediaPath ? [{ id: r.id, rel: r.mediaPath }] : []),
        ]),
      assetPath: (p, rel) => `${p.meta.folder}/${rel}`,
      stat: (abs) => stats.get(abs) ?? null,
      watchDir: (dir, cb): WatchHandle => {
        watchers.set(dir, cb);
        return {
          close: () => {
            watchers.delete(dir);
            closed.push(dir);
          },
        };
      },
    },
    onChanged,
    0
  );
  return {
    watcher,
    onChanged,
    stats,
    closed,
    fire: (dir) => watchers.get(dir)?.(),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createRefWatcher", () => {
  it("baselines on watch and reports only real changes", async () => {
    const p = makeProduction("p1", [{ id: "r1", rel: "references/hero.png" }]);
    const h = makeHarness(new Map([["p1", p]]));
    h.stats.set("/prod/p1/references/hero.png", { mtimeMs: 1000, size: 10 });

    h.watcher.watch("p1");
    expect(h.onChanged).not.toHaveBeenCalled();

    // A no-op sweep outside the tolerance reports nothing.
    h.watcher.scan();
    expect(h.onChanged).not.toHaveBeenCalled();

    // An external save (newer mtime) fires, once.
    h.stats.set("/prod/p1/references/hero.png", { mtimeMs: 2000, size: 20 });
    h.watcher.scan();
    expect(h.onChanged).toHaveBeenCalledTimes(1);
    expect(h.onChanged).toHaveBeenCalledWith("p1", [{ id: "r1", rel: "references/hero.png" }]);

    // The signature is re-baselined: the next sweep is quiet.
    h.watcher.scan();
    expect(h.onChanged).toHaveBeenCalledTimes(1);
  });

  it("detects a size-only rewrite and coalesces directory events through the debounce", async () => {
    const p = makeProduction("p1", [{ id: "r1", rel: "references/hero.png" }]);
    const h = makeHarness(new Map([["p1", p]]));
    h.stats.set("/prod/p1/references/hero.png", { mtimeMs: 1000, size: 10 });
    h.watcher.watch("p1");

    h.stats.set("/prod/p1/references/hero.png", { mtimeMs: 1000, size: 99 });
    h.fire("/prod/p1/references");
    h.fire("/prod/p1/references");
    await tick();
    expect(h.onChanged).toHaveBeenCalledTimes(1);
    expect(h.onChanged).toHaveBeenCalledWith("p1", [{ id: "r1", rel: "references/hero.png" }]);
  });

  it("follows the production's reference set and reconciles watchers", async () => {
    const p1 = makeProduction("p1", [{ id: "r1", rel: "references/hero.png" }]);
    const p2 = makeProduction("p2", [
      { id: "r2", rel: "references/villain.png" },
      { id: "r3", rel: "grids/sheet.png" },
    ]);
    const h = makeHarness(new Map([["p1", p1], ["p2", p2]]));
    h.stats.set("/prod/p1/references/hero.png", { mtimeMs: 1000, size: 1 });
    h.stats.set("/prod/p2/references/villain.png", { mtimeMs: 1000, size: 1 });
    h.stats.set("/prod/p2/grids/sheet.png", { mtimeMs: 1000, size: 1 });

    h.watcher.watch("p1");
    h.watcher.watch("p2");
    // The stale production's directory is unwatched.
    expect(h.closed).toContain("/prod/p1/references");

    h.stats.set("/prod/p2/grids/sheet.png", { mtimeMs: 5000, size: 1 });
    h.fire("/prod/p2/grids");
    await tick();
    expect(h.onChanged).toHaveBeenCalledWith("p2", [{ id: "r3", rel: "grids/sheet.png" }]);
  });

  it("stops watching when cleared", async () => {
    const p = makeProduction("p1", [{ id: "r1", rel: "references/hero.png" }]);
    const h = makeHarness(new Map([["p1", p]]));
    h.stats.set("/prod/p1/references/hero.png", { mtimeMs: 1000, size: 10 });
    h.watcher.watch("p1");
    h.watcher.clear();
    expect(h.closed).toContain("/prod/p1/references");

    h.stats.set("/prod/p1/references/hero.png", { mtimeMs: 5000, size: 1 });
    h.watcher.scan();
    expect(h.onChanged).not.toHaveBeenCalled();
  });
});
