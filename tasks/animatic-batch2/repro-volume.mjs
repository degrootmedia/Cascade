/**
 * Item 2 repro: does the track volume slider change anything?
 * Seeds video + audio (tone) tracks; drags the slider with the mouse,
 * then with the keyboard; checks saved track.volume and the live
 * <audio> element volume during playback.
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
const port = 9375;
const userData = path.join(here, "userdata-volume");
fs.rmSync(userData, { recursive: true, force: true });
const prodId = "volrepro000001";
const prodFolder = path.join(here, "seed-volume");
const prodDir = path.join(userData, "productions");
for (const d of ["boards", "videos", "audio", "voiceover", "music", "out", "references", "assembly"]) {
  fs.mkdirSync(path.join(prodFolder, d), { recursive: true });
}
fs.mkdirSync(prodDir, { recursive: true });
fs.copyFileSync(path.join(here, "media", "red6s.mp4"), path.join(prodFolder, "videos", "red6s.mp4"));
fs.copyFileSync(path.join(here, "media", "tone8s.mp3"), path.join(prodFolder, "audio", "tone8s.mp3"));
const now = new Date().toISOString();
const production = {
  meta: { id: prodId, name: "Volume repro", folder: prodFolder, createdAt: now, updatedAt: now, stepDone: 4, shotCount: 1 },
  currentStep: 4,
  visualStyle: "",
  styles: [],
  scenes: [{
    number: 1, title: "Scene",
    shots: [{ id: "shot1", number: "0100", audio: "", visual: "red", durationSec: 6, videoPath: "videos/red6s.mp4" }],
  }],
  characters: [],
  products: [],
  references: [],
  status: {},
  assembly: { fps: 24, width: 640, height: 360, exportDir: "out/assembly" },
  assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
  timeline: {
    version: 1,
    tracks: [{ id: "v1", kind: "video", name: "V1" }, { id: "a1", kind: "audio", name: "A1" }],
    clips: [
      { id: "c1", trackId: "v1", sourceKind: "video", timelineStartSec: 0, sourceInSec: 0, sourceOutSec: 6, srcRel: "videos/red6s.mp4", name: "red6s.mp4", shotId: "shot1" },
      { id: "ac1", trackId: "a1", sourceKind: "audio", timelineStartSec: 0, sourceInSec: 0, sourceOutSec: 8, srcRel: "audio/tone8s.mp3", name: "tone8s.mp3" },
    ],
  },
};
const savePath = path.join(prodDir, `${prodId}.json`);
fs.writeFileSync(savePath, JSON.stringify(production, null, 1));
const savedVolume = () => {
  const p = JSON.parse(fs.readFileSync(savePath, "utf8"));
  return p.timeline?.tracks?.find((t) => t.id === "a1")?.volume;
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
  await page.waitForTimeout(1500);
  if (await page.locator(".modal-backdrop").count()) {
    await page.addStyleTag({ content: ".modal-backdrop{display:none !important}" });
  }
  await page.setViewportSize({ width: 1500, height: 950 });
  const paTab = page.getByRole("tab", { name: "Production Assistant" });
  if (await paTab.count()) await paTab.first().click({ timeout: 5000 });
  await page.waitForTimeout(1200);
  if (await page.locator(".prod-card-open").count()) {
    await page.locator(".prod-card-open").first().click();
    await page.waitForTimeout(2000);
  } else {
    console.log("no card; body starts:", (await page.locator("body").innerText()).slice(0, 300).replace(/\n/g, " | "));
  }
  const step = page.locator('.prod-step:has(.prod-step-title:text-is("Animatic"))').first();
  if (await step.count()) await step.click();
  await page.waitForTimeout(1800);

  const slider = page.locator(".prod-tl-track-vol").first();
  await slider.scrollIntoViewIfNeeded();
  const box = await slider.boundingBox();
  console.log(`slider box ${JSON.stringify(box)} value=${await slider.inputValue()}`);

  // Mouse drag: from thumb (right end at 100%) to 30%.
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 8 });
  console.log(`during drag: input=${await slider.inputValue()} savedVolume=${savedVolume()}`);
  await page.mouse.up();
  await page.waitForTimeout(900);
  console.log(`after mouse: input=${await slider.inputValue()} savedVolume=${savedVolume()}`);

  // Playback element volume.
  await page.locator(".prod-animatic-preview").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.locator('.prod-animatic-transport button[title^="Play"]').click();
  await page.waitForTimeout(1200);
  const during = await page.evaluate(() => {
    const els = [...document.querySelectorAll("audio")];
    return els.map((el) => ({ vol: el.volume, paused: el.paused, src: el.src.split("/").pop() }));
  });
  console.log(`audio elements during play: ${JSON.stringify(during)}`);
  await page.locator('.prod-animatic-transport button[title^="Pause"], .prod-animatic-transport button[title*="Stop"]').first().click().catch(() => {});

  // Keyboard: focus slider, Home then 5x ArrowRight (=5%), no blur.
  await slider.scrollIntoViewIfNeeded();
  await slider.focus();
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(600);
  console.log(`after keys (no blur): input=${await slider.inputValue()} savedVolume=${savedVolume()}`);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(900);
  console.log(`after blur: input=${await slider.inputValue()} savedVolume=${savedVolume()}`);
} catch (e) {
  console.log(`HARNESS ERROR: ${e.message}`);
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
}
