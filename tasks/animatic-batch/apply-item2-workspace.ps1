# Item 2 ProductionWorkspace surgery (CRLF). Anchored edits.
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

$W = "app\src\renderer\src\components\ProductionWorkspace.tsx"

Edit-Once $W @(
  'import { buildTimelineOverride, timelineBeds, timelineTotalSec, type TimelineBeds, type TimelineOverride } from "./production/timeline-preview.js";'
) @(
  'import { buildTimelineOverride, timelineTotalSec, type TimelineOverride } from "./production/timeline-preview.js";'
) "preview import"

$newSection = @(
  'function TimelineSection({',
  '  prodId, production, timelineOverride,',
  '  proxyBySrc, onTimelineChange, onGenerateProxies, onImportAudio, onSaveAsReference,',
  '}: {',
  '  prodId: string;',
  '  production: Production;',
  '  timelineOverride: TimelineOverride;',
  '  proxyBySrc: Readonly<Record<string, string>>;',
  '  onTimelineChange: (timeline: ProductionTimeline) => void;',
  '  onGenerateProxies: (srcRels?: string[]) => Promise<void>;',
  '  onImportAudio: () => Promise<{ rel: string; name: string; durationSec: number | null } | null>;',
  '  onSaveAsReference: (shotId: string, rel: string) => void;',
  '}) {',
  '  const [playheadSec, setPlayheadSec] = useState(0);',
  '  const [playing, setPlaying] = useState(false);',
  '  const seek = useCallback((sec: number) => {',
  '    setPlaying(false);',
  '    setPlayheadSec(sec);',
  '  }, []);',
  '  return (',
  '    <>',
  '      <TimelinePreview',
  '        prodId={prodId}',
  '        timelineOverride={timelineOverride}',
  '        playheadSec={playheadSec}',
  '        onPlayheadChange={setPlayheadSec}',
  '        playing={playing}',
  '        onPlayingChange={setPlaying}',
  '        onSaveAsReference={onSaveAsReference}',
  '      />',
  '      <TimelineEditor',
  '        prodId={prodId}',
  '        production={production}',
  '        onTimelineChange={onTimelineChange}',
  '        proxyBySrc={proxyBySrc}',
  '        onGenerateProxies={onGenerateProxies}',
  '        onImportAudio={onImportAudio}',
  '        playheadSec={playheadSec}',
  '        onSeek={seek}',
  '      />',
  '    </>',
  '  );',
  '}',
  ''
)
Replace-Range $W 'function TimelineSection({' 'export function ProductionWorkspace({ onOpenSettings, detached = null, onDetachedTitle }: {' $newSection "TimelineSection rewrite"

Edit-Once $W @(
  '  const [voUrl, setVoUrl] = useState<string | null>(null);',
  '  const [voDuration, setVoDuration] = useState<number | null>(null);',
  '  const [musicUrl, setMusicUrl] = useState<string | null>(null);',
  '  const [audioBust, setAudioBust] = useState(0);'
) @() "VO/music state"

Edit-Once $W @(
  '  const voPreviewRef = useRef<HTMLAudioElement | null>(null);',
  '  const musicPreviewRef = useRef<HTMLAudioElement | null>(null);'
) @() "preview refs"

Replace-Range $W '  // Step 4: fetch the imported music file as a streamable cascade-media:// URL' '  // Animatic proxies (Item 6): ready proxy per source, refreshed on' @() "VO/music URL effects"

Edit-Once $W @(
  '  const tlBeds = useMemo(',
  '    () => (prod && effectiveTimeline ? timelineBeds(effectiveTimeline, prod.media) : null),',
  '    [prod, effectiveTimeline]',
  '  );'
) @() "tlBeds memo"

