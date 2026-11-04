# Item 2 IPC edits: replace legacy VO/music handlers with one timeline
# audio import. Range surgery with unique-anchor assertions (CRLF files).
$ErrorActionPreference = "Stop"

function Replace-Range([string]$path, [string]$startAnchor, [string]$endAnchor, [string[]]$insert, [string]$name) {
  $lines = [System.IO.File]::ReadAllLines($path)
  $si = @(); $ei = @()
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -eq $startAnchor) { $si += $i }
    if ($lines[$i] -eq $endAnchor) { $ei += $i }
  }
  if ($si.Count -eq 0 -and $insert.Count -gt 0) {
    $joined = $lines -join "`n"
    if ($joined.Contains($insert[0])) { Write-Output "SKIP (applied) $name"; return }
  }
  if ($si.Count -ne 1 -or $ei.Count -ne 1 -or $ei[0] -le $si[0]) {
    throw "$name anchors in $path : start=$($si.Count) end=$($ei.Count)"
  }
  $head = if ($si[0] -gt 0) { $lines[0..($si[0] - 1)] } else { @() }
  $tail = $lines[$ei[0]..($lines.Count - 1)]
  $out = @($head) + @($insert) + @($tail)
  [System.IO.File]::WriteAllLines($path, $out)
  Write-Output "OK $name (removed $($ei[0] - $si[0]) lines)"
}

$IDX = "app\src\main\index.ts"
$IPC = "app\src\shared\ipc.ts"

$newHandler = @(
  '  // Step 4: pick an audio file for the timeline. Copies it into the',
  '  // production''s audio/ folder and returns its relative path + probed',
  '  // duration; the renderer places it as an ordinary audio-track clip',
  '  // (all audio lives on tracks — no separate VO/music slots).',
  '  handle("production:importTimelineAudio", async (_e, id: string) => {',
  '    const p = productions.loadProduction(id);',
  '    if (!p) return null;',
  '    const res = await dialog.showOpenDialog(win!, {',
  '      title: "Choose an audio file",',
  '      properties: ["openFile"],',
  '      filters: [',
  '        { name: "Audio", extensions: ["mp3", "wav", "m4a", "aac", "ogg", "flac"] },',
  '        { name: "All files", extensions: ["*"] },',
  '      ],',
  '    });',
  '    if (res.canceled || !res.filePaths[0]) return null;',
  '    const src = res.filePaths[0];',
  '    const ext = (path.extname(src).slice(1).toLowerCase() || "mp3").replace("mpeg", "mp3");',
  '    if (!["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) {',
  '      throw new Error(`Unsupported audio format: .${ext}`);',
  '    }',
  '    const dir = "audio";',
  '    fs.mkdirSync(assetPath(p, dir), { recursive: true });',
  '    let rel = `${dir}/${path.basename(src)}`;',
  '    if (fs.existsSync(assetPath(p, rel))) {',
  '      const parsed = path.parse(path.basename(src));',
  '      let i = 2;',
  '      while (fs.existsSync(assetPath(p, `${dir}/${parsed.name} (${i})${parsed.ext}`))) i++;',
  '      rel = `${dir}/${parsed.name} (${i})${parsed.ext}`;',
  '    }',
  '    fs.copyFileSync(src, assetPath(p, rel));',
  '    const probed = await probeMedia(await resolveFfmpeg(), assetPath(p, rel)).catch(() => null);',
  '    productionEmit(id, `Imported audio -> ${rel}.`);',
  '    return { rel, name: path.basename(src), durationSec: probed?.durationSec ?? null };',
  '  });',
  ''
)

Replace-Range $IDX '  // Step 4: native voiceover picker. Copies the chosen file into' '  // Step 3 node graph: save a dropped video/audio file into the production''s' $newHandler "VO/music import handlers -> importTimelineAudio"

Replace-Range $IDX '  // Step 4: read the imported music file as a data URL (for the inline' '  // Step 5: gather all full-res frames + clips + audio into the export folder' @() "music file/url/remove handlers removed"

$newApi = @(
  '  /** Step 4: pick an audio file, copy it into the production''s audio/',
  '   *  folder, and return its path + probed duration for timeline placement. */',
  '  importTimelineAudio(productionId: string): Promise<{ rel: string; name: string; durationSec: number | null } | null>;',
  '  /**'
)
Replace-Range $IPC '  /** Step 4: open a native picker, copy the chosen audio file into voiceoverDir, and set voiceoverPath. */' '   * Step 3/4: generate a video clip for one shot, using its current frame' $newApi "CascadeApi VO/music -> importTimelineAudio"

Write-Output "IPC edits done"
