/**
 * Ramp repro B: NO stored timeline (seeded from shots on open, like a
 * real project), TWO back-to-back 8s video clips. On clip 1: Add ramp,
 * drag the END dot up (100% -> ~200% scenario), then drag the MIDDLE
 * dot DOWN (slow). Reports saved JSON + rendered widths throughout.
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
const port = 9352;
const userData = path.join(here, "userdata-repro2");
const prodFolder = path.join(here, "seed-prod2");
fs.rmSync(userData, { recursive: true, force: true });
for (const d of ["boards", "videos", "voiceover", "music", "out", "references", "assembly"]) {
  fs.mkdirSync(path.join(prodFolder, d), { recursive: true });
}
fs.copyFileSync(path.join(here, "media", "clip8s.mp4"), path.join(prodFolder, "videos", "clip8s.mp4"));

const PROD_ID = "rampreproseed2";
const now = new Date().toISOString();
const production = {
  meta: { id: PROD_ID, name: "Ramp Repro 2", folder: prodFolder, createdAt: now, updatedAt: now, stepDone: 4, shotCount: 2 },
  currentStep: 4,
  visualStyle: "",
  styles: [],
  scenes: [{
    number: 1, title: "Scene",
    shots: [
      { id: "shot1", number: "0100", audio: "", visual: "one", durationSec: 8, videoPath: "videos/clip8s.mp4" },
      { id: "shot2", number: "0200", audio: "", visual: "two", durationSec: 8, videoPath: "videos/clip8s.mp4" },
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
      { id: "c1", trackId: "v1", sourceKind: "video", srcRel: "videos/clip8s.mp4", sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 0, name: "clip8s.mp4", shotId: "shot1" },
      { id: "c2", trackId: "v1", sourceKind: "video", srcRel: "videos/clip8s.mp4", sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 8, name: "clip8s.mp4", shotId: "shot2" },
    ],
  },
  assembly: { fps: 24, width: 1920, height: 1080, exportDir: "out/assembly" },
  assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
};
fs.mkdirSync(path.join(userData, "productions"), { recursive: true });
const prodFile = path.join(userData, "productions", `${PROD_ID}.json`);
fs.writeFileSync(prodFile, JSON.stringify(production, null, 2));
const readSaved = () => {
  try {
    const p = JSON.parse(fs.readFileSync(prodFile, "utf8"));
    return (p.timeline?.clips ?? []).map((c) => ({ id: c.id.slice(0, 12), kind: c.sourceKind, speed: c.speed, curve: c.speedCurve?.map((k) => `${k.atSec}@${k.speed.toFixed(2)}`), start: c.timelineStartSec, in: c.sourceInSec, out: c.sourceOutSec }));
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
  await page.waitForTimeout(1800);
  await page.locator(".prod-tl-lanes").scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  const clipsInfo = () => page.evaluate(() =>
    [...document.querySelectorAll("[data-clip-id]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute("data-clip-id")?.slice(0, 12), w: Math.round(r.width), label: el.textContent?.trim().slice(0, 60), dots: el.querySelectorAll(".prod-tl-ramp-dot").length };
    }));
  console.log("seeded saved:", JSON.stringify(readSaved()));
  console.log("clips:", JSON.stringify(await clipsInfo()));

  const firstClip = page.locator("[data-clip-id]").first();
  const box = await firstClip.boundingBox();
  await page.mouse.click(box.x + 30, box.y + box.height / 2);
  await page.waitForTimeout(300);
  await page.getByLabel("Add ramp", { exact: true }).click();
  await page.waitForTimeout(700);
  console.log("after Add ramp saved:", JSON.stringify(readSaved()));
  console.log("clips:", JSON.stringify(await clipsInfo()));

  const dragDot = async (idx, dyFrac) => {
    const dot = await page.evaluate((i) => {
      const d = document.querySelectorAll(".prod-tl-ramp-dot")[i];
      if (!d) return null;
      const r = d.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, idx);
    if (!dot) { console.log(`dot ${idx}: NOT FOUND`); return; }
    const cb = await page.locator("[data-clip-id]").first().boundingBox();
    const targetY = cb.y + cb.height * dyFrac;
    await page.mouse.move(dot.x, dot.y);
    await page.mouse.down();
    await page.mouse.move(dot.x, targetY, { steps: 10 });
    await page.waitForTimeout(200);
    console.log(`  mid-drag dot${idx}:`, JSON.stringify(await clipsInfo()));
    await page.mouse.up();
    await page.waitForTimeout(800);
  };

  console.log("-- drag MIDDLE dot up (fast) --");
  await dragDot(1, 0.1);
  console.log("saved:", JSON.stringify(readSaved()));
  console.log("clips:", JSON.stringify(await clipsInfo()));

  console.log("-- drag END dot up (to ~200%) --");
  await dragDot(2, 0.28);
  console.log("saved:", JSON.stringify(readSaved()));
  console.log("clips:", JSON.stringify(await clipsInfo()));

  console.log("-- drag MIDDLE dot down (slow) --");
  await dragDot(1, 0.85);
  console.log("saved:", JSON.stringify(readSaved()));
  console.log("clips:", JSON.stringify(await clipsInfo()));
  await page.screenshot({ path: path.join(here, "repro-ramp2.png") });
} catch (e) {
  console.log(`HARNESS ERROR: ${e.message}`);
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
}
