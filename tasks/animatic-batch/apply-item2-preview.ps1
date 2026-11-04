# Item 2 preview surgery on animatic.tsx (CRLF). Anchored range edits.
$ErrorActionPreference = "Stop"
$N = "`r`n"
function Edit-Once([string]$path, [string[]]$old, [string[]]$new, [string]$name) {
  $raw = [System.IO.File]::ReadAllText($path)
  $oldS = $old -join $N; $newS = $new -join $N
  $count = ([regex]::Matches($raw, [regex]::Escape($oldS))).Count
  if ($count -eq 0 -and $newS -and $raw.Contains($newS)) { Write-Output "SKIP (applied) $name"; return }
  if ($count -ne 1) { throw "$name matched $count (want 1)" }
  [System.IO.File]::WriteAllText($path, $raw.Replace($oldS, $newS))
  Write-Output "OK $name"
}
function Replace-Range([string]$path, [string]$startAnchor, [string]$endAnchor, [string[]]$insert, [string]$name) {
  $lines = [System.IO.File]::ReadAllLines($path)
  $si = @(); $ei = @()
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -eq $startAnchor) { $si += $i }
    if ($lines[$i] -eq $endAnchor) { $ei += $i }
  }
  if ($si.Count -eq 0 -and $insert.Count -gt 0 -and ($lines -join "`n").Contains($insert[0])) { Write-Output "SKIP (applied) $name"; return }
  if ($si.Count -ne 1 -or $ei.Count -ne 1 -or $ei[0] -le $si[0]) { throw "$name anchors: start=$($si.Count) end=$($ei.Count)" }
  $head = if ($si[0] -gt 0) { $lines[0..($si[0] - 1)] } else { @() }
  $tail = $lines[$ei[0]..($lines.Count - 1)]
  [System.IO.File]::WriteAllLines($path, (@($head) + @($insert) + @($tail)))
  Write-Output "OK $name (removed $($ei[0] - $si[0]) lines)"
}

$A = "app\src\renderer\src\components\production\animatic.tsx"

Edit-Once $A @('import { bedGainAt, type TimelineBeds, type TimelineOverride } from "./timeline-preview.js";') @('import type { TimelineOverride } from "./timeline-preview.js";') "import"

Replace-Range $A '/** Convert a data URL into an ArrayBuffer for AudioContext decoding. The VO' '/** Compact design-language preview player for the VO / Music import rows.' @() "decode helpers removed"

Replace-Range $A '/** Real-time playback preview + draggable cut points. The voiceover clip' 'export function TimelinePreview({' @(
  '/** Real-time playback preview (monitor + transport). Plays the',
  ' *  resolved timeline: picture items from the video pool, audio from',
  ' *  one hidden <audio> per audio-track clip, all synced to the shared',
  ' *  playhead owned by the Step 4 section. */',
  ''
) "header comment + bufferPeakAt removed"

Edit-Once $A @(
  '  prodId, timelineOverride, timelineBeds, voUrl, onVoDurationKnown, musicUrl, musicVolume, voiceoverVolume,'
) @(
  '  prodId, timelineOverride,'
) "props destructure"

Replace-Range $A '  /** Timeline beds with fades (Item 7): when present, bed gain at the' '  /** Shared playhead in seconds, owned by the Step 4 section so the' @() "props types"

Edit-Once $A @(
  '  /** Preview audio meter level 0..1 (Item 7), from decoded bed buffers. */',
  '  const [meterLevel, setMeterLevel] = useState(0);'
) @() "meter state"
Edit-Once $A @('  const canvasRef = useRef<HTMLCanvasElement>(null);') @() "canvas ref"

Replace-Range $A '  // Decode VO and music once into AudioBuffers (cached for playback + waveform).' '  /** Cumulative start time of each shot in seconds. */' @() "decode effects"

Replace-Range $A '  // Timeline playback uses hidden <audio> elements (more reliable codec support' '  const stop = useCallback(() => {' @(
  '  // Audio-track playback: one hidden <audio> per audio clip in the',
  '  // override, synced to the shared playhead like the video pool.',
  '  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());',
  '  const stopFlagRef = useRef(0);',
  '  const rafRef = useRef<number | null>(null);',
  '  const startedAtRef = useRef(0);',
  '  const startedHeadRef = useRef(0);',
  '  const audioItems = timelineOverride.audioItems;',
  '  const pauseAllAudio = useCallback(() => {',
  '    for (const el of audioElsRef.current.values()) { try { el.pause(); } catch {} }',
  '  }, []);',
  ''
) "hidden players -> audio pool refs"

Edit-Once $A @(
  '  const stop = useCallback(() => {',
  '    stopFlagRef.current++;',
  '    setMeterLevel(0);',
  '    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);',
  '    rafRef.current = null;',
  '    try { voAudioRef.current?.pause(); } catch {}',
  '    try { musicAudioRef.current?.pause(); } catch {}',
  '    setPlaying(false);',
  '  }, []);'
) @(
  '  const stop = useCallback(() => {',
  '    stopFlagRef.current++;',
  '    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);',
  '    rafRef.current = null;',
  '    pauseAllAudio();',
  '    setPlaying(false);',
  '  }, [pauseAllAudio]);'
) "stop()"

