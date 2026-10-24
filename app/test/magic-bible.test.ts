/**
 * Magic Prompt rearchitecture: the Story Bible pass + per-scene generation.
 *
 * The model must see the WHOLE story (bible) while each shot's own script
 * visual stays authoritative for what it depicts. These tests pin:
 *  - the bible builder sends every scene/shot + the rich reference roster,
 *    and never the stale magic prose;
 *  - the bible parser only trusts roster-bound citations (aliases resolve to
 *    canonical names, invented references are dropped);
 *  - a bulk run = one bible call + one call per scene, the bible is stored,
 *    and alias tags in replies are canonicalized on the way in;
 *  - per-shot regeneration reuses the stored bible (no new bible call) and
 *    touches only its own entry;
 *  - unresolved cited names are computed deterministically for the queue.
 */
import { describe, it, expect, vi } from "vitest";
import type { Production, ProductionShot } from "../src/shared/ipc.js";

vi.mock("../src/main/scripting.js", () => ({
  extractScriptText: vi.fn(),
  isGoogleDocUrl: vi.fn(() => false),
}));

// Answer bible calls with a bible, scene calls with one fresh prompt per
// shot row in the request (citing the hero by her SCRIPT name on purpose —
// canonicalization must rewrite it to the user's reference name).
const modelCalls = vi.hoisted(() => [] as string[]);
vi.mock("@core", () => ({
  ChatClient: class {
    async completeOnce(_model: string, messages: Array<{ role: string; content: string }>): Promise<{ text: string }> {
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      modelCalls.push(user);
      if (user.includes("Build the STORY BIBLE")) {
        return {
          text: JSON.stringify({
            synopsis: "Ada crosses the valley to confront the villain on the ridge.",
            assumptions: ["The valley is at dawn."],
            scenes: [
              { number: 1, title: "Valley", location: "open valley", timeOfDay: "dawn", beat: "Ada sets out." },
              { number: 2, title: "Ridge", location: "rocky ridge", beat: "Confrontation." },
            ],
            entities: [
              { name: "Ada the hero", kind: "character", descriptor: "young woman in a red cloak", refName: "Hero", aliases: ["Ada"] },
              { name: "Ghost Helper", kind: "character", descriptor: "nobody", refName: "NoSuchRef" },
            ],
            shotPlans: [
              { number: "0100", purpose: "establish Ada setting out", framing: "wide", present: ["Ada the hero"], mustCite: ["MainCharacter"] },
              { number: "0200", purpose: "reveal the villain", framing: "medium", mustCite: ["InventedRef"] },
              { number: "9999", purpose: "does not exist", mustCite: [] },
            ],
          }),
        };
      }
      const nums = [...user.matchAll(/^(\d{4}) \|/gm)].map((m) => m[1]);
      return {
        text: JSON.stringify({
          prompts: nums.map((n) => ({ number: n, prompt: `Fresh ${n} content with @[MainCharacter].` })),
        }),
      };
    }
  },
}));

import {
  buildMagicBibleMessages,
  generateMagicPrompts,
  isMagicBibleStale,
  magicBibleInputHash,
  parseMagicBibleReply,
} from "../src/main/pipeline.js";
import { computeUnresolvedMagicRefs, magicRefRoster } from "../src/shared/magic-refs.js";

function shot(id: string, number: string, visual: string, audio = ""): ProductionShot {
  return { id, number, audio, visual } as ProductionShot;
}

function prod(): Production {
  return {
    meta: { id: "p1", name: "T", folder: "C:/nonexistent-prod" },
    magicEnabled: true,
    scenes: [
      { number: 1, title: "Valley", shots: [shot("s100", "0100", "Ada walks through the valley.")] },
      { number: 2, title: "Ridge", shots: [shot("s200", "0200", "The villain appears on the ridge.")] },
    ],
    magicPrompts: { s100: "STALE prose about a constellation @[Hero]" },
    characters: [
      { id: "c1", name: "Hero", key: "young woman in a red cloak", aliases: ["MainCharacter", "Ada"], imagePath: "references/hero.png" },
    ],
    products: [],
    references: [],
    styles: [],
    assets: { outDir: "out" },
  } as unknown as Production;
}

describe("magicBibleInputHash / staleness", () => {
  it("is stable for unchanged inputs and flips when a visual changes", () => {
    const p = prod();
    const h = magicBibleInputHash(p);
    expect(magicBibleInputHash(p)).toBe(h);
    p.scenes[0].shots[0].visual = "Ada runs through the valley.";
    expect(magicBibleInputHash(p)).not.toBe(h);
    expect(isMagicBibleStale(p)).toBe(true);
  });
});

