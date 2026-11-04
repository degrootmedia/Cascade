/**
 * Dissolve repro: red clip -> 2s dissolve -> blue clip (handles 1s).
 * Parks mid-transition in the preview and samples the monitor centre
 * colour; renders and samples frames across the transition.
 *   node repro-dissolve.mjs [--port 9371]
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("../../app/node_modules/playwright-core");
const electronPath = require("../../app/node_modules/electron");
const ffmpegPath = require("../../app/node_modules/ffmpeg-static");

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "../../app");
const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : "9371");
const userData = path.join(here, "userdata-dissolve");
const prodFolder = path.join(here, "seed-dissolve");
const outDir = path.join(here, "shots");
fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(userData, { recursive: true, force: true });
for (const d of ["boards", "videos", "voiceover", "music", "out", "references", "assembly"]) {
  fs.mkdirSync(path.join(prodFolder, d), { recursive: true });
}
fs.copyFileSync(path.join(here, "media", "red6s.mp4"), path.join(prodFolder, "videos", "red6s.mp4"));
fs.copyFileSync(path.join(here, "media", "blue6s.mp4"), path.join(prodFolder, "videos", "blue6s.mp4"));

const PROD_ID = "dissolverepro1";
const now = new Date().toISOString();
const production = {
  meta: { id: PROD_ID, name: "Dissolve Repro", folder: prodFolder, createdAt: now, updatedAt: now, stepDone: 4, shotCount: 2 },
  currentStep: 4,
  visualStyle: "",
  styles: [],
  scenes: [{
    number: 1, title: "Scene",
    shots: [
      { id: "shot1", number: "0100", audio: "", visual: "red", durationSec: 4, videoPath: "videos/red6s.mp4" },
      { id: "shot2", number: "0200", audio: "", visual: "blue", durationSec: 4, videoPath: "videos/blue6s.mp4" },
    ],
  }],
  characters: [],
  products: [],
  references: [],
  status: {},
  timeline: {
    version: 1,
    tracks: [{ id: "v1", kind: "video", name: "V1" }],
    clips: [
      { id: "c1", trackId: "v1", sourceKind: "video", srcRel: "videos/red6s.mp4", sourceInSec: 1, sourceOutSec: 5, timelineStartSec: 0, name: "red6s.mp4", shotId: "shot1" },
      { id: "c2", trackId: "v1", sourceKind: "video", srcRel: "videos/blue6s.mp4", sourceInSec: 1, sourceOutSec: 5, timelineStartSec: 4, name: "blue6s.mp4", shotId: "shot2" },
    ],
    transitions: [{ id: "tr1", type: "dissolve", outgoingClipId: "c1", incomingClipId: "c2", durationSec: 2 }],
  },
  assembly: { fps: 24, width: 640, height: 360, exportDir: "out/assembly" },
  assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
};
fs.mkdirSync(path.join(userData, "productions"), { recursive: true });
fs.writeFileSync(path.join(userData, "productions", `${PROD_ID}.json`), JSON.stringify(production, null, 2));

/** Average RGB of a png region via ffmpeg crop+scale to 1x1 raw rgb24. */
function avgColor(png, x, y, w = 40, h = 40) {
  const buf = execFileSync(ffmpegPath, ["-y", "-i", png, "-vf", `crop=${w}:${h}:${x}:${y},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 20, stdio: ["ignore", "pipe", "ignore"] });
  return { r: buf[0], g: buf[1], b: buf[2] };
}
function frameColor(mp4, t) {
  const png = path.join(outDir, `frame-${t}.png`);
  execFileSync(ffmpegPath, ["-y", "-ss", String(t), "-i", mp4, "-frames:v", "1", png], { stdio: "ignore" });
  return avgColor(png, 300, 160, 40, 40);
}

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
  await page.waitForTimeout(1800);

  const savedTr = await page.evaluate(() => document.querySelector(".prod-animatic-time")?.textContent);
  console.log("transport:", savedTr);

  // Park at mid-transition (edit at 4.0, window 3..5): click ruler.
  const lanes = await page.locator(".prod-tl-lanes").boundingBox();
  const pps = await page.evaluate(() => Number(document.querySelector('[data-testid="timeline-editor"]')?.dataset.pps || 0));
  await page.locator(".prod-tl-lanes").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const lanes2 = await page.locator(".prod-tl-lanes").boundingBox();
  await page.mouse.click(lanes2.x + 4.0 * pps, lanes2.y + 6);
  await page.waitForTimeout(1500);
  const shotMid = path.join(outDir, "preview-mid.png");
  await page.screenshot({ path: shotMid });
  // Monitor centre approx: preview area centre of the window.
  const mon = await page.locator(".prod-animatic-preview").boundingBox();
  const mid = avgColor(shotMid, Math.round(mon.x + mon.width / 2 - 20), Math.round(mon.y + mon.height / 2 - 20));
  console.log(`PREVIEW mid-transition colour: rgb(${mid.r},${mid.g},${mid.b}) (expect purple ~128,0,128; black dip = near 0,0,0)`);
  const blendInfo = await page.evaluate(() => {
    const under = document.querySelector(".blend-under");
    const vids = [...document.querySelectorAll("video")].map((v) => ({ cls: v.className, op: v.style.opacity, t: v.currentTime, rs: v.readyState, paused: v.paused }));
    return { hasUnder: !!under, vids };
  });
  console.log("blend DOM:", JSON.stringify(blendInfo));

  // Render.
  await page.locator('.prod-step:has(.prod-step-title:text-is("Assembly"))').first().click();
  await page.waitForTimeout(1200);
  const renderFile = path.join(prodFolder, "out", "assembly", "render.mp4");
  try { fs.rmSync(renderFile); } catch {}
  await page.getByRole("button", { name: "Build package" }).click();
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Render MP4" }).click();
  let rendered = false;
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(1500);
    if (fs.existsSync(renderFile) && fs.statSync(renderFile).size > 5000) {
      const s1 = fs.statSync(renderFile).size;
      await page.waitForTimeout(1000);
      if (fs.statSync(renderFile).size === s1) { rendered = true; break; }
    }
  }
  console.log("rendered:", rendered);
  if (rendered) {
    for (const t of [2.5, 3.5, 4.0, 4.5, 5.5]) {
      const c = frameColor(renderFile, t);
      console.log(`RENDER t=${t}: rgb(${c.r},${c.g},${c.b})`);
    }
  }
} catch (e) {
  console.log(`HARNESS ERROR: ${e.message}`);
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
}
