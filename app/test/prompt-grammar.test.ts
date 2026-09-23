/**
 * prompt-grammar tests — the shared serialization grammar (tags, Style/Brand
 * paragraphs, loose JSON, media helpers) used by main, renderer, and the
 * OpenArtClient. These pin the behavior of helpers that used to be duplicated
 * across pipeline.ts, openart.ts, NodeGraphModal.tsx, ProductionWorkspace.tsx,
 * TriplePrompt.tsx, and PromptContentEditor.tsx.
 */
import { describe, it, expect } from "vitest";
import {
  addRefTag,
  addStyleParagraph,
  composePromptBoxes,
  dataUrlToBytes,
  hasBrandParagraph,
  hasRefTag,
  IMAGE_URL_RX,
  insertBrandParagraph,
  isTagOnlyDiff,
  parseJsonLooseArray,
  parseJsonLooseObject,
  parsePromptBoxes,
  refTagMatches,
  refTagNames,
  removeRefTag,
  renameRefTag,
  replaceRefTagAt,
  stripBrandParagraph,
  stripReferenceClause,
  stripStyleParagraph,
  VIDEO_URL_RX,
} from "../src/shared/prompt-grammar.js";

describe("refTagMatches / refTagNames", () => {
  it("extracts tag names in document order with indices", () => {
    const text = "Show @[Gandalf] and @[Aragorn] together";
    expect(refTagMatches(text)).toEqual([
      { tag: "@[Gandalf]", name: "Gandalf", index: 5 },
      { tag: "@[Aragorn]", name: "Aragorn", index: 20 },
    ]);
    expect(refTagNames(text)).toEqual(["Gandalf", "Aragorn"]);
  });

  it("returns an empty list for plain text", () => {
    expect(refTagNames("no tags here")).toEqual([]);
  });
});

describe("addRefTag / removeRefTag / hasRefTag", () => {
  it("is idempotent and case-insensitive", () => {
    const base = "Action paragraph.";
    const once = addRefTag(base, "Gandalf");
    expect(addRefTag(once, "gandalf")).toBe(once);
    expect(hasRefTag(base, "gandalf")).toBe(false);
    expect(hasRefTag(once, "GANDALF")).toBe(true);
  });

  it("inserts the tag before a trailing Brand identity paragraph", () => {
    const p = "Action.\n\nBrand identity: #123456";
    expect(addRefTag(p, "Gandalf")).toBe("Action.\n\n@[Gandalf]\n\nBrand identity: #123456");
  });

  it("removes every occurrence and tidies blank lines", () => {
    const p = "A @[Gandalf] B\n\n\n\nC @[gandalf] D";
    expect(removeRefTag(p, "Gandalf")).toBe("A  B\n\nC  D");
  });
});

describe("renameRefTag", () => {
  it("renames every occurrence case-insensitively, preserving position", () => {
    expect(renameRefTag("A @[Hero] B and @[hero] again", "Hero", "Champion")).toBe("A @[Champion] B and @[Champion] again");
  });

  it("is a no-op for equal names (modulo case) and leaves other tags alone", () => {
    expect(renameRefTag("A @[Hero] B @[Villain]", "Hero", "hero")).toBe("A @[Hero] B @[Villain]");
  });

  it("treats the old name literally, not as a regex", () => {
    expect(renameRefTag("see @[A.B (alt)]", "A.B (alt)", "A B")).toBe("see @[A B]");
  });
});

describe("replaceRefTagAt", () => {
  it("replaces the tag at the given occurrence, preserving its position", () => {
    expect(replaceRefTagAt("Show @[Gandalf] and @[Aragorn]", 1, "Legolas")).toBe("Show @[Gandalf] and @[Legolas]");
  });

  it("drops a duplicate of the incoming name elsewhere (cited once)", () => {
    expect(replaceRefTagAt("@[Gandalf] and @[Aragorn]", 0, "Aragorn")).toBe("@[Aragorn] and");
  });

  it("keeps the same ref in place when re-dropped on its own slot", () => {
    expect(replaceRefTagAt("A @[Gandalf] B @[Legolas] C", 0, "Gandalf")).toBe("A @[Gandalf] B @[Legolas] C");
  });

  it("appends when the index is out of range", () => {
    expect(replaceRefTagAt("Action.", 3, "Gandalf")).toBe("Action.\n\n@[Gandalf]");
  });
});