describe("buildMagicBibleMessages", () => {
  it("sends the whole story + rich roster, never the stale magic prose", () => {
    const p = prod();
    const { userContent } = buildMagicBibleMessages(p, null);
    expect(userContent).toContain("Build the STORY BIBLE");
    expect(userContent).toContain("Scene 1");
    expect(userContent).toContain("Ada walks through the valley.");
    expect(userContent).toContain("The villain appears on the ridge.");
    expect(userContent).toContain("@[Hero]");
    expect(userContent).toContain("young woman in a red cloak");
    expect(userContent).toContain("MainCharacter");
    expect(userContent).not.toContain("STALE prose about a constellation");
  });
});

describe("parseMagicBibleReply", () => {
  it("binds citations to the roster: aliases canonicalize, inventions drop", () => {
    const p = prod();
    const bible = parseMagicBibleReply(JSON.stringify({
      synopsis: "Ada confronts the villain.",
      assumptions: ["Dawn."],
      scenes: [{ number: 1, title: "Valley", beat: "Sets out." }],
      entities: [
        { name: "Ada", kind: "character", descriptor: "red cloak", refName: "MainCharacter" },
        { name: "Ghost", kind: "character", descriptor: "x", refName: "NoSuchRef" },
      ],
      shotPlans: [
        { number: "0100", purpose: "establish", mustCite: ["MainCharacter", "InventedRef"] },
        { number: "9999", purpose: "ghost shot", mustCite: [] },
      ],
    }), p);
    expect(bible).not.toBeNull();
    expect(bible!.entities[0].refName).toBe("Hero");
    expect(bible!.entities[1].refName).toBeUndefined();
    expect(bible!.shotPlans).toHaveLength(1);
    expect(bible!.shotPlans[0].mustCite).toEqual(["Hero"]);
  });

  it("returns null on an unusable reply", () => {
    expect(parseMagicBibleReply("no json", prod())).toBeNull();
  });
});

describe("generateMagicPrompts (bible + per-scene)", () => {
  it("bulk run: one bible call + one call per scene; bible stored; alias tags canonicalized", async () => {
    modelCalls.length = 0;
    const p = prod();
    await generateMagicPrompts(p, "key", "model", () => {});
    expect(modelCalls).toHaveLength(3);
    expect(modelCalls[0]).toContain("Build the STORY BIBLE");
    expect(p.magicBible?.synopsis).toContain("Ada crosses the valley");
    expect(p.magicBible?.inputHash).toBe(magicBibleInputHash(p));
    expect(p.magicPrompts?.s100).toBe("Fresh 0100 content with @[Hero].");
    expect(p.magicPrompts?.s200).toBe("Fresh 0200 content with @[Hero].");
    // The scene call was grounded in the bible (synopsis visible to the writer).
    expect(modelCalls[1]).toContain("Ada crosses the valley");
  });

  it("per-shot regen reuses the stored bible and touches only its entry", async () => {
    modelCalls.length = 0;
    const p = prod();
    await generateMagicPrompts(p, "key", "model", () => {});
    const before = p.magicPrompts?.s200;
    modelCalls.length = 0;
    await generateMagicPrompts(p, "key", "model", () => {}, undefined, ["s100"]);
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]).not.toContain("Build the STORY BIBLE");
    expect(modelCalls[0]).toContain("Ada crosses the valley");
    expect(p.magicPrompts?.s200).toBe(before);
  });
});

describe("computeUnresolvedMagicRefs", () => {
  it("groups unmatched citations by shot and skips resolved/dismissed names", () => {
    const p = prod();
    p.magicPrompts = {
      s100: "Ada meets @[MysteryFigure] and @[MainCharacter].",
      s200: "@[MysteryFigure] looms. @[DismissedName] too.",
    };
    p.magicDismissedRefs = ["dismissedname"];
    const unresolved = computeUnresolvedMagicRefs(p);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].citedName).toBe("MysteryFigure");
    expect(unresolved[0].shotNumbers).toEqual(["0100", "0200"]);
  });

  it("roster carries descriptors, aliases, and artwork presence", () => {
    const roster = magicRefRoster(prod());
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ name: "Hero", kind: "character", descriptor: "young woman in a red cloak", hasArtwork: true });
    expect(roster[0].aliases).toEqual(["MainCharacter", "Ada"]);
  });
});
