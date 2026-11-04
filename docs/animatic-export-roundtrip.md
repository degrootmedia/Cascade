# Animatic export round-trip checklist (manual)

Purpose: verify each generated interchange file in its target editor
against the Cascade timeline model. Automated coverage lives in
`app/test/torture.test.ts` (golden exports + parsed timing asserts +
a gated golden render); this checklist covers what only the real
editors can prove. Work through it after exporter changes, using the
torture fixture production (`app/test/fixtures/torture-production.json`)
assembled from a real production folder with matching media, or any
real production that exercises the same features.

The torture timeline (13.117s @ 24fps): V1 = red (trimmed, 0–4s) →
1s centered dissolve → green 2× (4–6s, linked audio) → red/blue ramp
2×→0.5× (6–9.117s) → black/white reversed (9.117–13.117s). V2 =
yellow still (1–3s). A1 = VO with 2s fade-out + linked SFX. A2 =
muted track (should stay silent).

Regenerate golden exports after intentional exporter changes:

```
cd app
$env:TORTURE_WRITE="1"; npx vitest run test/torture.test.ts
$env:ASSEMBLY_E2E="1"; npx vitest run test/torture.test.ts test/timeline-render-ffmpeg.test.ts
```

## Final Cut Pro (Assembly.fcpxml)

- [ ] File > Import > XML imports with no errors; project duration
      reads 13.117s (315 frames @24) ±1 frame.
- [ ] Primary storyline order: red, green, ramp, reversed. Yellow
      still connected above at 1s; VO connected below.
- [ ] The 1s dissolve sits centered on the 4s cut (0.5s each side).
- [ ] Ramped clip: retime editor shows the speed curve descending
      from 200% to 50%; parking on its last frame shows BLUE (source
      frame at 6.0s of rb.mp4) — the ramp consumed the whole range.
- [ ] Green clip retimes at 200%; reversed clip plays white→black.
- [ ] VO level ≈ −1.9 dB with a 2s fade-out at the end; muted track
      clips arrive disabled/silent.
- [ ] Skim the FCPXML report (`Assembly-fcpxml-report.md`) — every
      line is an expected, stated difference; anything ELSE you spot
      is a bug to file.

## DaVinci Resolve (Assembly.fcpxml, then Assembly-V1.edl)

- [ ] Import Timeline > FCPXML: same clip order/durations as FCP
      above; note any retime conversion Resolve reports and compare
      against the export report (Resolve may convert timeMaps to its
      own retime curves — end frames must still match).
- [ ] Import `Assembly-V1.edl` as a preconformed timeline against
      the export media folder: 5 video events (ramp = 2 baked
      segments), dissolve on event 002, M2 speed on 002–005
      (048.0, 048.0, 043.0, −024.0). Ramp segments' source ranges are
      contiguous 00:00:00:00→00:00:06:00.
- [ ] Timeline end = 00:00:13:03 (315 frames).

## Premiere Pro (Assembly-premiere.xml)

- [ ] Import the XML: sequence has V1 (bottom: red/green/ramp/
      reversed), V2 (yellow still), A1 (VO + SFX). No offline media
      when the export folder travels with the project.
- [ ] Green clip speed = 200%; reversed clip speed = −100% and
      plays white→black.
- [ ] Ramp clip speed = its average (~192%) — EXPECTED
      simplification (see `Assembly-premiere-report.md`); its
      duration and out-point still land on the model's frames.
- [ ] Cross Dissolve (1s, centered) sits on the red→green cut.
- [ ] VO clip gain keyframes fade to silence over the last 2s.

## After Effects (Assembly.jsx)

- [ ] File > Scripts > Run Script File on `Assembly.jsx` (with the
      export `media/` folder beside it) builds the comp without
      script errors and saves `Assembly.aep`.
- [ ] The ramped layer has Time Remapping enabled with keyframes;
      the LAST keyframe's value equals the source-out time (6.0s for
      rb.mp4) and keys are easy-ease-able (select all → F9 works).
- [ ] The dissolve pair shows the incoming layer's opacity ramping
      0→100 across the 1s window.
- [ ] Constant-speed layers carry the stretch guidance comment at
      the top of the script output; applying the stated stretch
      lands the cut on the model frame.

## Render (render.mp4)

- [ ] Duration 13.12s ±1 frame; dissolve midpoint visibly blends
      red+green; ramp eases into the blue half; the muted track's
      880 Hz tone is absent throughout (solo-check by ear/meter).
- [ ] Cancel a render mid-way from the jobs panel: the job lands
      as **cancelled** (not failed) and no new `render.mp4` partial
      appears in the export folder.

## Reporting back

Any line that fails: note the editor + version, the exact frame/TC
observed vs expected, and whether the format's `*-report.md` already
states the difference. Unstated differences are exporter bugs.