Edit-Once $A @(
  '  useEffect(() => {',
  '    if (playing) return;',
  '    stopFlagRef.current++;',
  '    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);',
  '    rafRef.current = null;',
  '    try { voAudioRef.current?.pause(); } catch {}',
  '    try { musicAudioRef.current?.pause(); } catch {}',
  '    setMeterLevel(0);',
  '  }, [playing]);'
) @(
  '  useEffect(() => {',
  '    if (playing) return;',
  '    stopFlagRef.current++;',
  '    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);',
  '    rafRef.current = null;',
  '    pauseAllAudio();',
  '  }, [playing, pauseAllAudio]);'
) "pause effect"

$newPlay = @(
  '  const play = useCallback(async () => {',
  '    if (playing) { stop(); return; }',
  '    const flag = ++stopFlagRef.current;',
  '    const head = playhead;',
  '    startedHeadRef.current = head;',
  '    startedAtRef.current = performance.now() / 1000;',
  '    // Start every audio clip active at the playhead (the per-frame',
  '    // sync effect keeps them aligned and starts later ones).',
  '    const toPlay: Promise<void>[] = [];',
  '    for (const item of audioItems) {',
  '      const el = audioElsRef.current.get(item.id);',
  '      if (!el) continue;',
  '      const local = head - item.startSec;',
  '      if (local < 0 || local >= item.durationSec) continue;',
  '      const rate = item.rateAt(local);',
  '      if (rate < 0) continue; // reversed audio previews silent (render is exact)',
  '      try { el.currentTime = item.sourceAt(local); } catch {}',
  '      try { el.playbackRate = Math.max(0.1, Math.min(4, rate || 1)); } catch {}',
  '      el.volume = animaticMuted || item.muted ? 0 : Math.max(0, Math.min(1, item.gainAt(local)));',
  '      toPlay.push(el.play().catch(() => {}));',
  '    }',
  '    await Promise.all(toPlay);',
  '    // Re-anchor the wall clock after play() settles (it may be async).',
  '    startedAtRef.current = performance.now() / 1000;',
  '    setPlaying(true);',
  '    const tick = () => {',
  '      if (flag !== stopFlagRef.current) return;',
  '      const h = startedHeadRef.current + (performance.now() / 1000 - startedAtRef.current);',
  '      if (h >= total) { stop(); setPlayhead(0); return; }',
  '      setPlayhead(h);',
  '      rafRef.current = requestAnimationFrame(tick);',
  '    };',
  '    rafRef.current = requestAnimationFrame(tick);',
  '  }, [playing, playhead, audioItems, animaticMuted, total, stop]);',
  ''
)
Replace-Range $A '  const play = useCallback(async () => {' '  useEffect(() => () => stop(), [stop]);' $newPlay "play() rewrite"

Edit-Once $A @(
  '  }, [playhead, playing, activeId, timelineOverride, overrideRate, activeVideoTime]);'
) @(
  '  }, [playhead, playing, activeId, timelineOverride, overrideRate, activeVideoTime]);',
  '',
  '  // Audio-track sync: each mounted <audio> follows the shared',
  '  // playhead - playing inside its window at the clip''s rate and gain,',
  '  // paused outside it; drift beyond 0.4s re-pins (ramps included).',
  '  useEffect(() => {',
  '    for (const item of audioItems) {',
  '      const el = audioElsRef.current.get(item.id);',
  '      if (!el) continue;',
  '      const local = playhead - item.startSec;',
  '      const inWindow = local >= 0 && local < item.durationSec;',
  '      const rate = inWindow ? item.rateAt(local) : 1;',
  '      if (!inWindow || !playing || rate < 0) {',
  '        if (!el.paused) { try { el.pause(); } catch {} }',
  '        continue;',
  '      }',
  '      el.volume = animaticMuted || item.muted ? 0 : Math.max(0, Math.min(1, item.gainAt(local)));',
  '      try { el.playbackRate = Math.max(0.1, Math.min(4, rate || 1)); } catch {}',
  '      try {',
  '        const want = item.sourceAt(local);',
  '        if (el.readyState >= 1 && Number.isFinite(el.duration) && el.duration > 0 && Math.abs(el.currentTime - want) > 0.4) {',
  '          el.currentTime = Math.min(Math.max(0, want), el.duration);',
  '        }',
  '      } catch {}',
  '      if (el.paused) void el.play().catch(() => {});',
  '    }',
  '  }, [playhead, playing, audioItems, animaticMuted]);'
) "audio sync effect"

Replace-Range $A '  // ---- Waveform ----------------------------------------------------------' '  // ---- Interactions -----------------------------------------------------' @() "waveform section"

Edit-Once $A @(
  '        <div className="prod-animatic-meter" title="Preview audio level (voiceover + music beds, post-fade)" aria-hidden="true">',
  '          <div className="prod-animatic-meter-fill" style={{ width: `${Math.round(meterLevel * 100)}%` }} />',
  '        </div>'
) @() "meter JSX"

$newPool = @(
  '      {/* Hidden audio-track players - one per audio clip, synced to',
  '          the shared playhead by the transport. */}',
  '      {audioItems.map((item) => (',
  '        <audio',
  '          key={item.id}',
  '          ref={(el) => {',
  '            if (el) audioElsRef.current.set(item.id, el);',
  '            else audioElsRef.current.delete(item.id);',
  '          }}',
  '          src={cascadeMedia(prodId, item.rel)}',
  '          preload="auto"',
  '          hidden',
  '        />',
  '      ))}'
)
Replace-Range $A '      {voUrl && (' '      <GenerationMenu' $newPool "wave row + hidden audios -> audio pool"

Write-Output "animatic.tsx preview surgery done"