describe("Brand / Style paragraph helpers", () => {
  it("detects and strips the Brand identity paragraph", () => {
    const p = "Style: Photoreal\n\nAction here.\n\nBrand identity: #123456";
    expect(hasBrandParagraph(p)).toBe(true);
    expect(stripBrandParagraph(p)).toBe("Style: Photoreal\n\nAction here.");
    expect(hasBrandParagraph("no brand")).toBe(false);
  });

  it("inserts a Brand identity paragraph when absent", () => {
    expect(insertBrandParagraph("Action.", "#aabbcc")).toBe("Action.\n\nBrand identity: #aabbcc");
    expect(insertBrandParagraph("", "#aabbcc")).toBe("Brand identity: #aabbcc");
    expect(insertBrandParagraph("Action.", "")).toBe("Action.");
  });

  it("is idempotent — never adds a second Brand identity paragraph", () => {
    // Regression: effectivePrompt appends the brand to a manual prompt that
    // already carries one (written by the brand toggle); without the guard a
    // duplicate paragraph appears, and parsePromptBoxes then leaks it into
    // the content section too.
    const withBrand = "Action.\n\nBrand identity: #123456";
    expect(insertBrandParagraph(withBrand, "#aabbcc")).toBe(withBrand);
    expect(parsePromptBoxes(insertBrandParagraph(withBrand, "#aabbcc")).content).toBe("Action.");
    expect(parsePromptBoxes(insertBrandParagraph(withBrand, "#aabbcc")).brand).toBe("#123456");
  });

  it("adds and strips the Style paragraph", () => {
    const base = "Action here.";
    expect(addStyleParagraph(base, "Heroic 3D")).toBe("Style: Heroic 3D\n\nAction here.");
    // replacing an existing style keeps the rest
    expect(addStyleParagraph("Style: Old\n\nAction here.", "New")).toBe("Style: New\n\nAction here.");
    expect(stripStyleParagraph("Style: Heroic 3D\n\nAction here.")).toBe("Action here.");
  });

  // mirrorStyleParagraph was deleted in step 04 (rendering replaced
  // mirroring): the shared renderer in shared/graph/render.ts covers the
  // plugged/unplugged cases — see graph-render.test.ts.
});

describe("parsePromptBoxes / composePromptBoxes", () => {
  it("splits a prompt into Style / content / Brand", () => {
    expect(parsePromptBoxes("Style: Photoreal\n\n@[Gandalf] rides.\n\nBrand identity: #123456")).toEqual({
      style: "Photoreal",
      content: "@[Gandalf] rides.",
      brand: "#123456",
    });
  });

  it("round-trips through compose", () => {
    const boxes = { style: "Photoreal", content: "@[Gandalf] rides.", brand: "#123456" };
    expect(composePromptBoxes(boxes)).toBe("Style: Photoreal\n\n@[Gandalf] rides.\n\nBrand identity: #123456");
    expect(parsePromptBoxes(composePromptBoxes(boxes))).toEqual(boxes);
  });
});

describe("isTagOnlyDiff", () => {
  it("accepts tag add / remove / replace / reorder under focused typing", () => {
    expect(isTagOnlyDiff("Action.", "Action.\n\n@[Gandalf]")).toBe(true);
    expect(isTagOnlyDiff("Action.\n\n@[Gandalf]", "Action.")).toBe(true);
    expect(isTagOnlyDiff("Show @[Gandalf] and @[Aragorn]", "Show @[Aragorn] and @[Gandalf]")).toBe(true);
    expect(isTagOnlyDiff("Show @[Gandalf]", "Show @[Legolas]")).toBe(true);
  });

  it("rejects genuine prose edits so focused typing stays deferred", () => {
    expect(isTagOnlyDiff("Action.", "Action with more words.")).toBe(false);
    expect(isTagOnlyDiff("Hello @[Gandalf]", "Goodbye @[Gandalf]")).toBe(false);
  });
});

describe("stripReferenceClause", () => {
  it("removes the legacy alias clause", () => {
    expect(stripReferenceClause("Action.\n\nReference images by id: 1, 2, 3")).toBe("Action.");
  });
});

describe("parseJsonLooseObject / parseJsonLooseArray", () => {
  it("parses fenced JSON with trailing prose", () => {
    expect(parseJsonLooseObject('```json\n{"a": 1}\n``` done')).toEqual({ a: 1 });
    expect(parseJsonLooseArray('Here you go: [1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it("extracts an object from nested prose", () => {
    expect(parseJsonLooseObject('the answer is {"status":"PENDING","historyId":"h1"} trust me')).toEqual({
      status: "PENDING",
      historyId: "h1",
    });
  });

  it("returns null when nothing parseable is present", () => {
    expect(parseJsonLooseObject("no json here")).toBeNull();
    expect(parseJsonLooseArray("no json here")).toBeNull();
    expect(parseJsonLooseObject("[1,2,3]")).toBeNull(); // wrong shape for object
    expect(parseJsonLooseArray('{"a":1}')).toBeNull(); // wrong shape for array
  });
});

describe("dataUrlToBytes", () => {
  it("decodes base64 data URLs (including >32KB chunk boundary)", () => {
    const big = "x".repeat(70_000); // forces the chunked atob path
    const dataUrl = `data:text/plain;base64,${Buffer.from(big, "utf8").toString("base64")}`;
    const bytes = dataUrlToBytes(dataUrl);
    expect(bytes).not.toBeNull();
    expect(Buffer.from(bytes!).toString("utf8")).toBe(big);
  });

  it("returns null for non-data URLs and non-base64 data URLs", () => {
    expect(dataUrlToBytes("https://example.com/a.png")).toBeNull();
    expect(dataUrlToBytes("data:text/plain,hello")).toBeNull();
    expect(dataUrlToBytes("garbage")).toBeNull();
  });
});

describe("image / video URL regexes", () => {
  it("matches raster image URLs", () => {
    expect("see https://cdn.example.com/x.png?w=2 now".match(IMAGE_URL_RX)).toEqual(["https://cdn.example.com/x.png?w=2"]);
    expect("https://example.com/frame.JPEG".match(IMAGE_URL_RX)).toBeTruthy();
    expect("https://example.com/clip.mp4".match(IMAGE_URL_RX)).toBeNull();
  });

  it("matches video URLs", () => {
    expect("https://example.com/clip.webm".match(VIDEO_URL_RX)).toBeTruthy();
    expect("https://example.com/frame.png".match(VIDEO_URL_RX)).toBeNull();
  });
});