/**
 * Live integration check for McpManager (not a unit test — spawns a real
 * MCP server). Run: npx tsx test-mcp-live.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpManager } from "./src/main/mcp.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-mcp-"));
const configPath = path.join(dir, "mcp.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    mcpServers: {
      everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
      broken: { command: "definitely-not-a-real-binary" },
      off: { command: "whatever", disabled: true },
    },
  })
);

async function main() {
  const mgr = new McpManager(configPath);
  const statuses = await mgr.reload();
  console.log("statuses:", JSON.stringify(statuses, null, 2));

  const tools = mgr.getTools();
  const names = Object.keys(tools);
  console.log(`tools (${names.length}):`, names.join(", "));

  const echo = tools["everything__echo"];
  if (!echo) throw new Error("expected everything__echo tool");
  console.log("definition ok:", echo.definition.function.name, "| approval:", echo.requiresApproval);

  const out = await echo.run({ message: "cascade mcp works" }, dir);
  const text = typeof out === "string" ? out : out.text;
  console.log("echo result:", text);
  if (!text.includes("cascade mcp works")) throw new Error("echo round-trip failed");

  await mgr.shutdown();
  console.log("\nALL MCP CHECKS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
