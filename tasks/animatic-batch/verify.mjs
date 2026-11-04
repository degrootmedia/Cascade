/**
 * Live verification for the animatic batch (Items 1-3) in the BUILT app:
 *  A. Migration: legacy voiceoverPath/musicPath -> audio-track clips,
 *     fields cleared; Step 4 has no VO/Music panels, no wave strip.
 *  B. Ramp: select clip 1, Add ramp, drag END dot to ~200%; duration
 *     shortens (8s -> ~5.33s), curve spans clip; preview playbackRate
 *     rises during playback; Assembly render duration matches.
 *  C. Header panel: volume slider stacked above buttons; drag the
 *     right edge wider; relaunch -> width remembered.
 *   node verify.mjs [--port 9361]
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
const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : "9361");
const userData = path.join(here, "userdata-verify");
const prodFolder = path.join(here, "seed-verify");
const outDir = path.join(here, "verify-shots");
fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(userData, { recursive: true, force: true });
for (const d of ["boards", "videos", "voiceover", "music", "out", "references", "assembly"]) {
  fs.mkdirSync(path.join(prodFolder, d), { recursive: true });
}
fs.copyFileSync(path.join(here, "media", "clip8s.mp4"), path.join(prodFolder, "videos", "clip8s.mp4"));
fs.copyFileSync(path.join(here, "media", "tone6s.mp3"), path.join(prodFolder, "voiceover", "tone6s.mp3"));
fs.copyFileSync(path.join(here, "media", "tone6s.mp3"), path.join(prodFolder, "music", "tone6s.mp3"));

const PROD_ID = "animaticverify1";
const now = new Date().toISOString();
const production = {
  meta: { id: PROD_ID, name: "Animatic Verify", folder: prodFolder, createdAt: now, updatedAt: now, stepDone: 4, shotCount: 2 },
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
  // Legacy fields: must migrate to audio-track clips on load.
  voiceoverPath: "voiceover/tone6s.mp3",
  voiceoverVolume: 0.8,
  musicPath: "music/tone6s.mp3",
  musicVolume: 0.4,
  assembly: { fps: 24, width: 640, height: 360, exportDir: "out/assembly" },
  assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
};
fs.mkdirSync(path.join(userData, "productions"), { recursive: true });
const prodFile = path.join(userData, "productions", `${PROD_ID}.json`);
fs.writeFileSync(prodFile, JSON.stringify(production, null, 2));
const readSaved = () => JSON.parse(fs.readFileSync(prodFile, "utf8"));

const facts = {};
const check = (name, ok, extra = "") => {
  facts[name] = ok ? "PASS" : "FAIL";
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
};

async function launch() {
  const env = { ...process.env, CASCADE_USER_DATA: userData, CASCADE_DEBUG_PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, ["."], { cwd: appDir, env, stdio: "ignore" });
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!browser) throw new Error("no CDP");
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
  return { child, browser, page };
}

async function openAnimatic(page, { viaCard = true } = {}) {
  const paTab = page.getByRole("tab", { name: "Production Assistant" });
  if (await paTab.count()) await paTab.first().click({ timeout: 5000 });
  await page.waitForTimeout(1000);
  if (viaCard && (await page.locator(".prod-card-open").count())) {
    await page.locator(".prod-card-open").first().click();
    await page.waitForTimeout(2000);
  }
  const step = page.locator('.prod-step:has(.prod-step-title:text-is("Animatic"))').first();
  if (await step.count()) await step.click();
  await page.waitForTimeout(1500);
}

let app = await launch();
try {
  const { page } = app;
  await openAnimatic(page);

  // ---- A. migration + panels gone -------------------------------------
  const saved = readSaved();
  check("A1 legacy fields cleared", !saved.voiceoverPath && !saved.musicPath && saved.voiceoverVolume === undefined && saved.musicVolume === undefined);
  const audioClips = (saved.timeline?.clips ?? []).filter((c) => c.sourceKind === "audio");
  check("A2 VO+music landed as audio clips", audioClips.length === 2, JSON.stringify(audioClips.map((c) => c.srcRel)));
  check("A3 volumes carried", Math.abs((audioClips.find((c) => c.srcRel.includes("voiceover"))?.volume ?? 0) - 0.8) < 1e-9);
  const domA = await page.evaluate(() => ({
    panels: document.querySelectorAll(".prod-animatic-panels, .prod-audio").length,
    waveRow: document.querySelectorAll(".prod-animatic-wave-row").length,
    meter: document.querySelectorAll(".prod-animatic-meter").length,
    importAudioBtn: !!document.querySelector('[aria-label="Import audio"]'),
    fitVoBtn: !!document.querySelector('[aria-label="Fit to VO"]'),
    audioEls: document.querySelectorAll(".prod-animatic-body audio, audio[hidden]").length,
  }));
  check("A4 panels + wave strip + meter gone", domA.panels === 0 && domA.waveRow === 0 && domA.meter === 0, JSON.stringify(domA));
  check("A5 Import audio button present, Fit to VO gone", domA.importAudioBtn && !domA.fitVoBtn);
  await page.screenshot({ path: path.join(outDir, "A-step4.png") });

  // ---- C (part 1). header stack screenshot -----------------------------
  await page.locator(".prod-tl-headers").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const headersBox = await page.locator(".prod-tl-headers").boundingBox();
  await page.screenshot({ path: path.join(outDir, "C-headers-before.png"), clip: { x: headersBox.x - 4, y: headersBox.y - 4, width: headersBox.width + 40, height: Math.min(headersBox.height + 8, 320) } });
  const stack = await page.evaluate(() => {
    const h = [...document.querySelectorAll(".prod-tl-header")].find((x) => x.querySelector(".prod-tl-track-vol"));
    if (!h) return null;
    const vol = h.querySelector(".prod-tl-track-vol").getBoundingClientRect();
    const btns = h.querySelector(".prod-tl-header-btns").getBoundingClientRect();
    const head = h.getBoundingClientRect();
    return { volBottom: vol.bottom, btnsTop: btns.top, volRight: vol.right, headRight: head.right, volWidth: vol.width, headWidth: head.width };
  });
  check("C1 slider above buttons & inside panel", !!stack && stack.volBottom <= stack.btnsTop + 1 && stack.volRight <= stack.headRight + 1, JSON.stringify(stack));

  // ---- B. ramp ----------------------------------------------------------
  const clip1 = page.locator('[data-clip-id="c1"]');
  const b1 = await clip1.boundingBox();
  await page.mouse.click(b1.x + 30, b1.y + b1.height / 2);
  await page.waitForTimeout(300);
  const wideBefore = (await clip1.boundingBox()).width;
  await page.getByLabel("Add ramp", { exact: true }).click();
  await page.waitForTimeout(500);
  console.log("dots after Add ramp:", await page.evaluate(() => document.querySelectorAll(".prod-tl-ramp-dot").length),
    "selected:", await page.evaluate(() => document.querySelector('[data-clip-id="c1"]')?.className));
  // Drag END dot up to the 200% line (rampYFrac(2) ~= 0.513 of clip height).
  const dotPt = await page.evaluate(() => {
    const dots = document.querySelectorAll(".prod-tl-ramp-dot");
    const d = dots[dots.length - 1];
    const r = d.getBoundingClientRect();
    const clip = document.querySelector('[data-clip-id="c1"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, clipTop: clip.top, clipH: clip.height };
  });
  console.log("end dot at:", JSON.stringify(dotPt));
  console.log("elementFromPoint(end dot):", await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el ? `${el.tagName}.${el.getAttribute("class")} kf=${el.getAttribute("data-kf-index")}` : "null";
  }, dotPt));
  await page.mouse.move(dotPt.x, dotPt.y);
  await page.mouse.down();
  await page.mouse.move(dotPt.x, dotPt.clipTop + dotPt.clipH * 0.513, { steps: 12 });
  await page.waitForTimeout(200);
  console.log("mid-drag width:", (await clip1.boundingBox()).width, "label:", await page.evaluate(() => document.querySelector('[data-clip-id="c1"]')?.textContent));
  await page.mouse.up();
  await page.waitForTimeout(800);
  const wideAfter = (await clip1.boundingBox()).width;
  const saved2 = readSaved();
  const c1 = saved2.timeline.clips.find((c) => c.id === "c1");
  const curve = c1.speedCurve ?? [];
  const last = curve[curve.length - 1] ?? {};
  // Duration from width ratio (pps cancels): expect ~5.33/8.
  const ratio = wideAfter / wideBefore;
  // Curve is flat 1x to 4s then ramps to 2x: duration = 4 + 4/1.5 = 6.667.
  check("B1 clip shortened by 1->2 ramp", ratio > 0.80 && ratio < 0.87, `ratio=${ratio.toFixed(3)} width ${Math.round(wideBefore)}->${Math.round(wideAfter)}`);
  check("B2 curve spans clip & ends ~2x", Math.abs((last.speed ?? 0) - 2) < 0.15 && Math.abs((last.atSec ?? 99) - 6.667) < 0.1, JSON.stringify(curve));
  await page.screenshot({ path: path.join(outDir, "B-ramped.png") });

  // Preview: play and sample the active video rate.
  await page.locator(".prod-animatic-transport").scrollIntoViewIfNeeded();
  await page.mouse.click(headersBox.x + 10, headersBox.y + 10); // park mouse
  const playBtn = page.locator('.prod-animatic-transport button[title^="Play"]');
  await playBtn.click();
  const samples = [];
  for (let i = 0; i < 18; i++) {
    await page.waitForTimeout(450);
    const s = await page.evaluate(() => {
      const v = [...document.querySelectorAll("video")].find((el) => el.offsetParent !== null || el.style.visibility !== "hidden");
      const t = document.querySelector(".prod-animatic-time")?.textContent ?? "";
      return { rate: v?.playbackRate ?? null, t };
    });
    samples.push(s);
    if ((s.rate ?? 0) > 1.55) break;
  }
  console.log("preview samples:", JSON.stringify(samples));
  const rates = samples.map((s) => s.rate).filter((r) => r != null);
  check("B3 preview rate rises through the ramp", rates.length >= 3 && Math.max(...rates) > 1.45 && rates[rates.length - 1] > rates[0] + 0.3, JSON.stringify(rates.map((r) => +r.toFixed(2))));
  // Stop playback.
  const pauseBtn = page.locator('.prod-animatic-transport button[title^="Pause"]');
  if (await pauseBtn.count()) await pauseBtn.first().click();
  await page.waitForTimeout(300);

  // Delete clip 2 so the render total IS the ramped clip length
  // (otherwise the gap before c2 keeps the total at 16s by design).
  await page.locator(".prod-tl-lanes").scrollIntoViewIfNeeded();
  const c2box = await page.locator('[data-clip-id="c2"]').boundingBox();
  await page.mouse.click(c2box.x + 30, c2box.y + c2box.height / 2);
  await page.waitForTimeout(200);
  await page.getByLabel("Delete selected", { exact: true }).click();
  await page.waitForTimeout(600);
  console.log("after c2 delete, clips:", JSON.stringify(readSaved().timeline.clips.map((c) => c.id)));

  // Render via Assembly.
  await page.locator('.prod-step:has(.prod-step-title:text-is("Assembly"))').first().click();
  await page.waitForTimeout(1200);
  const renderFile = path.join(prodFolder, "out", "assembly", "render.mp4");
  try { fs.rmSync(renderFile); } catch {}
  await page.getByRole("button", { name: "Build package" }).click();
  await page.waitForTimeout(4000);
  await page.getByRole("button", { name: "Render MP4" }).click();
  let rendered = false;
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(1500);
    if (fs.existsSync(renderFile) && fs.statSync(renderFile).size > 10000) {
      // Ensure write finished (size stable).
      const s1 = fs.statSync(renderFile).size;
      await page.waitForTimeout(1200);
      if (fs.statSync(renderFile).size === s1) { rendered = true; break; }
    }
  }
  check("B4 render produced render.mp4", rendered);
  if (rendered) {
    let dur = NaN;
    try {
      execFileSync(ffmpegPath, ["-i", renderFile], { stdio: "pipe" });
    } catch (e) {
      const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(e.stderr));
      if (m) dur = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    }
    // Ramped single-clip total ~= 6.67s (vs 8s unramped).
    check("B5 render duration matches ramped preview (~6.7s)", dur > 6.2 && dur < 7.1, `render=${dur.toFixed(2)}s`);
  }
  await page.screenshot({ path: path.join(outDir, "B-assembly.png") });

  // ---- C (part 2). resize + relaunch ------------------------------------
  await openAnimatic(page, { viaCard: false });
  const grip = page.locator(".prod-tl-resize");
  const gb = await grip.boundingBox();
  const wBefore = (await page.locator(".prod-tl-headers").boundingBox()).width;
  await page.mouse.move(gb.x + gb.width / 2, gb.y + 60);
  await page.mouse.down();
  await page.mouse.move(gb.x + gb.width / 2 + 90, gb.y + 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const wAfter = (await page.locator(".prod-tl-headers").boundingBox()).width;
  check("C2 drag widens header panel", Math.abs(wAfter - (wBefore + 90)) < 6, `${Math.round(wBefore)}->${Math.round(wAfter)}`);
  await page.locator(".prod-tl-headers").scrollIntoViewIfNeeded();
  const hb2 = await page.locator(".prod-tl-headers").boundingBox();
  await page.screenshot({ path: path.join(outDir, "C-headers-wide.png"), clip: { x: hb2.x - 4, y: hb2.y - 4, width: hb2.width + 40, height: Math.min(hb2.height + 8, 320) } });

  console.log("persisted headerW:", await page.evaluate(() => window.localStorage.getItem("cascade.timeline.headerW")));
  // Graceful close so Chromium flushes localStorage (a hard kill can
  // lose the last writes - that is a harness artifact, not app behavior).
  await page.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  await app.browser.close().catch(() => {});
  app.child.kill();
  await new Promise((r) => setTimeout(r, 1200));
  app = await launch();
  await openAnimatic(app.page, { viaCard: false });
  const wRelaunch = await app.page.evaluate(() => document.querySelector(".prod-tl-headers")?.getBoundingClientRect().width ?? 0);
  check("C3 width remembered after relaunch", Math.abs(wRelaunch - wAfter) < 6, `relaunch=${Math.round(wRelaunch)}`);
} catch (e) {
  console.log(`HARNESS ERROR: ${e.message}`);
  facts.harnessError = String(e.message);
} finally {
  try { await app.browser?.close(); } catch { /* ignore */ }
  app.child.kill();
  await new Promise((r) => setTimeout(r, 800));
}
fs.writeFileSync(path.join(outDir, "facts.json"), JSON.stringify(facts, null, 2));
const failed = Object.values(facts).filter((v) => v === "FAIL").length;
console.log(failed || facts.harnessError ? `DONE with ${failed} FAIL` : "ALL CHECKS PASSED");
process.exit(failed || facts.harnessError ? 1 : 0);
