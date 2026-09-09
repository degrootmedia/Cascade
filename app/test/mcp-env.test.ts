import { describe, it, expect } from "vitest";
import { buildMcpEnv } from "../src/main/mcp.js";

describe("buildMcpEnv", () => {
  const parent = {
    PATH: "/usr/bin",
    SECRET_API_KEY: "shh",
    AWS_SECRET_ACCESS_KEY: "shh",
    SSH_AUTH_SOCK: "/tmp/sock",
    GITHUB_TOKEN: "tok",
    Path: "C:\\Windows",
  } as NodeJS.ProcessEnv;

  it("passes allowlisted vars and drops secrets", () => {
    const env = buildMcpEnv(parent, {});
    expect(env.PATH).toBe("/usr/bin");
    expect("SECRET_API_KEY" in env).toBe(false);
    expect("AWS_SECRET_ACCESS_KEY" in env).toBe(false);
    expect("SSH_AUTH_SOCK" in env).toBe(false);
  });

  it("passes explicit passthrough names only", () => {
    const env = buildMcpEnv(parent, { envPassthrough: ["GITHUB_TOKEN"] });
    expect(env.GITHUB_TOKEN).toBe("tok");
    expect("SECRET_API_KEY" in env).toBe(false);
  });

  it("lets operator-declared server.env win", () => {
    const env = buildMcpEnv(parent, { env: { PATH: "/custom", FOO: "bar" } });
    expect(env.PATH).toBe("/custom");
    expect(env.FOO).toBe("bar");
  });

  it("matches Windows names case-insensitively", () => {
    const env = buildMcpEnv({ path: "lower" } as unknown as NodeJS.ProcessEnv, {});
    expect(env.path).toBe("lower");
  });
});
