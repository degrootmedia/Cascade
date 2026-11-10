# OpenArt MCP models missing — fix spec (2026-11-10)

## Item 1 — root cause fix
OpenArt MCP showed "connected" in Settings but its models appeared in no
generation tool picker and not in the Model Customizer. Trace MCP
connection → discovery → registry/catalog → both UI surfaces; compare with
the working Higgsfield path; fix the root cause. No hardcoded model names —
server-reported discovery is the source of truth.

Root cause found (live-probed): the real `openart_model_list` reply exceeds
50,000 chars; `resultContentText` in `app/src/main/mcp.ts` sliced host-side
MCP result text at 50,000, cutting the JSON mid-document so parsing yielded
zero models everywhere. The Higgsfield CLI path never passes through that
join. Fix: raise the host-side cap far above any legitimate catalog
(model-facing `processContent` keeps its own cap).

## Item 2 — self-healing, impossible to miss
- Truthful status: connected-but-no-models must not read as plain
  "connected"; show "Connected — no models loaded" (amber dot) with Retry.
- Automatic recovery: re-run discovery on every (re)connect and after
  reconnect without app restart; transient failures retry with backoff.
- Keep last good list: failed/empty discovery keeps serving the previous
  good list, marked stale ("may be out of date").
- Manual "Refresh models" wherever connection status is shown.
- Regression tests: discovery failure, empty result, later success
  populating both surfaces; status labels.

## Item 3 — verify end to end
Models visible in tool pickers + Model Customizer with the server
connected (screenshots/test output, no paid generation). Break/restore:
disable → truthful status; reconnect → models back without restart.
