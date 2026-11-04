/**
 * Batch 3 (animatic) live verification â€” Items 1-5 against the real app.
 * Prints PASS/FAIL per check; exits non-zero on any FAIL.
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
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
const port = 9381;
const userData = path.join(here, "userdata-verify2");
const prodFolder = path.join(here, "seed-verify2");
fs.rmSync(userData, { recursive: true, force: true });
for (const d of ["boards", "videos", "audio", "stills", "voiceover", "music", "out", "references", "assembly"]) {
  fs.mkdirSync(path.join(prodFolder, d), { recursive: true });
}
fs.copyFileSync(path.join(here, "media", "red6s-silent.mp4"), path.join(prodFolder, "videos", "red6s-silent.mp4"));
fs.copyFileSync(path.join(here, "media", "blue6s-silent.mp4"), path.join(prodFolder, "videos", "blue6s-silent.mp4"));
fs.copyFileSync(path.join(here, "media", "green.jpg"), path.join(prodFolder, "stills", "green.jpg"));
fs.copyFileSync(path.join(here, "media", "yellow.jpg"), path.join(prodFolder, "stills", "yellow.jpg"));
fs.copyFileSync(path.join(here, "media", "tone8s.mp3"), path.join(prodFolder, "audio", "tone8s.mp3"));

const PROD_ID = "verifybatch2001";
const now = new Date().toISOString();
const production = {
  meta: { id: PROD_ID, name: "Batch verify", folder: prodFolder, createdAt: now, updatedAt: now, stepDone: 4, shotCount: 4 },
  currentStep: 4,
  visualStyle: "",
  styles: [],
  scenes: [{
    number: 1, title: "Scene",
    shots: [
      { id: "shot1", number: "0100", audio: "", visual: "red", durationSec: 6, videoPath: "videos/red6s-silent.mp4" },
      { id: "shot2", number: "0200", audio: "", visual: "blue", durationSec: 6, videoPath: "videos/blue6s-silent.mp4" },
      { id: "shot3", number: "0300", audio: "", visual: "green", durationSec: 4 },
      { id: "shot4", number: "0400", audio: "", visual: "yellow", durationSec: 4 },
    ],
  }],
  characters: [], products: [], references: [], status: {},
  timeline: {
    version: 1,
    tracks: [{ id: "v1", kind: "video", name: "V1" }, { id: "a1", kind: "audio", name: "A1" }],
    clips: [
      { id: "c1", trackId: "v1", sourceKind: "video", srcRel: "videos/red6s-silent.mp4", sourceInSec: 0, sourceOutSec: 6, timelineStartSec: 0, name: "red6s-silent.mp4", shotId: "shot1" },
      { id: "c2", trackId: "v1", sourceKind: "video", srcRel: "videos/blue6s-silent.mp4", sourceInSec: 0, sourceOutSec: 6, timelineStartSec: 6, name: "blue6s-silent.mp4", shotId: "shot2" },
      { id: "c3", trackId: "v1", sourceKind: "still", srcRel: "stills/green.jpg", holdSec: 4, timelineStartSec: 12, name: "green.jpg", shotId: "shot3" },
      { id: "c4", trackId: "v1", sourceKind: "still", srcRel: "stills/yellow.jpg", holdSec: 4, timelineStartSec: 16, name: "yellow.jpg", shotId: "shot4" },
      { id: "ac1", trackId: "a1", sourceKind: "audio", srcRel: "audio/tone8s.mp3", sourceInSec: 0, sourceOutSec: 8, timelineStartSec: 0, name: "tone8s.mp3" },
    ],
    transitions: [{ id: "tr1", type: "dissolve", outgoingClipId: "c3", incomingClipId: "c4", durationSec: 2 }],
  },
  assembly: { fps: 24, width: 640, height: 360, exportDir: "out/assembly" },
  assets: { scriptMd: "script.md", boardsDir: "boards", voiceoverDir: "voiceover", musicDir: "music", outDir: "out", referencesDir: "references", assemblyDir: "assembly" },
};
fs.mkdirSync(path.join(userData, "productions"), { recursive: true });
const savePath = path.join(userData, "productions", `${PROD_ID}.json`);
fs.writeFileSync(savePath, JSON.stringify(production, null, 2));
const saved = () => JSON.parse(fs.readFileSync(savePath, "utf8"));

let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${extra ? ` â€” ${extra}` : ""}`);
  if (!cond) failures++;
};
function avgColorFrame(file, t) {
  const buf = execFileSync(ffmpegPath, ["-y", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 20, stdio: ["ignore", "pipe", "ignore"] });
  return { r: buf[0], g: buf[1], b: buf[2] };
}
function meanVolumeDb(file, seconds) {
  const r = spawnSync(ffmpegPath, ["-i", file, "-t", String(seconds), "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/mean_volume:\s*(-?[\d.]+)/.exec(r.stderr || "")?.[1]);
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
  }
  const step = page.locator('.prod-step:has(.prod-step-title:text-is("Animatic"))').first();
  if (await step.count()) await step.click();
  await page.waitForTimeout(1800);

  const pps = () => page.evaluate(() => Number(document.querySelector('[data-testid="timeline-editor"]')?.dataset.pps || 0));
  const lanesBox = () => page.locator(".prod-tl-lanes").boundingBox();
  const seekLane = async (sec) => {
    const b = await lanesBox();
    await page.mouse.click(b.x + sec * (await pps()), b.y + 6);
    await page.waitForTimeout(250);
  };
  const audioState = () => page.evaluate(() => [...document.querySelectorAll("audio")].map((el) => ({ vol: el.volume, paused: el.paused })));
  const transportSec = async () => {
    const t = await page.evaluate(() => document.querySelector(".prod-animatic-time")?.textContent || "");
    const m = /(\d+):(\d+)/.exec(t);
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  };
  const focusEditor = () => page.evaluate(() => document.querySelector('[data-testid="timeline-editor"]')?.focus());

  // ---------- Item 2: live slider -------------------------------------
  await page.locator(".prod-tl-lanes").scrollIntoViewIfNeeded();
  await seekLane(0.01);
  await page.locator(".prod-animatic-preview").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.locator('.prod-animatic-transport button[title^="Play"]').click();
  await page.waitForTimeout(900);
  let st = await audioState();
  check("I2 audio plays at unity before slider", st.length === 1 && !st[0].paused && Math.abs(st[0].vol - 1) < 0.02, JSON.stringify(st));

  const slider = page.locator(".prod-tl-track-vol").first();
  await slider.scrollIntoViewIfNeeded();
  const sb = await slider.boundingBox();
  await page.mouse.move(sb.x + sb.width * 0.25, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  st = await audioState();
  check("I2 volume follows DURING drag (held ~25%)", st.length === 1 && st[0].vol > 0.1 && st[0].vol < 0.45, JSON.stringify(st));
  await page.mouse.up();
  await page.waitForTimeout(400);

  await slider.focus();
  await page.keyboard.press("Home");
  await page.waitForTimeout(600);
  st = await audioState();
  check("I2 keyboard Home silences without blur", st.length === 1 && st[0].vol <= 0.02, JSON.stringify(st));

  // Set 50% for the render measurement.
  const sb2 = await slider.boundingBox();
  await page.mouse.click(sb2.x + sb2.width * 0.5, sb2.y + sb2.height / 2);
  await page.waitForTimeout(700);
  const savedVol = saved().timeline?.tracks?.find((t) => t.id === "a1")?.volume;
  check("I2 slider persists ~0.5", typeof savedVol === "number" && Math.abs(savedVol - 0.5) < 0.08, `saved=${savedVol}`);
  await page.locator(".prod-animatic-preview").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.locator('.prod-animatic-transport button[title^="Pause"]').click().catch(() => {});
  await page.waitForTimeout(300);

  // ---------- Item 3: length field ------------------------------------
  await page.locator(".prod-tl-lanes").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const field = page.locator('[aria-label="Timeline length"]');
  check("I3 field shows 00:20", (await field.inputValue()) === "00:20", await field.inputValue());
  await field.click();
  await field.fill("01:00");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  check("I3 01:00 extends (field + saved durationSec)", (await field.inputValue()) === "01:00" && saved().timeline?.durationSec === 60, `field=${await field.inputValue()} saved=${saved().timeline?.durationSec}`);
  await field.click();
  await field.fill("00:05");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  const afterClamp = saved();
  check("I3 00:05 clamps to last clip end, clips intact", (await field.inputValue()) === "00:20" && afterClamp.timeline?.durationSec === undefined && afterClamp.timeline?.clips?.length === 5,
    `field=${await field.inputValue()} dur=${afterClamp.timeline?.durationSec} clips=${afterClamp.timeline?.clips?.length}`);
  await field.click();
  await field.fill("xyz");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  check("I3 invalid input reverts", (await field.inputValue()) === "00:20", await field.inputValue());

  // ---------- Item 4: loop region -------------------------------------
  await seekLane(2);
  await focusEditor();
  await page.keyboard.press("i");
  await page.waitForTimeout(250);
  await seekLane(5);
  await focusEditor();
  await page.keyboard.press("o");
  await page.waitForTimeout(250);
  check("I4 ruler shows loop region", (await page.locator(".prod-tl-loop-region").count()) === 1);
  const loopBtn = page.getByRole("button", { name: "Loop", exact: true });
  await loopBtn.click();
  check("I4 Loop toggle on", (await loopBtn.getAttribute("aria-pressed")) === "true");
  await seekLane(0.01);
  await page.locator(".prod-animatic-preview").scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.locator('.prod-animatic-transport button[title^="Play"]').click();
  const times = [];
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(300);
    times.push(await transportSec());
  }
  const stillPlaying = (await page.locator('.prod-animatic-transport button[title^="Pause"]').count()) > 0;
  const wrapped = times.some((t, i) => i > 0 && t < times[i - 1] - 1);
  check("I4 playback wraps inside region and keeps playing", wrapped && stillPlaying && Math.max(...times) <= 5,
    `times=${times.join(",")} stillPlaying=${stillPlaying}`);
  await page.locator('.prod-animatic-transport button[title^="Pause"]').click();
  await page.locator(".prod-tl-lanes").scrollIntoViewIfNeeded();
  await focusEditor();
  await page.keyboard.press("Alt+i");
  await page.waitForTimeout(250);
  check("I4 Alt+I clears the region", (await page.locator(".prod-tl-loop-region").count()) === 0);
  // Restore points cleared fully (Alt+O too) so later steps are clean.
  await page.keyboard.press("Alt+o");
  await loopBtn.click(); // Loop off

  // ---------- Item 5: playhead drag stays scrub ------------------------
  await page.locator('[data-clip-id="c2"]').click();
  await page.waitForTimeout(250);
  const selBefore = await page.evaluate(() => [...document.querySelectorAll(".prod-tl-clip.selected")].map((e) => e.getAttribute("data-clip-id")));
  check("I5 setup: c2 selected", JSON.stringify(selBefore) === JSON.stringify(["c2"]), JSON.stringify(selBefore));
  const b = await lanesBox();
  const p = await pps();
  await page.mouse.move(b.x + 1 * p, b.y + 6);
  await page.mouse.down();
  await page.mouse.move(b.x + 4 * p, b.y + 110, { steps: 6 });
  const marqueeMid = await page.locator(".prod-tl-marquee").count();
  await page.mouse.move(b.x + 7 * p, b.y + 170, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const selAfter = await page.evaluate(() => [...document.querySelectorAll(".prod-tl-clip.selected")].map((e) => e.getAttribute("data-clip-id")));
  const headAfter = await transportSec();
  check("I5 no marquee during ruler drag", marqueeMid === 0);
  check("I5 selection unchanged + playhead at release", JSON.stringify(selAfter) === JSON.stringify(["c2"]) && headAfter >= 6 && headAfter <= 7,
    `sel=${JSON.stringify(selAfter)} head=${headAfter}`);

  // ---------- Item 1: still dissolve preview wiring --------------------
  await seekLane(16);
  await page.waitForTimeout(800);
  const under = await page.evaluate(() => {
    const img = document.querySelector("img.blend-under");
    const top = document.querySelector("img.prod-timeline-thumb");
    return { hasUnder: !!img, underSrc: img?.getAttribute("src") ?? "", topOpacity: top?.style.opacity ?? "" };
  });
  check("I1 still dissolve: under-layer image present mid-transition", under.hasUnder, JSON.stringify(under));

  // ---------- Render: Item 2 levels + Item 1 still crossfade -----------
  await page.locator('.prod-step:has(.prod-step-title:text-is("Assembly"))').first().click();
  await page.waitForTimeout(1200);
  const renderFile = path.join(prodFolder, "out", "assembly", "render.mp4");
  try { fs.rmSync(renderFile); } catch { /* ignore */ }
  await page.getByRole("button", { name: "Build package" }).click();
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Render MP4" }).click();
  let rendered = false;
  for (let i = 0; i < 80 && !rendered; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    if (fs.existsSync(renderFile) && fs.statSync(renderFile).size > 5000) {
      const s1 = fs.statSync(renderFile).size;
      await new Promise((r) => setTimeout(r, 1200));
      if (fs.statSync(renderFile).size === s1) rendered = true;
    }
  }
  check("render produced", rendered);
  if (rendered) {
    // Oracle: the same mix graph (volume=0.5 -> aresample -> amix over
    // silence -> limiter -> AAC) built locally. (A naive -6.02dB
    // expectation misses ffmpeg's mono->stereo pan law in aresample,
    // which both mixes share.)
    const refFile = path.join(here, "media", "ref-mix.m4a");
    execFileSync(ffmpegPath, ["-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "8", "-i", path.join(prodFolder, "audio", "tone8s.mp3"),
      "-filter_complex", "[1:a]volume=0.5,aresample=48000,apad[a0];[0:a][a0]amix=inputs=2:normalize=0,alimiter=limit=0.95[outa]",
      "-map", "[outa]", "-t", "6", "-c:a", "aac", "-b:a", "192k", refFile], { stdio: ["ignore", "ignore", "ignore"] });
    const srcDb = meanVolumeDb(path.join(prodFolder, "audio", "tone8s.mp3"), 6);
    const refDb = meanVolumeDb(refFile, 6);
    const outDb = meanVolumeDb(renderFile, 6);
    check("I2 rendered level matches 50%-slider reference mix", Number.isFinite(outDb) && Math.abs(outDb - refDb) < 0.7 && outDb < srcDb - 4,
      `src=${srcDb}dB ref=${refDb}dB out=${outDb}dB`);
    const beforeDissolve = avgColorFrame(renderFile, 14.5);
    const mid = avgColorFrame(renderFile, 16);
    check("I1 render stills: pure green before window", beforeDissolve.r < 45 && beforeDissolve.g > 90, JSON.stringify(beforeDissolve));
    check("I1 render stills: blended mid-dissolve (no black)", mid.r > 85 && mid.r < 175 && mid.g > 140 && mid.b < 70, JSON.stringify(mid));
  }

  // ---------- Item 2: Mute silences preview regardless of slider -------
  await page.locator('.prod-step:has(.prod-step-title:text-is("Animatic"))').first().click();
  await page.waitForTimeout(1500);
  const muteBtn = page.locator('.prod-tl-header:has(.prod-tl-track-vol) button[title="Mute track"]').first();
  await muteBtn.scrollIntoViewIfNeeded();
  await muteBtn.click();
  await page.waitForTimeout(600);
  await page.locator(".prod-tl-lanes").scrollIntoViewIfNeeded();
  await seekLane(0.01);
  await page.locator(".prod-animatic-preview").scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.locator('.prod-animatic-transport button[title^="Play"]').click();
  await page.waitForTimeout(900);
  st = await audioState();
  check("I2 muted track silent in preview despite 50% slider", st.length === 0 || st.every((a) => a.paused || a.vol === 0), JSON.stringify(st));
  await page.locator('.prod-animatic-transport button[title^="Pause"]').click().catch(() => {});
} catch (e) {
  console.log(`HARNESS ERROR: ${e.message}`);
  failures++;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);

