/**
 * Dissolve during PLAYBACK: samples the monitor colour every ~250ms
 * across the transition (3..5s) to detect a dip to black.
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
const port = 9374;
const userData = path.join(here, "userdata-dissolve");
const outDir = path.join(here, "shots");

function avgColor(png, x, y, w = 40, h = 40) {
  const buf = execFileSync(ffmpegPath, ["-y", "-i", png, "-vf", `crop=${w}:${h}:${x}:${y},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 20, stdio: ["ignore", "pipe", "ignore"] });
  return { r: buf[0], g: buf[1], b: buf[2] };
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
  await page.waitForTimeout(1200);
  // Production may auto-reopen; otherwise click the card.
  if (await page.locator(".prod-card-open").count()) {
    await page.locator(".prod-card-open").first().click();
    await page.waitForTimeout(2000);
  }
  const step = page.locator('.prod-step:has(.prod-step-title:text-is("Animatic"))').first();
  if (await step.count()) await step.click();
  await page.waitForTimeout(1800);

  const mon = await page.locator(".prod-animatic-preview").boundingBox();
  const cx = Math.round(mon.x + mon.width / 2 - 20);
  const cy = Math.round(mon.y + mon.height / 2 - 20);
  // Seek to 2.5s via ruler, then play.
  await page.locator(".prod-tl-lanes").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const lanes = await page.locator(".prod-tl-lanes").boundingBox();
  const pps = await page.evaluate(() => Number(document.querySelector('[data-testid="timeline-editor"]')?.dataset.pps || 0));
  await page.mouse.click(lanes.x + 2.5 * pps, lanes.y + 6);
  await page.waitForTimeout(600);
  await page.locator(".prod-animatic-preview").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const mon2 = await page.locator(".prod-animatic-preview").boundingBox();
  const cx2 = Math.round(mon2.x + mon2.width / 2 - 20);
  const cy2 = Math.round(mon2.y + mon2.height / 2 - 20);
  await page.locator('.prod-animatic-transport button[title^="Play"]').click();
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(250);
    const f = path.join(outDir, `play-${i}.png`);
    await page.screenshot({ path: f });
    const time = await page.evaluate(() => document.querySelector(".prod-animatic-time")?.textContent);
    const c = avgColor(f, cx2, cy2);
    const under = await page.evaluate(() => {
      const u = document.querySelector(".blend-under");
      return u ? { t: u.currentTime, rs: u.readyState, paused: u.paused } : null;
    });
    console.log(`sample ${i} ${time} rgb(${c.r},${c.g},${c.b}) under=${JSON.stringify(under)}`);
  }
} catch (e) {
  console.log(`HARNESS ERROR: ${e.message}`);
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
}
