# Item 2 main-process edits (CRLF files). Each replacement must match once.
$ErrorActionPreference = "Stop"
$N = "`r`n"
function Edit-Once([string]$path, [string[]]$old, [string[]]$new, [string]$name) {
  $raw = [System.IO.File]::ReadAllText($path)
  $oldS = $old -join $N
  $newS = $new -join $N
  $count = ([regex]::Matches($raw, [regex]::Escape($oldS))).Count
  if ($count -eq 0 -and $newS -and $raw.Contains($newS)) { Write-Output "SKIP (applied) $name"; return }
  if ($count -ne 1) { throw "$name in $path matched $count times (want 1)" }
  [System.IO.File]::WriteAllText($path, $raw.Replace($oldS, $newS))
  Write-Output "OK $name"
}

$PROD = "app\src\main\productions.ts"

# imports: seed + bed sync for the migration
Edit-Once $PROD @(
  'import { sanitizeGenParams, normalizeShotSequences, normalizeTimeline, validateTimeline, isVideoEditFamilyMode, SEQUENCE_ACCENT_COLORS } from "../shared/ipc.js";'
) @(
  'import { sanitizeGenParams, normalizeShotSequences, normalizeTimeline, validateTimeline, isVideoEditFamilyMode, SEQUENCE_ACCENT_COLORS, seedTimelineFromProduction, syncTimelineBeds } from "../shared/ipc.js";'
) "productions imports"

# migration right after the timeline read-repair
Edit-Once $PROD @(
  '  if (p.timeline !== undefined) {',
  '    const repaired = normalizeTimeline(p.timeline);',
  '    if (repaired) p.timeline = repaired;',
  '    else delete (p as { timeline?: unknown }).timeline;',
  '  }'
) @(
  '  if (p.timeline !== undefined) {',
  '    const repaired = normalizeTimeline(p.timeline);',
  '    if (repaired) p.timeline = repaired;',
  '    else delete (p as { timeline?: unknown }).timeline;',
  '  }',
  '  // Legacy VO/music migration (audio lives on tracks): files imported',
  '  // through the old one-voiceover/one-music model become ordinary',
  '  // audio-track clips (seeded/synced beds), then the legacy fields',
  '  // clear so nothing reads them again. Runs once per production —',
  '  // afterwards the fields are absent. Bed clips keep their role so',
  '  // exports keep their VO/music reels.',
  '  if (p.voiceoverPath || p.musicPath) {',
  '    const tl0 = p.timeline ?? seedTimelineFromProduction(p, () => randomUUID());',
  '    const tl1 = syncTimelineBeds(tl0, p, () => randomUUID());',
  '    const repaired = normalizeTimeline(tl1);',
  '    if (repaired) p.timeline = repaired;',
  '    delete (p as { voiceoverPath?: unknown }).voiceoverPath;',
  '    delete (p as { musicPath?: unknown }).musicPath;',
  '    delete (p as { voiceoverVolume?: unknown }).voiceoverVolume;',
  '    delete (p as { musicVolume?: unknown }).musicVolume;',
  '  }'
) "VO/music migration"

# applyRendererState: stop copying legacy fields back in
Edit-Once $PROD @(
  '  if (typeof p.voiceoverPath === "string" || p.voiceoverPath === null) {',
  '    fresh.voiceoverPath = typeof p.voiceoverPath === "string" && p.voiceoverPath ? p.voiceoverPath : undefined;',
  '  }',
  '  if (typeof p.voiceoverVolume === "number" && Number.isFinite(p.voiceoverVolume)) {',
  '    fresh.voiceoverVolume = Math.max(0, Math.min(1, p.voiceoverVolume));',
  '  }',
  '  if (typeof p.musicPath === "string" || p.musicPath === null) {',
  '    fresh.musicPath = typeof p.musicPath === "string" && p.musicPath ? p.musicPath : undefined;',
  '  }',
  '  if (typeof p.musicVolume === "number" && Number.isFinite(p.musicVolume)) {',
  '    fresh.musicVolume = Math.max(0, Math.min(1, p.musicVolume));',
  '  }'
) @() "applyRendererState legacy copies removed"

Write-Output "productions.ts done"
