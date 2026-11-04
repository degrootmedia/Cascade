/**
 * Ramp repro: seed a production whose timeline has one 8s video clip,
 * open Step 4 in the BUILT app, select the clip, Add ramp, drag the
 * middle keyframe up (faster), and report the persisted JSON + the
 * clip's rendered width/label at each step.
 *   node repro-ramp.mjs [--port 9351]
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("../../app/node_modules/playwright-core");
const electronPath = require("../../app/node_modules/electron");

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "../../app");
const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : "9351");
const userData = path.join(here, "userdata-repro");
const prodFolder = path.join(here, "seed-prod");
fs.rmSync(userData, { recursive: true, force: true });
for (const d of ["boards", "videos", "voiceover", "music", "out", "references", "assembly"]) {
  fs.mkdirSync(path.join(prodFolder, d), { recursive: true });
}
fs.copyFileSync(path.join(here, "media", "clip8s.mp4"), path.join(prodFolder, "videos", "clip8s.mp4"));
fs.copyFileSync(path.join(here, "media", "tone6s.mp3"), path.join(prodFolder, "voiceover", "tone6s.mp3"));

const PROD_ID = "rampreproseed1";
const now = new Date().toISOString();
const production = {
  meta: { id: PROD_ID, name: "Ramp Repro", folder: prodFolder, createdAt: now, updatedAt: now, stepDone: 4, shotCount: 1 },
  currentStep: 4,
  visualStyle: "",
  styles: [],
  scenes: [{
    number: 1, title: "Scene",
    shots: [{ id: "shot1", number: "0100", audio: "", visual: "test pattern", durationSec: 8, videoPath: "videos/clip8s.mp4" }],
  }],
  characters: [],
  products: [],
  references: [],
  status: {},
  timeline: {
    version: 1,
    tracks: [{ id: "v1", kind: "video", name: "V1" }, { id: "a1", kind: "audio", name: "A1" }],
    clips: [
      { id: "c1", trackId: "v1", sourceKind: "video", srcRel: "videos/clip8s.mp4", sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 0, name: "clip8s.mp4", shotId: "shot1" },
    ],
  },
  voiceoverPath: "voiceover/tone6s.mp3",
  voiceoverVolume: 0.9,
  assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
  assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
};
fs.mkdirSync(path.join(userData, "productions"), { recursive: true });
const prodFile = path.join(userData, "productions", `${PROD_ID}.json`);
fs.writeFileSync(prodFile, JSON.stringify(production, null, 2));
const readSaved = () => {
  try {
    const p = JSON.parse(fs.readFileSync(prodFile, "utf8"));
    return p.timeline?.clips?.map((c) => ({ id: c.id, kind: c.sourceKind, speed: c.speed, speedCurve: c.speedCurve, start: c.timelineStartSec, in: c.sourceInSec, out: c.sourceOutSec, role: c.role }));
  } catch (e) { return `read error: ${e.message}`; }
};

const env = { ...process.env, CASCADE_USER_DATA: userData, CASCADE_DEBUG_PORT: String(port) };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, ["."], { cwd: appDir, env, stdio: "ignore" });
let browser;
try {
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
    if (!page) await new Promise((r) => setTimeout(r, 250));
  }
  page.on("pageerror", (e) => console.log(`PAGEERROR: ${e.message}`));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1800);
  if (await page.locator(".modal-backdrop").count()) {
    await page.addStyleTag({ content: ".modal-backdrop{display:none !important}" });
  }
  await page.setViewportSize({ width: 1500, height: 950 });
  const paTab = page.getByRole("tab", { name: "Production Assistant" });
  if (await paTab.count()) await paTab.first().click({ timeout: 5000 });
  await page.waitForTimeout(1000);
  await page.locator(".prod-card-open").first().click();
  await page.waitForTimeout(2000);
  await page.locator('.prod-step:has(.prod-step-title:text-is("Animatic"))').first().click();
  await page.waitForTimeout(1500);
  await page.locator(".prod-tl-lanes").scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  const clipInfo = () => page.evaluate(() => {
    const el = document.querySelector('[data-clip-id="c1"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { width: Math.round(r.width), label: el.textContent?.trim().slice(0, 80), dots: document.querySelectorAll(".prod-tl-ramp-dot").length };
  });
  console.log("initial saved:", JSON.stringify(readSaved()));
  console.log("initial clip:", JSON.stringify(await clipInfo()));

  // Select the clip (click its body, low-risk spot near start).
  const box = await page.locator('[data-clip-id="c1"]').boundingBox();
  await page.mouse.click(box.x + 30, box.y + box.height / 2);
  await page.waitForTimeout(300);

  // Add ramp.
  await page.getByLabel("Add ramp", { exact: true }).click();
  await page.waitForTimeout(600);
  console.log("after Add ramp saved:", JSON.stringify(readSaved()));
  console.log("after Add ramp clip:", JSON.stringify(await clipInfo()));

  // Drag the middle dot up (faster) by ~60% of clip height.
  const dot = await page.evaluate(() => {
    const d = document.querySelectorAll(".prod-tl-ramp-dot")[1];
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  console.log("middle dot at:", JSON.stringify(dot));
  if (dot) {
    const clipBox = await page.locator('[data-clip-id="c1"]').boundingBox();
    await page.mouse.move(dot.x, dot.y);
    await page.mouse.down();
    await page.mouse.move(dot.x, clipBox.y + 6, { steps: 8 });
    await page.waitForTimeout(200);
    console.log("mid-drag clip:", JSON.stringify(await clipInfo()));
    await page.mouse.up();
    await page.waitForTimeout(800);
  }
  console.log("after drag saved:", JSON.stringify(readSaved()));
  console.log("after drag clip:", JSON.stringify(await clipInfo()));
  await page.screenshot({ path: path.join(here, "repro-ramp.png") });
} catch (e) {
  console.log(`HARNESS ERROR: ${e.message}`);
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
}
