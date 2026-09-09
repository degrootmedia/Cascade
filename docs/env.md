# Environment flags

Single reference for every `CASCADE_*` / `ELECTRON_*` variable the code reads.
Each flag is read in exactly one place per package.

| Variable | Read in | Effect |
|---|---|---|
| `CASCADE_DEBUG_CHAT` | `core/src/chat.ts` | `=1` logs full chat payloads (redacted) via `logChatMetadata`; unset logs metadata only (roles, char counts, tool names). |
| `ELECTRON_RENDERER_URL` | `app/src/main/index.ts`, `app/src/main/ipc/handle.ts` | Dev-server origin: selects the dev CSP relaxation and the trusted IPC sender origin. Absent = packaged (`file://`). |

## Troubleshooting

- To inspect what the model actually sent, run with `CASCADE_DEBUG_CHAT=1`.
  Even then, key-like material (`sk-…`, `Bearer …`, long base64) is rendered as
  `[REDACTED]`. Never paste debug logs containing prompts into public issues —
  they include workspace file contents by design.
