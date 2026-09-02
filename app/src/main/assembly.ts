/**
 * Step 5 Assembly — the editor-handoff + render module.
 *
 * Deep module with a small surface. The pure builders (assemblyPlan, buildEdl,
 * buildAeScript, buildManifest, buildRenderArgs / buildConcatArgs / buildMixArgs)
 * hold the real logic and are unit-tested in app/test/assembly.test.ts.
 * `assemble()` does the file copying + artifact writes; `renderAnimatic()`
 * drives the 3-pass ffmpeg pipeline through an injected `runFfmpeg`/`probe`
 * seam so it's fakeable in tests.
 *
 * Media rule (mirrors the animatic timeline): a shot with a `videoPath` plays
 * as a clip (its full-res still is still gathered for the storyboard); a shot
 * with only `artwork` is a still (full-res original preferred); a shot with
 * neither is a `blank` event — a black slot that still holds its full animatic
 * duration, so nothing ever shifts later timing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Production, ProductionAssembly } from "../shared/ipc.js";
import { assetPath, formatRuntime, originalForJpegRel } from "./pipeline.js";

export type AssemblyEmit = (message: string, level?: "info" | "error" | "done") => void;

export interface AssemblyConfig {
  fps: number;
  width: number;
  height: number;
}

export interface AssemblyEvent {
  shotId: string;
  number: string;
  kind: "still" | "clip" | "blank";
  /** Workspace-relative source file (boards JPEG/original or videos clip).
   *  Absent for `blank` (black) slots. */
  srcRel?: string;
  /** Path relative to the export folder's media/ dir, e.g. "shots/0100.png".
   *  Absent for `blank` (black) slots. */
  mediaRel?: string;
  durationSec: number;
  muted: boolean;
  /** Cumulative timeline position (computed over included events only). */
  startSec: number;
  endSec: number;
  /** Actual clip length when probed (used for EDL source-out + render padding). */
  probedSec?: number;
  hasAudio?: boolean;
}

export interface AssemblyAudio {
  srcRel: string;
  mediaRel: string;
  volume: number;
  probedSec?: number;
}

export interface AssemblyPlan {
  events: AssemblyEvent[];
  voiceover?: AssemblyAudio;
  music?: AssemblyAudio;
  totalSec: number;
  /** Shot numbers rendered as black slots because they had no frame and no clip. */
  blanks: string[];
  /** Every media file that must land in the export folder (events + audio), deduped. */
  media: { srcRel: string; mediaRel: string }[];
}

export interface ProbeResult {
  durationSec: number | null;
  hasAudio: boolean;
}
export type ProbeFn = (bin: string, absPath: string) => Promise<ProbeResult>;

// ---- pure helpers ----------------------------------------------------------

function pickInt(v: number | undefined, fallback: number): number {
  return Number.isFinite(v) && (v ?? 0) >= 1 ? Math.round(v!) : fallback;
}

export function assemblyConfig(
  p: Production,
  cfg?: Partial<Pick<ProductionAssembly, "fps" | "width" | "height">>
): AssemblyConfig {
  return {
    fps: pickInt(cfg?.fps ?? p.assembly?.fps, 24),
    width: pickInt(cfg?.width ?? p.assembly?.width, 1920),
    height: pickInt(cfg?.height ?? p.assembly?.height, 1080),
  };
}

function extOf(rel: string, fallback: string): string {
  const slash = rel.lastIndexOf("/");
  const dot = rel.lastIndexOf(".");
  if (dot <= slash) return fallback;
  const ext = rel.slice(dot).toLowerCase();
  return ext.length >= 2 && ext.length <= 6 ? ext : fallback;
}

function clampVolume(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
}

function round3(x: number): string {
  return (Math.round(x * 1000) / 1000).toFixed(3);
}

