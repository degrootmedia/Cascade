# Progress log

Append a few lines at the end of every session: completed, blocked, next.

## 2026-10-31 - harness-improvements
- Completed: H1 (stop gate, auto-format, lint), H2 (rules in CASCADE.md + tasks/batch-preamble.md), H3 (lessons split; guards in app/test/lessons-guards.test.ts).
- Blocked: nothing. Two lessons (magicPrompts single-writer, model capability classification) still have no automated check.
- Next: finish H4 (scoreboard), then H5 reviewer, then H6 UI verification kit.

## 2026-11-02 - graphite theme + icon sets (user request, outside batch-state)
- Completed: third theme "Graphite" (neutral #151517/#1b1b1c/#2c2c2e, white text) and switchable icon sets in Settings → Appearance: original set named "Colorful", new "Minimal" single-color outline set (25 glyphs in assets/icons/minimal/, CSS-mask tinted by --icon-tint: white on dark/graphite, #333 on Light XSI). iconSet persisted like theme (settings.json + localStorage boot cache + detached window). Tests: theme/theme-css/icons/settings-panel extended, all green; full app suite 2117 passed with only the 2 pre-existing lessons-guards failures (group node equality, magicDismissedRefs rebase) already red at session start; ui:verify clean + live probe of graphite/minimal/light tint and persistence.
- Blocked: nothing.
- Next: H5 fresh-eyes reviewer remains the open batch item.
