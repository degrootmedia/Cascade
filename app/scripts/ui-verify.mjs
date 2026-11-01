/**
 * UI verification kit: launch the BUILT app with an isolated profile, drive it
 * with Playwright over CDP, take screenshots, and fail on renderer errors.
 *
 *   npm run build            (first; this script runs out/main)
 *   npm run ui:verify [-- --views Chat,"Production Assistant" --out ../tasks/screenshots --wait 1500]
 *
 * Output: <out>/<timestamp>/<view>.png plus report.json. Exit 1 if any
 * [renderer:error], page error, or main-process crash was logged.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const electronPath = require("electron");
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const arg = (f, d) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};
const views = arg("--views", "Chat,Production Assistant").split(",").map((s) => s.trim());
const waitMs = Number(arg("--wait", "1500"));
const port = Number(arg("--port", "9333"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve(appDir, arg("--out", "../tasks/screenshots"), stamp);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-ui-"));
fs.mkdirSync(outDir, { recursive: true });

if (!fs.existsSync(path.join(appDir, "out", "main", "index.js"))) {
  console.error("No build found: run `npm run build` in app/ first.");
  process.exit(2);
}

// ELECTRON_RUN_AS_NODE (set by some shells/IDEs) makes Electron run as plain Node.
const env = { ...process.env, CASCADE_USER_DATA: userData, CASCADE_DEBUG_PORT: String(port) };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, ["."], {
  cwd: appDir,
  env,
  stdio: "ignore",
});

const problems = [];
const shots = [];
let browser;
try {
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!browser) throw new Error("Could not attach to the app over CDP");
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
    if (!page) await new Promise((r) => setTimeout(r, 250));
  }
  if (!page) throw new Error("App window not found");
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && problems.push(`console.error: ${m.text()}`));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(waitMs);
  // A fresh profile has no API key, so Settings opens on its own: capture it, then dismiss.
  if (await page.locator(".modal-backdrop").count()) {
    const first = path.join(outDir, "first-run-modal.png");
    await page.screenshot({ path: first });
    shots.push(first);
    // The app re-opens Settings whenever there is no API key (and a test profile never has one),
    // so closing it is futile. Hide it for navigation only; the screenshot above shows the real state.
    await page.addStyleTag({ content: ".modal-backdrop{display:none !important}" });
  }
  if (process.argv.includes("--inject-error")) {
    // Self-test of the log pipeline: a deliberate renderer error must land in main.log.
    await page.evaluate(() => {
      console.error("UI-VERIFY-DELIBERATE-ERROR");
    });
    await page.waitForTimeout(500);
  }
  for (const v of views) {
    const tab = page.getByRole("tab", { name: v });
    if (await tab.count()) await tab.first().click({ timeout: 5000 });
    else problems.push(`view tab not found: ${v}`);
    await page.waitForTimeout(waitMs);
    const file = path.join(outDir, `${v.replace(/\W+/g, "-").toLowerCase()}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  }
} catch (e) {
  problems.push(`harness: ${e.message}`);
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
}

for (const f of ["main.log", "crash.log"]) {
  const p = path.join(userData, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (/\[renderer:error\]|uncaughtException|unhandledRejection|ERROR /.test(line)) problems.push(`${f}: ${line}`);
  }
}
try { fs.copyFileSync(path.join(userData, "main.log"), path.join(outDir, "main.log")); } catch { /* none */ }
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ shots, problems }, null, 2));
console.log(`Screenshots:\n${shots.map((s) => "  " + s).join("\n")}`);
console.log(problems.length ? `PROBLEMS (${problems.length}):\n${problems.map((p) => "  " + p).join("\n")}` : "No renderer/main errors logged.");
process.exit(problems.length ? 1 : 0);