/** Non-drop-frame timecode HH:MM:SS:FF from a frame count. */
export function framesToTc(frames: number, fps: number): string {
  const f = Math.max(0, Math.round(frames));
  const fi = Math.max(1, Math.round(fps));
  const pad = (x: number, l = 2) => String(x).padStart(l, "0");
  const ff = f % fi;
  const totalSec = Math.floor(f / fi);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor(totalSec / 60) % 60;
  const s = totalSec % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(ff)}`;
}

// ---- assemblyPlan ----------------------------------------------------------

export function assemblyPlan(p: Production): AssemblyPlan {
  const events: AssemblyEvent[] = [];
  const blanks: AssemblyPlan["blanks"] = [];
  const media: AssemblyPlan["media"] = [];
  const seen = new Map<string, string>();

  const addMedia = (srcRel: string, mediaRel: string): string => {
    const existing = seen.get(srcRel);
    if (existing) return existing;
    seen.set(srcRel, mediaRel);
    media.push({ srcRel, mediaRel });
    return mediaRel;
  };

  let t = 0;
  for (const scene of p.scenes) {
    for (const shot of scene.shots) {
      const dur = Math.max(0.1, shot.durationSec ?? 3);
      const clipRel = shot.videoPath || undefined;
      const stillRel = shot.artwork ? originalForJpegRel(p, shot.artwork) ?? shot.artwork : undefined;

      if (stillRel) addMedia(stillRel, `shots/${shot.number}${extOf(stillRel, ".png")}`);
      if (clipRel) {
        const mediaRel = addMedia(clipRel, `clips/${shot.number}${extOf(clipRel, ".mp4")}`);
        events.push({ shotId: shot.id, number: shot.number, kind: "clip", srcRel: clipRel, mediaRel, durationSec: dur, muted: !!shot.muted, startSec: t, endSec: t + dur });
      } else if (stillRel) {
        const mediaRel = addMedia(stillRel, `shots/${shot.number}${extOf(stillRel, ".png")}`);
        events.push({ shotId: shot.id, number: shot.number, kind: "still", srcRel: stillRel, mediaRel, durationSec: dur, muted: false, startSec: t, endSec: t + dur });
      } else {
        events.push({ shotId: shot.id, number: shot.number, kind: "blank", durationSec: dur, muted: false, startSec: t, endSec: t + dur });
        blanks.push(shot.number);
      }
      t += dur;
    }
  }

  const voiceover = p.voiceoverPath
    ? { srcRel: p.voiceoverPath, mediaRel: addMedia(p.voiceoverPath, `audio/voiceover${extOf(p.voiceoverPath, ".mp3")}`), volume: clampVolume(p.voiceoverVolume ?? 1) }
    : undefined;
  const music = p.musicPath
    ? { srcRel: p.musicPath, mediaRel: addMedia(p.musicPath, `audio/music${extOf(p.musicPath, ".mp3")}`), volume: clampVolume(p.musicVolume ?? 0.5) }
    : undefined;

  return { events, voiceover, music, totalSec: t, blanks, media };
}

// ---- buildEdl --------------------------------------------------------------

/** CMX3600 EDL. Stills use source-in == source-out == 0 (a freeze); clips use
 *  the planned (probe-clamped) duration; blank slots use the `BL` reel with a
 *  zero-length source. VO/music ride the A track as events spanning the full
 *  timeline. CRLF line endings. */
export function buildEdl(plan: AssemblyPlan, fps: number, title: string): string {
  const lines: string[] = [
    `TITLE: ${title.replace(/[\r\n]+/g, " ").slice(0, 80) || "Cascade Assembly"}`,
    "FCM: NON-DROP FRAME",
    "",
  ];
  let n = 1;
  const event = (reel: string, track: "V" | "A", srcIn: string, srcOut: string, recIn: string, recOut: string, clip: string, note?: string) => {
    lines.push(`${String(n).padStart(3, "0")}  ${reel.padEnd(8, " ")}  ${track}     C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);
    lines.push(`* FROM CLIP NAME: ${clip}`);
    if (note) lines.push(`* NOTE: ${note}`);
    n++;
  };
  for (const ev of plan.events) {
    if (ev.kind === "blank") {
      event(
        "BL",
        "V",
        "00:00:00:00",
        "00:00:00:00",
        framesToTc(ev.startSec * fps, fps),
        framesToTc(ev.endSec * fps, fps),
        "BLACK"
      );
      continue;
    }
    const srcFrames =
      ev.kind === "clip" ? Math.round(Math.min(ev.probedSec ?? ev.durationSec, ev.durationSec) * fps) : 0;
    event(
      `SHOT${ev.number}`,
      "V",
      "00:00:00:00",
      framesToTc(srcFrames, fps),
      framesToTc(ev.startSec * fps, fps),
      framesToTc(ev.endSec * fps, fps),
      ev.mediaRel ?? "BLACK"
    );
  }
  if (plan.voiceover) {
    const srcFrames = plan.voiceover.probedSec != null ? Math.round(Math.min(plan.voiceover.probedSec, plan.totalSec) * fps) : Math.round(plan.totalSec * fps);
    event(
      "VOICE",
      "A",
      "00:00:00:00",
      framesToTc(srcFrames, fps),
      "00:00:00:00",
      framesToTc(plan.totalSec * fps, fps),
      plan.voiceover.mediaRel,
      plan.voiceover.probedSec == null ? "voiceover duration unverified" : undefined
    );
  }
  if (plan.music) {
    const srcFrames = plan.music.probedSec != null ? Math.round(Math.min(plan.music.probedSec, plan.totalSec) * fps) : Math.round(plan.totalSec * fps);
    event(
      "MUSIC",
      "A",
      "00:00:00:00",
      framesToTc(srcFrames, fps),
      "00:00:00:00",
      framesToTc(plan.totalSec * fps, fps),
      plan.music.mediaRel,
      plan.music.probedSec == null ? "music duration unverified" : undefined
    );
  }
  return lines.join("\r\n") + "\r\n";
}