Edit-Once $W @(
  '  // Step 4 owns timeline upkeep: persist the seed, follow regenerated',
  '  // shot media, and keep the VO/music beds in step when the imported',
  '  // files change (bed sync runs on path changes / first sight only, so',
  '  // deleting a bed clip in the editor stays deleted).',
  '  const bedPathsRef = useRef<{ id: string; vo?: string; mu?: string } | null>(null);',
  '  useEffect(() => {',
  '    if (!prod || prod.currentStep !== 4) return;',
  '    if (!prod.timeline) {',
  '      saveField({ timeline: seedTimelineFromProduction(prod, uid) });',
  '      return;',
  '    }',
  '    const prevPaths = bedPathsRef.current;',
  '    bedPathsRef.current = { id: prod.meta.id, vo: prod.voiceoverPath, mu: prod.musicPath };',
  '    let next = reconcileTimelineShotMedia(prod.timeline, prod);',
  '    const pathsChanged = !prevPaths || prevPaths.id !== prod.meta.id || prevPaths.vo !== prod.voiceoverPath || prevPaths.mu !== prod.musicPath;',
  '    if (pathsChanged) next = syncTimelineBeds(next, prod, uid);',
  '    if (next !== prod.timeline) saveField({ timeline: next });'
) @(
  '  // Step 4 owns timeline upkeep: persist the seed and follow',
  '  // regenerated shot media. (Legacy VO/music fields migrated to',
  '  // track clips at load in main; nothing syncs beds here anymore.)',
  '  useEffect(() => {',
  '    if (!prod || prod.currentStep !== 4) return;',
  '    if (!prod.timeline) {',
  '      saveField({ timeline: seedTimelineFromProduction(prod, uid) });',
  '      return;',
  '    }',
  '    const next = reconcileTimelineShotMedia(prod.timeline, prod);',
  '    if (next !== prod.timeline) saveField({ timeline: next });'
) "Step4 upkeep effect"

$newImport = @(
  '  /** Step 4: pick an audio file for the timeline (the editor''s',
  '   *  Import audio button). Main copies + probes; the editor places',
  '   *  the clip on an audio track. */',
  '  async function importTimelineAudioFile(): Promise<{ rel: string; name: string; durationSec: number | null } | null> {',
  '    if (!prod) return null;',
  '    setErr(null);',
  '    try {',
  '      return await window.cascade.importTimelineAudio(prod.meta.id);',
  '    } catch (e) {',
  '      setErr(String(e).replace(/^Error:\s*/, ""));',
  '      return null;',
  '    }',
  '  }',
  ''
)
Replace-Range $W '  /** Step 4: pick a local audio file to use as the voiceover. */' '  /** Re-render a shot''s composer prompt after a style-selection change.' $newImport "VO/music functions -> importTimelineAudioFile"

Replace-Range $W '                <div className="prod-animatic-panels">' '                <section className="prod-animatic">' @() "VO/Music panels"

Edit-Once $W @(
  '            <h3>4 · Animatic<HelpTip text={`Import one voiceover clip for the whole production, optionally add a music track, then edit the multi-track timeline under the preview. Shot timings from the earlier steps only seed the timeline — preview, render, and exports all read the timeline itself. The plan is written to ${prod.assets.outDir}/animatic.md.`} label="Animatic" /></h3>'
) @(
  '            <h3>4 · Animatic<HelpTip text={`Edit the multi-track timeline under the preview. All audio — voiceover, music, sound effects — lives as clips on audio tracks; use Import audio in the editor toolbar to add files. Shot timings from the earlier steps only seed the timeline — preview, render, and exports all read the timeline itself. The plan is written to ${prod.assets.outDir}/animatic.md.`} label="Animatic" /></h3>'
) "Animatic help text"

Edit-Once $W @(
  '                      beds={tlBeds}',
  '                      voUrl={tlBeds?.voiceover ? cascadeMedia(prod.meta.id, tlBeds.voiceover.rel) : null}',
  '                      musicUrl={tlBeds?.music ? cascadeMedia(prod.meta.id, tlBeds.music.rel) : null}',
  '                      voDuration={voDuration}',
  '                      onVoDurationKnown={setVoDuration}'
) @(
  '                      onImportAudio={importTimelineAudioFile}'
) "TimelineSection usage"

Write-Output "workspace surgery done"
