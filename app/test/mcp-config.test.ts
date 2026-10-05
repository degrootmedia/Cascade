/**
 * MCP config grammar: the pure parse/serialize/edit/validate helpers behind the
 * Settings MCP editor. The friendly form, the raw-JSON escape hatch, and main's
 * `mcp:setConfig` all round-trip through these, so the shape is pinned here.
 */
import { describe, it, expect } from "vitest";
import {
  argsToLines,
  blankMcpServer,
  cleanMcpServer,
  emptyMcpConfig,
  envToText,
  linesToArgs,
  mcpServerEntries,
  mcpTransport,
  namesToText,
  parseMcpConfigText,
  removeMcpServer,
  serializeMcpConfig,
  textToEnv,
  textToNames,
  upsertMcpServer,
  validateMcpServer,
  type McpConfigFile,
} from "../src/shared/mcp-config.js";

describe("parseMcpConfigText", () => {
  it("parses a full document and keeps unknown fields", () => {
    const result = parseMcpConfigText(
      JSON.stringify({
        mcpServers: {
          fs: { command: "npx", args: ["-y", "server"], env: { TOKEN: "x" }, envPassthrough: ["HOME"], disabled: true, custom: 1 },
          remote: { url: "https://example.com/mcp" },
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.file.mcpServers)).toEqual(["fs", "remote"]);
    expect((result.file.mcpServers.fs as unknown as Record<string, unknown>).custom).toBe(1);
    expect(result.file.mcpServers.remote.url).toBe("https://example.com/mcp");
  });

  it("treats empty text and a missing mcpServers as an empty config", () => {
    expect(parseMcpConfigText("")).toEqual({ ok: true, file: { mcpServers: {} } });
    expect(parseMcpConfigText("null")).toEqual({ ok: true, file: { mcpServers: {} } });
    expect(parseMcpConfigText("{}")).toEqual({ ok: true, file: { mcpServers: {} } });
  });

  it("reports invalid JSON and a malformed mcpServers with a readable error", () => {
    const badJson = parseMcpConfigText("{ not json");
    expect(badJson.ok).toBe(false);
    const arrayServers = parseMcpConfigText('{"mcpServers": []}');
    expect(arrayServers.ok).toBe(false);
    const scalar = parseMcpConfigText('"hello"');
    expect(scalar.ok).toBe(false);
    const nonObjectServer = parseMcpConfigText('{"mcpServers": {"fs": "nope"}}');
    expect(nonObjectServer.ok).toBe(false);
    if (!badJson.ok) expect(badJson.error).toMatch(/valid JSON/i);
    if (!arrayServers.ok) expect(arrayServers.error).toMatch(/mcpServers/);
    if (!nonObjectServer.ok) expect(nonObjectServer.error).toMatch(/must be an object/i);
  });
});

describe("serializeMcpConfig", () => {
  it("emits a pretty mcpServers document that round-trips", () => {
    const file: McpConfigFile = {
      mcpServers: { fs: { command: "npx", args: ["-y", "server"] }, remote: { url: "https://x.test/mcp" } },
    };
    const text = serializeMcpConfig(file);
    expect(text.includes('\n  "mcpServers"')).toBe(true);
    const back = parseMcpConfigText(text);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.file).toEqual(file);
  });

  it("writes an empty document for no servers", () => {
    expect(serializeMcpConfig(emptyMcpConfig())).toBe('{\n  "mcpServers": {}\n}');
  });
});

describe("mcpTransport", () => {
  it("is http when a url is present, else stdio", () => {
    expect(mcpTransport({ url: "https://x.test/mcp" })).toBe("http");
    expect(mcpTransport({ command: "npx" })).toBe("stdio");
    expect(mcpTransport({ command: "", url: "  " })).toBe("stdio");
  });

  it("blankMcpServer seeds the chosen transport", () => {
    expect(blankMcpServer("http")).toEqual({ url: "" });
    expect(blankMcpServer("stdio")).toEqual({ command: "" });
  });
});

describe("upsertMcpServer / removeMcpServer", () => {
  const base: McpConfigFile = {
    mcpServers: { a: { command: "a" }, b: { command: "b" }, c: { command: "c" } },
  };

  it("appends a new server and keeps insertion order", () => {
    const next = upsertMcpServer(base, "d", { command: "d" });
    expect(Object.keys(next.mcpServers)).toEqual(["a", "b", "c", "d"]);
  });

  it("replaces a server in place without reordering", () => {
    const next = upsertMcpServer(base, "b", { command: "b2" });
    expect(Object.keys(next.mcpServers)).toEqual(["a", "b", "c"]);
    expect(next.mcpServers.b.command).toBe("b2");
  });

  it("renames a server in place and drops the old key", () => {
    const next = upsertMcpServer(base, "bee", { command: "b" }, "b");
    expect(Object.keys(next.mcpServers)).toEqual(["a", "bee", "c"]);
    expect(next.mcpServers.b).toBeUndefined();
  });

  it("does not mutate the input", () => {
    upsertMcpServer(base, "a", { command: "changed" });
    expect(base.mcpServers.a.command).toBe("a");
  });

  it("removes by name", () => {
    expect(Object.keys(removeMcpServer(base, "b").mcpServers)).toEqual(["a", "c"]);
  });
});

describe("validateMcpServer", () => {
  it("requires a name and rejects duplicates", () => {
    expect(validateMcpServer("", { command: "x" })).toMatch(/name/i);
    expect(validateMcpServer("dup", { command: "x" }, ["dup"])).toMatch(/already exists/i);
  });

  it("requires a command for stdio and a valid URL for http", () => {
    expect(validateMcpServer("s", { command: "  " })).toMatch(/command/i);
    // An empty URL is still an HTTP server while the form is on that transport.
    expect(validateMcpServer("s", { url: "" }, [], "http")).toMatch(/URL/i);
    expect(validateMcpServer("s", { url: "example.com/mcp" }, [], "http")).toMatch(/http/i);
    expect(validateMcpServer("s", { url: "https://example.com/mcp" }, [], "http")).toBeNull();
    expect(validateMcpServer("s", { command: "npx" })).toBeNull();
  });

  it("allows renaming onto the same name when the original is excluded", () => {
    expect(validateMcpServer("mine", { command: "x" }, [])).toBeNull();
  });
});

describe("field text helpers", () => {
  it("round-trips args one-per-line", () => {
    expect(argsToLines(["-y", "server", "C:\\dir"])).toBe("-y\nserver\nC:\\dir");
    expect(linesToArgs("-y\n  server  \n\nC:\\dir")).toEqual(["-y", "server", "C:\\dir"]);
  });

  it("parses env comments, blanks, and the first equals only", () => {
    const env = textToEnv("# comment\nGITHUB_TOKEN=abc=def\n\n  FOO = bar  ");
    expect(env).toEqual({ GITHUB_TOKEN: "abc=def", FOO: "bar" });
    expect(envToText({ A: "1", B: "2" })).toBe("A=1\nB=2");
  });

  it("splits passthrough names on commas and newlines", () => {
    expect(textToNames("HOME, GITHUB_TOKEN\nPATH")).toEqual(["HOME", "GITHUB_TOKEN", "PATH"]);
    expect(namesToText(["HOME", "PATH"])).toBe("HOME\nPATH");
  });
});

describe("cleanMcpServer", () => {
  it("drops blank fields and empty collections", () => {
    expect(cleanMcpServer({ command: "  npx  ", args: ["", " -y "], env: { "": "x", A: "  " }, disabled: false })).toEqual({
      command: "npx",
      args: ["-y"],
      env: { A: "" },
    });
  });

  it("drops the unused transport's fields but preserves unknown keys", () => {
    const cleaned = cleanMcpServer({ command: "npx", url: "https://x.test/mcp", headers: { Authorization: "Bearer x" } } as never);
    expect(cleaned.url).toBe("https://x.test/mcp");
    expect(cleaned.command).toBeUndefined();
    expect((cleaned as unknown as Record<string, unknown>).headers).toEqual({ Authorization: "Bearer x" });
  });
});

describe("mcpServerEntries", () => {
  it("preserves document order", () => {
    const file: McpConfigFile = { mcpServers: { b: { command: "b" }, a: { command: "a" } } };
    expect(mcpServerEntries(file).map((e) => e.name)).toEqual(["b", "a"]);
  });
});