// ---- buildAeScript ---------------------------------------------------------

function aeStr(s: string): string {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function dB(volume: number): string {
  if (volume <= 0) return "-inf";
  return (20 * Math.log(volume) / Math.LN10).toFixed(2);
}

/** After Effects ExtendScript that rebuilds the animatic as a composition.
 *  Media paths are resolved relative to the script file so the export folder
 *  stays portable. Saves Assembly.aep next to the script. */
export function buildAeScript(plan: AssemblyPlan, cfg: AssemblyConfig, exportRoot: string): string {
  const media = exportRoot.replace(/\\/g, "/") + "/media";
  const lines: string[] = [
    "// Generated by Cascade — Assembly rebuild script (do not edit).",
    "// After Effects CC2019+. File > Scripts > Run Script File…",
    "var scriptDir = (new File($.fileName)).path;",
    `var media = scriptDir + ${aeStr("/media")};`,
    "var proj = app.newProject();",
    `var comp = proj.items.addComp(${aeStr("Assembly")}, ${cfg.width}, ${cfg.height}, 1, ${round3(plan.totalSec)}, ${cfg.fps});`,
    "",
  ];
  plan.events.forEach((ev, i) => {
    if (ev.kind === "blank") {
      lines.push(`var lay${i} = comp.layers.addSolid([0, 0, 0], ${aeStr("BLANK")}, ${cfg.width}, ${cfg.height}, 1);`);
    } else {
      lines.push(`var foot${i} = proj.importFile(new ImportOptions(new File(media + ${aeStr("/" + (ev.mediaRel ?? ""))})));`);
      lines.push(`var lay${i} = comp.layers.add(foot${i});`);
    }
    lines.push(`lay${i}.name = ${aeStr(ev.number)};`);
    lines.push(`lay${i}.startTime = ${round3(ev.startSec)};`);
    lines.push(`lay${i}.outPoint = ${round3(ev.endSec)};`);
    if (ev.kind === "clip" && ev.muted) lines.push(`lay${i}.audioEnabled = false;`);
    lines.push("");
  });
  const bed = (name: string, audio: AssemblyAudio | undefined) => {
    if (!audio) return;
    lines.push(`var ${name}Foot = proj.importFile(new ImportOptions(new File(media + ${aeStr("/" + audio.mediaRel)})));`);
    lines.push(`var ${name}Lay = comp.layers.add(${name}Foot);`);
    lines.push(`${name}Lay.startTime = 0;`);
    lines.push(`${name}Lay.outPoint = ${round3(plan.totalSec)};`);
    lines.push(`${name}Lay.property("ADBE Audio Group").property("ADBE Audio Levels").setValue([${dB(audio.volume)}]);`);
    lines.push("");
  };
  bed("vo", plan.voiceover);
  bed("music", plan.music);
  lines.push(`app.project.save(new File(scriptDir + ${aeStr("/Assembly.aep")}));`);
  return lines.join("\n") + "\n";
}

// ---- buildManifest ---------------------------------------------------------

export function buildManifest(
  plan: AssemblyPlan,
  cfg: AssemblyConfig,
  opts: { title: string; builtAt: string; edlName: string; jsxName: string; renderName?: string }
): string {
  const rows = plan.events
    .map((ev) => `| ${ev.number} | ${ev.kind} | ${ev.mediaRel ?? "-"} | ${ev.durationSec.toFixed(1)}s | ${ev.muted ? "muted" : ""} |`)
    .join("\n");
  const lines: string[] = [
    `# ${opts.title || "Assembly"} — Manifest`,
    "",
    `Built ${opts.builtAt} · ${cfg.width}×${cfg.height} @ ${cfg.fps} fps · runtime ${formatRuntime(plan.totalSec)}`,
    "",
    `## Timeline (${plan.events.length} shots)`,
    "",
    "| Shot | Kind | Media | Duration |",
    "|------|------|-------|----------|",
    rows,
    "",
  ];
  if (plan.voiceover) lines.push(`- Voiceover: ${plan.voiceover.mediaRel} (volume ${plan.voiceover.volume})`);
  if (plan.music) lines.push(`- Music: ${plan.music.mediaRel} (volume ${plan.music.volume})`);
  lines.push("");
  lines.push("## Blank slots (no frame/clip)");
  lines.push(...(plan.blanks.length ? plan.blanks.map((n) => `- ${n}`) : ["- none"]));
  lines.push("");
  lines.push("## Artifacts");
  lines.push(`- ${opts.edlName}`);
  lines.push(`- ${opts.jsxName}`);
  lines.push(`- ${opts.renderName ?? "render.mp4 (after Render MP4)"}`);
  return lines.join("\n") + "\n";
}

// ---- ffmpeg argv builders --------------------------------------------------

/** Pass A: normalize one timeline event into a uniform h264/aac segment of
 *  exactly `durationSec` at the target resolution/fps. Every segment gets both
 *  a video and an audio stream (silence for stills, blank slots, muted clips,
 *  and clips without embedded audio) so Pass B can concat with `-c copy`.
 *  Blank slots are generated directly from a black lavfi `color` source. */
export function buildNormalizeArgs(
  ev: { kind: "still" | "clip" | "blank"; durationSec: number; muted: boolean; probedSec?: number; hasAudio?: boolean },
  cfg: AssemblyConfig,
  srcAbs: string,
  outAbs: string
): string[] {
  const { fps, width, height } = cfg;
  const dur = Math.max(0.1, ev.durationSec);
  let video: string;
  if (ev.kind === "blank") {
    video = `fps=${fps},format=yuv420p`;
  } else {
    video = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},format=yuv420p`;
    const padSec = ev.kind === "clip" && ev.probedSec != null && ev.probedSec < dur ? dur - ev.probedSec : 0;
    if (padSec > 0) video = `${video},tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}`;
  }
  const silent = ev.kind !== "clip" || ev.muted || ev.hasAudio === false;
  const args: string[] = ["-y"];
  if (ev.kind === "blank") {
    args.push("-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=${fps}`);
  } else if (ev.kind === "still") {
    args.push("-loop", "1", "-framerate", String(fps), "-i", srcAbs);
  } else {
    args.push("-i", srcAbs);
  }
  if (silent) {
    args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v", "-map", "1:a");
  } else {
    args.push("-map", "0:v", "-map", "0:a", "-af", "apad");
  }
  args.push(
    "-t", dur.toFixed(3),
    "-vf", video,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-r", String(fps),
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "192k",
    "-movflags", "+faststart",
    outAbs
  );
  return args;
}

