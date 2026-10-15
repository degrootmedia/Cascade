$ErrorActionPreference = "Stop"
$path = "test\graph-flow.test.ts"
$full = (Resolve-Path $path).Path
$text = [System.IO.File]::ReadAllText($full) -replace "`r`n", "`n"
function Replace-Once([string]$old, [string]$new, [string]$label) {
  $count = ([regex]::Matches($script:text, [regex]::Escape($old))).Count
  if ($count -ne 1) { throw "Expected exactly 1 match for $label, found $count" }
  $script:text = $script:text.Replace($old, $new)
  "OK: $label"
}
$oldRef = @'
    const ref = (id: string, source: string, target: string, targetHandle: string, selected = false): Edge => ({
      id, source, target, targetHandle, type: "waypoint", data: { waypoints: [] }, style: { stroke: COLORS.ref }, reconnectable: false, selected,
    });
'@
$newRef = @'
    const IMG = { stroke: "#3b82c4" };
    const OTHER = { stroke: "#8a8f98", strokeDasharray: "2 4" };
    const ref = (id: string, source: string, target: string, targetHandle: string, selected = false): Edge => ({
      id, source, target, targetHandle, type: "waypoint", data: { waypoints: [] }, style: IMG, reconnectable: false, selected,
    });
'@
Replace-Once $oldRef $newRef "ref builder media style"
$oldFixed = @'
    const fixed = (id: string, source: string, target: string, targetHandle: string, stroke?: string): Edge => ({
      id, source, target, targetHandle, type: "waypoint", data: { waypoints: [] },
      ...(stroke ? { style: { stroke } } : {}),
      deletable: false, reconnectable: false, selected: id === "e-style",
    });
'@
$newFixed = @'
    const fixed = (id: string, source: string, target: string, targetHandle: string, style?: Record<string, string>): Edge => ({
      id, source, target, targetHandle, type: "waypoint", data: { waypoints: [] },
      ...(style ? { style } : {}),
      deletable: false, reconnectable: false, selected: id === "e-style",
    });
'@
Replace-Once $oldFixed $newFixed "fixed builder style object"
$oldCalls = @'
      fixed("e-style", "style", "composer", "in-style", COLORS.style),
      fixed("e-style-vp", "style", "videoprompt", "in-style", COLORS.style),
      fixed("e-brand", "brand", "composer", "in-brand", COLORS.brand),
      fixed("e-cmp-img", "composer", "imagegen", "in-prompt"),
      fixed("e-vp-vid", "videoprompt", "videogen", "in-prompt"),
      fixed("e-ep-edit:edit0", "editprompt:edit0", "editgen:edit0", "in-prompt"),
      fixed("e-img-vid", "imagegen", "videogen", "in-image", COLORS.ref),
      fixed("e-img-edit:edit0", "imagegen", "editgen:edit0", "in-image", COLORS.ref),
      fixed("e-tween-0", "imagegen", "tween", "in-tween-0", COLORS.ref),
      fixed("e-img-out", "imagegen", "output", "in-out"),
'@
$newCalls = @'
      fixed("e-style", "style", "composer", "in-style", { stroke: COLORS.style }),
      fixed("e-style-vp", "style", "videoprompt", "in-style", { stroke: COLORS.style }),
      fixed("e-brand", "brand", "composer", "in-brand", { stroke: COLORS.brand }),
      fixed("e-cmp-img", "composer", "imagegen", "in-prompt", OTHER),
      fixed("e-vp-vid", "videoprompt", "videogen", "in-prompt", OTHER),
      fixed("e-ep-edit:edit0", "editprompt:edit0", "editgen:edit0", "in-prompt", OTHER),
      fixed("e-img-vid", "imagegen", "videogen", "in-image", IMG),
      fixed("e-img-edit:edit0", "imagegen", "editgen:edit0", "in-image", IMG),
      fixed("e-tween-0", "imagegen", "tween", "in-tween-0", IMG),
      fixed("e-img-out", "imagegen", "output", "in-out", IMG),
'@
Replace-Once $oldCalls $newCalls "golden edge styles"
[System.IO.File]::WriteAllText($full, ($text -replace "`n", "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
"ALL OK"