/** The concat list file consumed by the concat demuxer (Pass B). */
export function buildConcatList(segmentAbsPaths: string[]): string {
  return segmentAbsPaths.map((s) => `file '${s.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

/** Pass B: stream-copy the normalized segments into one file (uniform codecs). */
export function buildConcatArgs(concatListAbs: string, outAbs: string): string[] {
  return ["-y", "-f", "concat", "-safe", "0", "-i", concatListAbs, "-c", "copy", "-movflags", "+faststart", outAbs];
}

/** Pass C: mix the VO + music beds over the concat result (clip audio already
 *  baked into the base track). With no beds the audio is copied through. */
export function buildMixArgs(opts: {
  renderAbs: string;
  voiceover?: { abs: string; volume: number };
  music?: { abs: string; volume: number };
  totalSec: number;
  outAbs: string;
}): string[] {
  const { renderAbs, voiceover, music, totalSec, outAbs } = opts;
  const inputs = ["-y", "-i", renderAbs];
  let beds = 0;
  if (voiceover) {
    inputs.push("-i", voiceover.abs);
    beds++;
  }
  if (music) {
    inputs.push("-i", music.abs);
    beds++;
  }
  if (beds === 0) {
    return [...inputs, "-map", "0:v", "-map", "0:a", "-t", totalSec.toFixed(3), "-c", "copy", outAbs];
  }
  const v = (x: number) => x.toFixed(2);
  let filter: string;
  if (voiceover && music) {
    filter = `[1:a]aresample=48000,volume=${v(voiceover.volume)}[vo];[2:a]aresample=48000,volume=${v(music.volume)}[mu];[0:a][vo][mu]amix=inputs=3:normalize=0,alimiter=limit=0.95[outa]`;
  } else if (voiceover) {
    filter = `[1:a]aresample=48000,volume=${v(voiceover.volume)}[vo];[0:a][vo]amix=inputs=2:normalize=0,alimiter=limit=0.95[outa]`;
  } else {
    filter = `[1:a]aresample=48000,volume=${v(music!.volume)}[mu];[0:a][mu]amix=inputs=2:normalize=0,alimiter=limit=0.95[outa]`;
  }
  return [...inputs, "-filter_complex", filter, "-map", "0:v", "-map", "[outa]", "-t", totalSec.toFixed(3), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outAbs];
}

// ---- assemble --------------------------------------------------------------

export interface AssembleResult {
  plan: AssemblyPlan;
  exportAbs: string;
  edlRel: string;
  scriptRel: string;
  manifestRel: string;
  copied: number;
  bytes: number;
}

export interface AssembleDeps {
  ffmpegBin?: string | null;
  probe?: ProbeFn;
}

/** Gather media + write the EDL / AEScript / manifest into the export folder.
 *  Mutates `p.assembly` bookkeeping (does not save). */
export async function assemble(
  p: Production,
  cfgInput: Partial<Pick<ProductionAssembly, "fps" | "width" | "height">> | undefined,
  emit: AssemblyEmit,
  deps: AssembleDeps = {}
): Promise<AssembleResult> {
  const cfg = assemblyConfig(p, cfgInput);
  const plan = assemblyPlan(p);
  const asm = p.assembly ?? { fps: 24, width: 1920, height: 1080, exportDir: `${p.assets.outDir}/${p.assets.assemblyDir}` };
  const exportAbs = assetPath(p, asm.exportDir);
  const mediaAbs = path.join(exportAbs, "media");
  fs.mkdirSync(path.join(mediaAbs, "shots"), { recursive: true });
  fs.mkdirSync(path.join(mediaAbs, "clips"), { recursive: true });
  fs.mkdirSync(path.join(mediaAbs, "audio"), { recursive: true });

  let copied = 0;
  let bytes = 0;
  for (const m of plan.media) {
    const srcAbs = assetPath(p, m.srcRel);
    const destAbs = path.join(mediaAbs, m.mediaRel);
    if (!fs.existsSync(srcAbs)) {
      emit(`Missing source, skipped: ${m.srcRel}`, "error");
      continue;
    }
    if (!fs.existsSync(destAbs) || fs.statSync(srcAbs).size !== fs.statSync(destAbs).size) {
      fs.copyFileSync(srcAbs, destAbs);
      copied++;
      bytes += fs.statSync(destAbs).size;
    } else {
      bytes += fs.statSync(destAbs).size;
    }
  }

  // Probe clip lengths for accurate EDL source-out and render padding.
  if (deps.probe && deps.ffmpegBin) {
    for (const ev of plan.events) {
      if (ev.kind === "clip") {
        const r = await deps.probe(deps.ffmpegBin, path.join(mediaAbs, ev.mediaRel!));
        ev.probedSec = r.durationSec ?? undefined;
        ev.hasAudio = r.hasAudio;
      }
    }
    if (plan.voiceover) plan.voiceover.probedSec = (await deps.probe(deps.ffmpegBin, path.join(mediaAbs, plan.voiceover.mediaRel))).durationSec ?? undefined;
    if (plan.music) plan.music.probedSec = (await deps.probe(deps.ffmpegBin, path.join(mediaAbs, plan.music.mediaRel))).durationSec ?? undefined;
  }

  const edlRel = `${asm.exportDir}/Assembly.edl`;
  const scriptRel = `${asm.exportDir}/Assembly.jsx`;
  const manifestRel = `${asm.exportDir}/MANIFEST.md`;
  fs.writeFileSync(assetPath(p, edlRel), buildEdl(plan, cfg.fps, p.meta.name), "utf8");
  fs.writeFileSync(assetPath(p, scriptRel), buildAeScript(plan, cfg, exportAbs), "utf8");
  fs.writeFileSync(
    assetPath(p, manifestRel),
    buildManifest(plan, cfg, {
      title: p.meta.name,
      builtAt: new Date().toISOString(),
      edlName: "Assembly.edl",
      jsxName: "Assembly.jsx",
      renderName: asm.renderPath ? "render.mp4" : undefined,
    }),
    "utf8"
  );

  p.assembly = {
    fps: cfg.fps,
    width: cfg.width,
    height: cfg.height,
    exportDir: asm.exportDir,
    assembledAt: new Date().toISOString(),
    renderPath: asm.renderPath,
    renderedAt: asm.renderedAt,
    totalSec: plan.totalSec,
    skippedShots: plan.blanks.length ? plan.blanks : undefined,
  };

  emit(
    `Assembly package built: ${plan.events.length} shots, ${plan.media.length} media files, runtime ${formatRuntime(plan.totalSec)}.`,
    "done"
  );
  if (plan.blanks.length) emit(`Blank slot(s) with no frame/clip: ${plan.blanks.join(", ")}.`, "info");

  return { plan, exportAbs, edlRel, scriptRel, manifestRel, copied, bytes };
}

// ---- renderAnimatic --------------------------------------------------------

export interface RenderDeps {
  bin: string;
  runFfmpeg: (bin: string, argv: string[], emit: AssemblyEmit) => Promise<void>;
  probe?: ProbeFn;
  tempDir?: string;
}

/** Render the assembled timeline to render.mp4 in the export folder via the
 *  3-pass pipeline (normalize → concat → mix). Returns the workspace-relative
 *  render path. `tempDir` lets tests route the temp segments off to a sandbox. */
export async function renderAnimatic(
  p: Production,
  cfgInput: Partial<Pick<ProductionAssembly, "fps" | "width" | "height">> | undefined,
  emit: AssemblyEmit,
  deps: RenderDeps
): Promise<string> {
  const cfg = assemblyConfig(p, cfgInput);
  const plan = assemblyPlan(p);
  if (!plan.events.length) throw new Error("Nothing to render — no shots have a frame or clip yet.");
  const asm = p.assembly ?? { fps: 24, width: 1920, height: 1080, exportDir: `${p.assets.outDir}/${p.assets.assemblyDir}` };
  const exportAbs = assetPath(p, asm.exportDir);
  const segDir = deps.tempDir ?? path.join(exportAbs, "_render");
  fs.mkdirSync(segDir, { recursive: true });
  try {
    if (deps.probe) {
      for (const ev of plan.events) {
        if (ev.kind === "clip") {
          const r = await deps.probe(deps.bin, assetPath(p, ev.srcRel!));
          ev.probedSec = r.durationSec ?? undefined;
          ev.hasAudio = r.hasAudio;
        }
      }
    }
    const segments: string[] = [];
    for (let i = 0; i < plan.events.length; i++) {
      const ev = plan.events[i];
      const outAbs = path.join(segDir, String(i + 1).padStart(4, "0") + ".mp4");
      await deps.runFfmpeg(deps.bin, buildNormalizeArgs(ev, cfg, ev.srcRel ? assetPath(p, ev.srcRel) : "", outAbs), emit);
      segments.push(outAbs);
      emit(`Rendered shot ${ev.number} (${i + 1}/${plan.events.length}).`);
    }
    const concatList = path.join(segDir, "concat.txt");
    fs.writeFileSync(concatList, buildConcatList(segments), "utf8");
    const preMix = path.join(segDir, "premix.mp4");
    await deps.runFfmpeg(deps.bin, buildConcatArgs(concatList, preMix), emit);
    const renderAbs = path.join(exportAbs, "render.mp4");
    await deps.runFfmpeg(
      deps.bin,
      buildMixArgs({
        renderAbs: preMix,
        voiceover: plan.voiceover ? { abs: assetPath(p, plan.voiceover.srcRel), volume: plan.voiceover.volume } : undefined,
        music: plan.music ? { abs: assetPath(p, plan.music.srcRel), volume: plan.music.volume } : undefined,
        totalSec: plan.totalSec,
        outAbs: renderAbs,
      }),
      emit
    );
    emit(`Render complete: ${plan.events.length} shots, ${formatRuntime(plan.totalSec)}.`, "done");
    return `${asm.exportDir}/render.mp4`;
  } finally {
    try {
      fs.rmSync(segDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}